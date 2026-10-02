// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { LibString } from "solady/utils/LibString.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SepoliaDeployments } from "../deployments/SepoliaDeployments.sol";
import { TANIssuanceHistory } from "../src/issuance/TANIssuanceHistory.sol";
import { ISimplePlugin } from "../src/interfaces/ISimplePlugin.sol";
import { MockAmirX } from "../test/mocks/MockImplementations.sol";

/// @notice Stands up the TAN issuance rehearsal environment on Ethereum Sepolia.
///
/// @dev Sepolia carries a real V3 `StakingModule` and `SimplePlugin` with a history we own and can
/// settle freely, so it is where the V3 issuance path gets exercised end to end before any settlement
/// is proposed against the production Polygon stack. Two pieces are
/// deployed here: `TANIssuanceHistory` bound to the live plugin, and a `MockAmirX` standing in for
/// AmirX, which Sepolia has no deployment of and which the staker calculator needs as a fee sink.
///
/// The history is deployed from an EOA but owned by the Safe from the first block of its existence,
/// because `Ownable(owner_)` takes the owner as a constructor argument. There is no window in which
/// the deployer controls it, so the deploy itself does not need to go through the multisig.
/// Everything the owner can do afterwards is proposed through `script/safe/TANIssuanceSafeOps.s.sol`.
///
/// Usage:
///   FOUNDRY_PROFILE=cancun forge script script/DeployTANIssuanceHistorySepolia.s.sol \
///     --rpc-url $ETH_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvvv
contract DeployTANIssuanceHistorySepolia is Script {
    string constant DEPLOYMENTS_PATH = "/deployments/eth-sepolia.json";

    SepoliaDeployments deployments;

    ISimplePlugin plugin;
    IERC20 tel;
    address stakingModule;
    address owner;
    address feeSimulator;

    TANIssuanceHistory tanIssuanceHistory;
    MockAmirX mockAmirX;

    function setUp() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), DEPLOYMENTS_PATH));
        deployments = abi.decode(vm.parseJson(json), (SepoliaDeployments));

        plugin = ISimplePlugin(deployments.SimplePlugin);
        tel = IERC20(deployments.TelV3);
        stakingModule = deployments.StakingModule;
        owner = deployments.owner;
        feeSimulator = deployments.feeSimulator;
    }

    function run() public {
        // fail before broadcasting if the address book disagrees with what is actually onchain,
        // since a plugin bound to a different reward token would deploy a history that can never settle
        require(plugin.rewardToken() == address(tel), "plugin rewardToken != TelV3 in address book");
        require(!plugin.deactivated(), "plugin is deactivated");
        require(owner.code.length > 0, "owner is not a contract; expected the Safe");

        vm.startBroadcast();

        tanIssuanceHistory = new TANIssuanceHistory(plugin, owner);
        // the fee sink the staker calculator scans for. `defiSwap` is owner-gated and pulls the fee
        // from `defiAggIntermediary`, and rehearsal fee volume is generated one swap at a time, so
        // both roles go to the fee simulator EOA rather than through the Safe.
        mockAmirX = new MockAmirX(tel, feeSimulator, feeSimulator);

        vm.stopBroadcast();

        assert(tanIssuanceHistory.tel() == address(tel));
        assert(!tanIssuanceHistory.telIsNative());
        assert(tanIssuanceHistory.owner() == owner);
        assert(tanIssuanceHistory.tanIssuancePlugin() == plugin);
        assert(!tanIssuanceHistory.backfillSealed());
        assert(tanIssuanceHistory.lastSettlementBlock() == 0);
        assert(tanIssuanceHistory.clock() == block.number);
        assert(address(mockAmirX.tel()) == address(tel));
        assert(mockAmirX.owner() == feeSimulator);
        assert(mockAmirX.defiAggIntermediary() == feeSimulator);

        // A dry run's addresses exist only in the simulation, and the backend reads this file as its
        // Sepolia address book, so recording them would point every subsequent run at contracts that
        // were never deployed. Only a real broadcast updates the book.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory dest = string.concat(vm.projectRoot(), DEPLOYMENTS_PATH);
            vm.writeJson(_toHex(address(tanIssuanceHistory)), dest, ".TANIssuanceHistory");
            vm.writeJson(_toHex(address(mockAmirX)), dest, ".MockAmirX");
        } else {
            console2.log("Dry run: %s left unchanged", DEPLOYMENTS_PATH);
        }

        console2.log("TANIssuanceHistory:", address(tanIssuanceHistory));
        console2.log("MockAmirX:         ", address(mockAmirX));
        console2.log("StakingModule:     ", stakingModule);
        console2.log("owner (Safe):      ", owner);
        console2.log("");
        console2.log("Settlement stays blocked until the plugin's increaser points at the new history.");
        console2.log("Propose that from the Safe %s with:", deployments.pluginOwner);
        console2.log("  forge script script/safe/TANIssuanceSafeOps.s.sol --sig 'setIncreaser()'");
    }

    function _toHex(address addr) internal pure returns (string memory) {
        return LibString.toHexString(uint256(uint160(addr)), 20);
    }
}
