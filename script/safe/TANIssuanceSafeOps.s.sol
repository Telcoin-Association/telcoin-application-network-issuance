// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { console2 } from "forge-std/console2.sol";
import { SafeScriptBase } from "@safe-utils/SafeScriptBase.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SepoliaDeployments } from "../../deployments/SepoliaDeployments.sol";
import { TANIssuanceHistory } from "../../src/issuance/TANIssuanceHistory.sol";
import { ISimplePlugin } from "../../src/interfaces/ISimplePlugin.sol";
import { SafeChunkReader } from "./SafeChunkReader.sol";

/// @dev `setIncreaser` lives on the concrete `SimplePlugin` rather than on the interface
/// `TANIssuanceHistory` consumes, so it is declared here rather than widening that interface.
interface ISimplePluginAdmin {
    function setIncreaser(address newIncreaser) external;
    function increaser() external view returns (address);
    function owner() external view returns (address);
}

/**
 * @notice Proposes every owner-gated TAN issuance action to the multisig that owns the contracts.
 *
 * @dev `TANIssuanceHistory` gates settlement, backfill, and seal behind `onlyOwner`, and the
 * `SimplePlugin` gates `setIncreaser` behind its own owner. On a Safe-owned deployment none of those
 * can be sent directly, so each one is either simulated against a fork or signed and posted to the
 * Safe Transaction Service, depending on whether `--broadcast` is present.
 *
 * Simulation needs no hardware wallet, which is what makes it the way to check a batch before asking
 * signers to look at it:
 *
 *   FOUNDRY_PROFILE=sepolia forge script script/safe/TANIssuanceSafeOps.s.sol \
 *     --sig "<entrypoint>" --rpc-url $ETH_SEPOLIA_RPC_URL --ffi -vvvv
 *
 * Adding `--broadcast` signs with the configured hardware wallet and proposes instead. Note that a
 * proposal carrying large calldata can exceed the Windows command-line length limit through the FFI
 * bridge, so proposing is done from macOS or Linux; simulation is unaffected.
 *
 * Required environment: `DEPLOYER_SAFE_ADDRESS`, `SIGNER_ADDRESS_0` (and `_1`, `_2`, ... for more
 * signers), `DERIVATION_PATH`, and `HARDWARE_WALLET`.
 */
contract TANIssuanceSafeOps is SafeScriptBase {
    using SafeChunkReader for TANIssuanceHistory.IssuanceReward[];
    using SafeChunkReader for uint256[];

    uint256 constant ETH_SEPOLIA_CHAIN_ID = 11_155_111;

    TANIssuanceHistory history;
    ISimplePlugin plugin;
    ISimplePluginAdmin pluginAdmin;
    IERC20 tel;
    address pluginOwner;

    function setUp() public {
        _loadDeployments();
        _initializeSafeMultiSig();
    }

    /**
     * Wiring
     */

    /// @notice Points the plugin's `increaser` at the deployed history, which is what unblocks
    /// settlement after a fresh deploy.
    function setIncreaser() public {
        require(pluginAdmin.owner() == getSafeAddress(), "plugin owner is not the configured Safe");

        address current = pluginAdmin.increaser();
        if (current == address(history)) {
            console2.log("increaser already points at %s, nothing to propose", current);
            return;
        }
        console2.log("increaser %s -> %s", current, address(history));

        _proposeTransaction(
            address(plugin),
            abi.encodeCall(ISimplePluginAdmin.setIncreaser, (address(history))),
            "SimplePlugin.setIncreaser"
        );
    }

    /**
     * Backfill
     */

    /// @notice Proposes one backfill chunk emitted by `backend/buildBackfill.ts`.
    ///
    /// @dev Chunks are order independent and safe to re-propose: the contract skips any account that
    /// already carries history. `atBlock` must be the same cutover block for every chunk, because all
    /// entries are keyed at it and it becomes the new `lastSettlementBlock`.
    ///
    /// @param chunkFile Path under `backend/temp`, e.g. `safe_param_backfill_chunk_0.json`
    /// @param atBlock Cutover block the seeded checkpoints are keyed at
    function backfillChunk(string memory chunkFile, uint256 atBlock) public {
        _requireSafeOwnsHistory();
        require(!history.backfillSealed(), "backfill is already sealed");

        (address[] memory accounts, uint256[] memory amounts) = SafeChunkReader.readColumns(_chunkPath(chunkFile));

        console2.log("chunk %s: %d accounts totalling %d", chunkFile, accounts.length, amounts.totalOf());

        _proposeTransaction(
            address(history),
            abi.encodeCall(TANIssuanceHistory.backfillCumulativeRewards, (accounts, amounts, atBlock)),
            string.concat("TANIssuanceHistory.backfillCumulativeRewards[", chunkFile, "]")
        );
    }

    /// @notice Closes the backfill path for good, once every chunk has landed and reconciled.
    function sealBackfill() public {
        _requireSafeOwnsHistory();

        if (history.backfillSealed()) {
            console2.log("backfill already sealed, nothing to propose");
            return;
        }

        _proposeTransaction(
            address(history), abi.encodeCall(TANIssuanceHistory.sealBackfill, ()), "TANIssuanceHistory.sealBackfill"
        );
    }

    /**
     * Settlement
     */

    /// @notice Proposes one settlement chunk emitted by `backend/safeTxArrayBuilder.ts`, funding the
    /// history for exactly that chunk in the same Safe transaction.
    ///
    /// @dev Settlement pulls the reward token from the history, so the history has to be holding the
    /// chunk total when the call lands. Batching the transfer with the settlement through MultiSend
    /// makes that atomic: either both happen or neither does, and no TEL is ever parked on the
    /// history between two separately-executed proposals.
    ///
    /// Several chunks may carry the same `endBlock`, which is how one period is split across
    /// transactions.
    ///
    /// @param chunkFile Path under `backend/temp`, e.g. `safe_param_period_43_tan_chunk_0.json`
    /// @param endBlock Last block of the period being settled
    function settleChunk(string memory chunkFile, uint256 endBlock) public {
        _requireSafeOwnsHistory();
        require(endBlock >= history.lastSettlementBlock(), "endBlock precedes lastSettlementBlock");
        require(endBlock <= block.number, "endBlock is in the future");

        TANIssuanceHistory.IssuanceReward[] memory rewards = SafeChunkReader.readRewards(_chunkPath(chunkFile));

        uint256 total = rewards.totalOf();
        require(total != 0, "chunk settles nothing; use settleGap to advance the block instead");

        uint256 held = tel.balanceOf(address(history));
        uint256 shortfall = total > held ? total - held : 0;
        console2.log("chunk %s: %d recipients totalling %d", chunkFile, rewards.length, total);
        console2.log("history holds %d, funding %d from the Safe", held, shortfall);
        require(tel.balanceOf(getSafeAddress()) >= shortfall, "Safe holds too little TEL to fund this chunk");

        address[] memory targets = new address[](shortfall == 0 ? 1 : 2);
        bytes[] memory datas = new bytes[](targets.length);
        uint256 next;
        if (shortfall != 0) {
            targets[next] = address(tel);
            datas[next] = abi.encodeCall(IERC20.transfer, (address(history), shortfall));
            ++next;
        }
        targets[next] = address(history);
        datas[next] = abi.encodeCall(TANIssuanceHistory.increaseClaimableByBatch, (rewards, endBlock));

        _proposeTransactions(targets, datas, string.concat("fund + settle[", chunkFile, "]"));
    }

    /// @notice Advances `lastSettlementBlock` across a period that pays nobody, without moving TEL.
    ///
    /// @dev An empty batch skips the plugin entirely, which is the only way to close a settlement gap:
    /// the plugin itself reverts on a zero-length batch.
    function settleGap(uint256 endBlock) public {
        _requireSafeOwnsHistory();
        require(endBlock >= history.lastSettlementBlock(), "endBlock precedes lastSettlementBlock");
        require(endBlock <= block.number, "endBlock is in the future");

        _proposeTransaction(
            address(history),
            abi.encodeCall(
                TANIssuanceHistory.increaseClaimableByBatch, (new TANIssuanceHistory.IssuanceReward[](0), endBlock)
            ),
            "TANIssuanceHistory.increaseClaimableByBatch[empty]"
        );
    }

    /**
     * Pre-flight
     */

    /// @notice Reports the wiring every other entrypoint depends on, proposing nothing.
    function verify() public view {
        console2.log("Safe               :", getSafeAddress());
        console2.log("TANIssuanceHistory :", address(history));
        console2.log("  owner            :", history.owner());
        console2.log("  tel              :", history.tel());
        console2.log("  telIsNative      :", history.telIsNative());
        console2.log("  lastSettlement   :", history.lastSettlementBlock());
        console2.log("  backfillSealed   :", history.backfillSealed());
        console2.log("  TEL balance      :", tel.balanceOf(address(history)));
        console2.log("SimplePlugin       :", address(plugin));
        console2.log("  owner            :", pluginAdmin.owner());
        console2.log("  increaser        :", pluginAdmin.increaser());
        console2.log("  rewardToken      :", plugin.rewardToken());
        console2.log("  deactivated      :", plugin.deactivated());
        console2.log("  totalClaimable   :", plugin.totalClaimable());
        console2.log("Safe TEL balance   :", tel.balanceOf(getSafeAddress()));

        if (history.owner() != getSafeAddress()) {
            console2.log("WARNING: the Safe does not own the history; owner actions cannot be proposed");
        }
        if (pluginAdmin.increaser() != address(history)) {
            console2.log("WARNING: plugin increaser is not the history; settlement will revert");
        }
    }

    /**
     * Internals
     */

    function _loadDeployments() internal {
        require(block.chainid == ETH_SEPOLIA_CHAIN_ID, "no address book for this chain; add a branch here");

        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/eth-sepolia.json"));
        SepoliaDeployments memory deployments = abi.decode(vm.parseJson(json), (SepoliaDeployments));

        require(deployments.TANIssuanceHistory != address(0), "TANIssuanceHistory is not deployed yet");

        history = TANIssuanceHistory(payable(deployments.TANIssuanceHistory));
        plugin = ISimplePlugin(deployments.SimplePlugin);
        pluginAdmin = ISimplePluginAdmin(deployments.SimplePlugin);
        tel = IERC20(deployments.TelV3);
        pluginOwner = deployments.pluginOwner;
    }

    function _requireSafeOwnsHistory() internal view {
        require(history.owner() == getSafeAddress(), "history owner is not the configured Safe");
    }

    /// @dev Chunk files land in `backend/temp`, where both emitters write them.
    function _chunkPath(string memory chunkFile) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/backend/temp/", chunkFile);
    }
}
