// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { Test, console2 } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { PolygonDeployments } from "../deployments/PolygonDeployments.sol";
import { TANIssuanceHistory } from "../src/issuance/TANIssuanceHistory.sol";
import { ISimplePlugin } from "../src/interfaces/ISimplePlugin.sol";

/// @dev The parts of the live V3 `SimplePlugin_TAN` beyond what `TANIssuanceHistory` itself calls.
interface IPolygonPluginAdmin {
    function setIncreaser(address newIncreaser) external;
    function increaser() external view returns (address);
    function owner() external view returns (address);
    function staking() external view returns (address);
    function claimable(address account, bytes calldata auxData) external view returns (uint256);
}

/**
 * @notice Exercises `TANIssuanceHistory` against the live V3 stack on Polygon, the production target.
 *
 * @dev Deploys a fresh history against `SimplePlugin_TAN` from `deployments/polygon.json`, takes the
 * plugin's `increaser` slot from its owner Safe the way the cutover does, then drives a production-size
 * backfill and settlement through the real plugin. Gas is asserted against Polygon's 32M per-transaction
 * cap, since that bound is what fixes the chunk sizes the backend emits.
 *
 * The live V3 bytecode carries Cancun opcodes, so this suite only runs under the `cancun` profile:
 *   FOUNDRY_PROFILE=cancun forge test --match-path test/TANIssuanceHistoryPolygonV3ForkTest.t.sol -vv
 */
contract TANIssuanceHistoryPolygonV3ForkTest is Test {
    string POLYGON_RPC_URL = vm.envOr("POLYGON_RPC_URL", string(""));

    /// @dev Polygon's per-transaction gas cap
    uint256 constant POLYGON_TX_GAS_CAP = 32_000_000;
    /// @dev Chunk sizes `buildBackfill.ts` and `safeTxArrayBuilder.ts` emit
    uint256 constant BACKFILL_CHUNK = 300;
    uint256 constant SETTLE_CHUNK = 200;
    /// @dev Margin left under the cap for the Safe's `execTransaction`, MultiSend, and calldata
    uint256 constant SAFE_OVERHEAD = 1_000_000;

    PolygonDeployments deployments;

    ISimplePlugin plugin;
    IPolygonPluginAdmin pluginAdmin;
    IERC20 tel;

    TANIssuanceHistory history;
    address tanSafe;

    function setUp() public {
        vm.skip(!_isCancunProfile());

        vm.createSelectFork(POLYGON_RPC_URL);

        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/polygon.json"));
        deployments = abi.decode(vm.parseJson(json), (PolygonDeployments));

        plugin = ISimplePlugin(deployments.SimplePlugin);
        pluginAdmin = IPolygonPluginAdmin(deployments.SimplePlugin);
        tel = IERC20(deployments.TelV3);
        tanSafe = deployments.TANSafe;

        history = new TANIssuanceHistory(plugin, tanSafe);

        // settlement is increaser-gated on the plugin, and the plugin owner is a different Safe from the
        // history owner, which is exactly the split the cutover has to bridge
        vm.prank(deployments.pluginOwner);
        pluginAdmin.setIncreaser(address(history));
    }

    /**
     * Wiring
     */

    function testForkAddressBookMatchesChain() public view {
        assertEq(pluginAdmin.owner(), deployments.pluginOwner);
        assertEq(pluginAdmin.staking(), deployments.StakingModule);
        assertEq(plugin.rewardToken(), deployments.TelV3);
        assertFalse(plugin.deactivated());
        assertTrue(deployments.pluginOwner != tanSafe);
    }

    function testForkConstructorBindsToLivePlugin() public view {
        assertEq(history.tel(), address(tel));
        assertFalse(history.telIsNative());
        assertEq(address(history.tanIssuancePlugin()), address(plugin));
        assertEq(pluginAdmin.increaser(), address(history));
    }

    /**
     * Production-size chunks
     */

    /// @dev A full backfill chunk of new accounts, the shape `buildBackfill.ts` emits.
    function testForkFullBackfillChunkFitsInABlock() public {
        (address[] memory accounts, uint256[] memory amounts) = _accounts(BACKFILL_CHUNK, 1);

        vm.prank(tanSafe);
        uint256 gasBefore = gasleft();
        history.backfillCumulativeRewards(accounts, amounts, block.number);
        uint256 gasUsed = gasBefore - gasleft();

        console2.log("backfill chunk of %d: %d gas", BACKFILL_CHUNK, gasUsed);
        assertLt(gasUsed + SAFE_OVERHEAD, POLYGON_TX_GAS_CAP);
        assertEq(history.cumulativeRewards(accounts[BACKFILL_CHUNK - 1]), amounts[BACKFILL_CHUNK - 1]);
    }

    /// @dev The worst case for a settlement chunk: every recipient is new to both the history and the
    /// plugin, so every row writes fresh storage on both ledgers.
    function testForkFullSettlementChunkOfNewRecipientsFitsInABlock() public {
        (address[] memory accounts, uint256[] memory amounts) = _accounts(SETTLE_CHUNK, 1);
        TANIssuanceHistory.IssuanceReward[] memory rewards = _rewards(accounts, amounts);
        uint256 total = _sum(amounts);

        deal(address(tel), address(history), total);
        uint256 pluginBalanceBefore = tel.balanceOf(address(plugin));
        uint256 totalClaimableBefore = plugin.totalClaimable();

        vm.prank(tanSafe);
        uint256 gasBefore = gasleft();
        history.increaseClaimableByBatch(rewards, block.number);
        uint256 gasUsed = gasBefore - gasleft();

        console2.log("settlement chunk of %d new recipients: %d gas", SETTLE_CHUNK, gasUsed);
        assertLt(gasUsed + SAFE_OVERHEAD, POLYGON_TX_GAS_CAP);

        assertEq(tel.balanceOf(address(history)), 0);
        assertEq(tel.allowance(address(history), address(plugin)), 0);
        assertEq(tel.balanceOf(address(plugin)) - pluginBalanceBefore, total);
        assertEq(plugin.totalClaimable() - totalClaimableBefore, total);
        assertEq(pluginAdmin.claimable(accounts[0], ""), amounts[0]);
        assertTrue(history.backfillSealed());
    }

    /**
     * Cutover sequence
     */

    /// @dev Backfill, then settle the first V3 period one block past the backfill key, as the cutover
    /// runbook does. Carried-over history and the new credit accumulate onto one checkpoint series, and
    /// a read one block before the first credit still sees the seed.
    function testForkBackfillThenFirstPeriod() public {
        (address[] memory accounts, uint256[] memory seeds) = _accounts(3, 100);
        uint256 atBlock = block.number;

        vm.prank(tanSafe);
        history.backfillCumulativeRewards(accounts, seeds, atBlock);

        // a credit keyed at the backfill block would hide the seed, so it is refused against the live plugin too
        uint256[] memory credits = new uint256[](3);
        (credits[0], credits[1], credits[2]) = (5e18, 0, 7e18);
        TANIssuanceHistory.IssuanceReward[] memory rewards = _rewards(accounts, credits);
        deal(address(tel), address(history), 12e18);

        vm.prank(tanSafe);
        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.InvalidBlock.selector, atBlock));
        history.increaseClaimableByBatch(rewards, atBlock);

        vm.roll(atBlock + 1);
        vm.prank(tanSafe);
        history.increaseClaimableByBatch(rewards, atBlock + 1);

        assertEq(history.cumulativeRewardsAtBlock(accounts[0], atBlock), seeds[0]);
        assertEq(history.cumulativeRewardsAtBlock(accounts[0], atBlock + 1), seeds[0] + 5e18);
        // a zero row carries no history and is not credited
        assertEq(history.cumulativeRewards(accounts[1]), seeds[1]);
        assertEq(pluginAdmin.claimable(accounts[1], ""), 0);
        assertEq(pluginAdmin.claimable(accounts[2], ""), 7e18);
        assertTrue(history.backfillSealed());
    }

    /**
     * Helpers
     */

    /// @dev Fresh, distinct accounts with no history on either ledger, and amounts scaled by `scale` TEL
    function _accounts(
        uint256 count,
        uint256 scale
    )
        internal
        pure
        returns (address[] memory accounts, uint256[] memory amounts)
    {
        accounts = new address[](count);
        amounts = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            accounts[i] = address(uint160(uint256(keccak256(abi.encode("tan-v3-fork", i)))));
            amounts[i] = (i + 1) * scale * 1e18;
        }
    }

    function _rewards(
        address[] memory accounts,
        uint256[] memory amounts
    )
        internal
        pure
        returns (TANIssuanceHistory.IssuanceReward[] memory rewards)
    {
        rewards = new TANIssuanceHistory.IssuanceReward[](accounts.length);
        for (uint256 i; i < accounts.length; ++i) {
            rewards[i] = TANIssuanceHistory.IssuanceReward({ account: accounts[i], amount: amounts[i] });
        }
    }

    function _sum(uint256[] memory amounts) internal pure returns (uint256 total) {
        for (uint256 i; i < amounts.length; ++i) {
            total += amounts[i];
        }
    }

    function _isCancunProfile() internal view returns (bool) {
        return keccak256(bytes(vm.envOr("FOUNDRY_PROFILE", string("")))) == keccak256("cancun");
    }
}
