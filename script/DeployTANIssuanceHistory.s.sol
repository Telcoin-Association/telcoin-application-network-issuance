// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { LibString } from "solady/utils/LibString.sol";
import { PolygonDeployments } from "../deployments/PolygonDeployments.sol";
import { TANIssuanceHistory } from "../src/issuance/TANIssuanceHistory.sol";
import { ISimplePlugin } from "../src/interfaces/ISimplePlugin.sol";

/// @notice Deploys the V3 `TANIssuanceHistory` on Polygon against `SimplePlugin_TAN`, owned by the TAN Safe.
///
/// @dev Reads and writes `deployments/polygon.json`. The predecessor book `deployments/deployments.json`
/// is left untouched, because `backend/buildBackfill.ts` reads it as the backfill source.
///
/// The history is deployed from an EOA but owned by the TAN Safe from the first block of its existence,
/// because `Ownable(owner_)` takes the owner as a constructor argument. Wiring it in as the plugin's
/// increaser is a separate proposal from the plugin owner Safe; see `docs/TAN_V3_CUTOVER.md`.
///
/// Usage:
///   FOUNDRY_PROFILE=cancun forge script script/DeployTANIssuanceHistory.s.sol \
///     --rpc-url $POLYGON_RPC_URL --private-key $PRIVATE_KEY --broadcast --verify -vvvv
contract DeployTANIssuanceHistory is Script {
    string constant DEPLOYMENTS_PATH = "/deployments/polygon.json";
    uint256 constant POLYGON_CHAIN_ID = 137;

    PolygonDeployments deployments;

    ISimplePlugin tanIssuancePlugin;
    address tel;
    address owner;
    bytes32 tanIssuanceHistorySalt;

    TANIssuanceHistory tanIssuanceHistory;

    function setUp() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), DEPLOYMENTS_PATH));
        deployments = abi.decode(vm.parseJson(json), (PolygonDeployments));

        tanIssuancePlugin = ISimplePlugin(deployments.SimplePlugin);
        tel = deployments.TelV3;
        // TAN Safe; calls `TANIssuanceHistory::increaseClaimableByBatch()`
        owner = deployments.TANSafe;
        tanIssuanceHistorySalt = bytes32(abi.encode("TANIssuanceHistory"));
    }

    function run() public {
        // fail before broadcasting if the address book disagrees with what is actually onchain, since a
        // plugin bound to a different reward token would deploy a history that can never settle
        require(block.chainid == POLYGON_CHAIN_ID, "polygon.json describes chain 137");
        require(deployments.TANIssuanceHistory == address(0), "polygon.json already records a TANIssuanceHistory");
        require(tanIssuancePlugin.rewardToken() == tel, "plugin rewardToken != TelV3 in address book");
        require(!tanIssuancePlugin.deactivated(), "plugin is deactivated");
        require(owner.code.length > 0, "owner is not a contract; expected the TAN Safe");

        vm.startBroadcast();

        tanIssuanceHistory = new TANIssuanceHistory{ salt: tanIssuanceHistorySalt }(tanIssuancePlugin, owner);

        vm.stopBroadcast();

        assert(tanIssuanceHistory.tel() == tel);
        assert(!tanIssuanceHistory.telIsNative());
        assert(tanIssuanceHistory.owner() == owner);
        assert(tanIssuanceHistory.tanIssuancePlugin() == tanIssuancePlugin);
        assert(!tanIssuanceHistory.backfillSealed());
        assert(tanIssuanceHistory.lastSettlementBlock() == 0);
        assert(tanIssuanceHistory.clock() == block.number);

        // A dry run's address exists only in the simulation, and the backend reads this file as its
        // Polygon address book, so recording it would point every subsequent run at a contract that was
        // never deployed. Only a real broadcast updates the book.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            vm.writeJson(
                LibString.toHexString(uint256(uint160(address(tanIssuanceHistory))), 20),
                string.concat(vm.projectRoot(), DEPLOYMENTS_PATH),
                ".TANIssuanceHistory"
            );
        } else {
            console2.log("Dry run: %s left unchanged", DEPLOYMENTS_PATH);
        }

        console2.log("TANIssuanceHistory:", address(tanIssuanceHistory));
        console2.log("owner (TAN Safe):  ", owner);
        console2.log("");
        console2.log("Settlement stays blocked until the plugin's increaser points at the new history.");
        console2.log("Propose that from the plugin owner Safe %s with:", deployments.pluginOwner);
        console2.log("  forge script script/safe/TANIssuanceSafeOps.s.sol --sig 'setIncreaser()'");
    }
}
