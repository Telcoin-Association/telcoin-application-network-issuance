// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/issuance/TANIssuanceHistory.sol";
import "../src/interfaces/ISimplePlugin.sol";
import "./mocks/MockImplementations.sol";

contract TANIssuanceHistoryTest is Test {
    MockTel tel;
    MockStakingModule public stakingModule;
    ISimplePlugin public mockPlugin;
    MockAmirX public amirX;

    TANIssuanceHistory public tanIssuanceHistory;

    // Addresses for testing
    address public owner = address(0x123);
    address public user = address(0x456);
    address public user1 = address(0x789);
    address public user2 = address(0xabc);
    address public defiAgg = address(0xdef);
    address public executor = address(0xfed);
    address public referrer = address(0xcba);

    function setUp() public {
        // Deploy TEL and mocks
        tel = new MockTel("Telcoin", "TEL");
        stakingModule = new MockStakingModule();
        mockPlugin = ISimplePlugin(address(new MockPlugin(IERC20(address(tel)))));
        // the mock amirX is owned by the executor address for simplicity
        amirX = new MockAmirX(IERC20(address(tel)), executor, defiAgg);

        // (unprotected) mint tokens to `defiAgg` and give unlimited approval to `amirX`
        tel.mint(defiAgg, 1_000_000);
        vm.prank(defiAgg);
        tel.approve(address(amirX), 1_000_000);

        // Deploy the TANIssuanceHistory contract as owner
        tanIssuanceHistory = new TANIssuanceHistory(mockPlugin, owner);

        // settlement funds are transferred to this contract before each batch and pulled by the plugin
        tel.mint(address(tanIssuanceHistory), 1e30);
    }

    /// @dev Settles batches of fuzzed size against the mock plugin and checks every account's history
    function testFuzz_increaseClaimableByBatch(uint16 numUsers) public {
        // settlement is proposed in 300-recipient chunks, and a batch far beyond a few thousand would not
        // fit in a block, so the bound covers several times the production chunk without exhausting the
        // test gas limit
        numUsers = uint16(bound(numUsers, 0, 3000));

        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](numUsers);
        for (uint256 i; i < numUsers; ++i) {
            rewards[i].account = address(uint160(uint256(numUsers) + i));
            rewards[i].amount = uint256(numUsers) + i;
        }

        vm.prank(owner); // Ensure the caller is the owner
        uint256 someBlock = block.number + 5;
        vm.roll(someBlock);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, someBlock);

        for (uint256 i; i < numUsers; ++i) {
            assertEq(tanIssuanceHistory.cumulativeRewards(rewards[i].account), rewards[i].amount);
        }

        assertEq(tanIssuanceHistory.lastSettlementBlock(), someBlock);
    }

    function testIncreaseClaimableByBatchWhenDeactivated() public {
        // Mock the plugin to return deactivated
        MockPlugin(address(mockPlugin)).setDeactivated(true);

        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](2);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, 100);
        rewards[1] = TANIssuanceHistory.IssuanceReward(user2, 200);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MockPlugin.Deactivated.selector));
        tanIssuanceHistory.increaseClaimableByBatch(rewards, block.number);
    }

    function testCumulativeRewardsAtBlock() public {
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](2);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, 100);
        rewards[1] = TANIssuanceHistory.IssuanceReward(user2, 200);

        vm.prank(owner);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, block.number);

        // Move forward in blocks
        vm.roll(block.number + 10);

        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(user1, block.number - 10), 100);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(user2, block.number - 10), 200);

        uint256 queryBlock = block.number - 10;
        address[] memory accounts = new address[](2);
        accounts[0] = user1;
        accounts[1] = user2;
        (address[] memory users, uint256[] memory returnedRewards) =
            tanIssuanceHistory.cumulativeRewardsAtBlockBatched(accounts, queryBlock);
        for (uint256 i; i < users.length; ++i) {
            assertEq(rewards[i].account, accounts[i]);
            assertEq(returnedRewards[i], rewards[i].amount);
        }
    }

    function testIntegrationTANIssuanceHistory() public {
        // first stake for incentive eligibility
        uint256 userFeeVolume = 100;
        vm.prank(user);
        stakingModule.stake(userFeeVolume);
        vm.prank(referrer);
        stakingModule.stake(userFeeVolume);

        // perform swap, initiating user fee transfer
        MockAmirX.DefiSwap memory defi = MockAmirX.DefiSwap(
            address(0x0), address(0x0), mockPlugin, IERC20(address(0x0)), referrer, userFeeVolume, "", ""
        );

        vm.prank(executor);
        amirX.defiSwap(user, defi);

        /// @dev offchain calculator analyzes resulting user fee transfer event, checks stake eligibility
        /// and then calculates rewards for distribution (calculation simulated below for visibility)
        uint256 issuanceAmount = 3_000_000;
        // user's referrer is eligible for `userFeeVolume`  if staked
        uint256 referrerEligibility = userFeeVolume;
        uint256 totalEligibleVolume = userFeeVolume + referrerEligibility;

        // stake history is only queryable for finalized blocks, so settle a block past the swap
        vm.roll(block.number + 1);

        // derive reward caps
        uint256 userRewardCap = _rewardCap(user);
        uint256 referrerRewardCap = _rewardCap(referrer);

        // calculator uses a very large scaling factor to address arithmetic decimal precision
        uint256 scalingFactor = 1_000_000_000_000_000;
        uint256 userReward = scalingFactor * userFeeVolume / totalEligibleVolume * issuanceAmount / scalingFactor;
        // in this test case does nothing but shown for calculator logic visibility
        if (userRewardCap < userReward) userReward = userRewardCap;
        uint256 referrerReward =
            scalingFactor * referrerEligibility / totalEligibleVolume * issuanceAmount / scalingFactor;
        // in this test case does nothing but shown for calculator logic visibility
        if (referrerRewardCap < referrerReward) referrerReward = referrerRewardCap;

        // once calculated, construct distribution calldata
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](2);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user, userReward);
        rewards[1] = TANIssuanceHistory.IssuanceReward(referrer, referrerReward);
        uint256 endBlock = block.number;

        // pre-settlement sanity asserts
        assertEq(tanIssuanceHistory.lastSettlementBlock(), 0);
        assertEq(tanIssuanceHistory.cumulativeRewards(user), 0);
        assertEq(tanIssuanceHistory.cumulativeRewards(referrer), 0);

        // settle distribution of rewards
        vm.prank(owner);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, endBlock);

        assertEq(tanIssuanceHistory.lastSettlementBlock(), endBlock);
        assertEq(tanIssuanceHistory.cumulativeRewards(user), userReward);
        assertEq(tanIssuanceHistory.cumulativeRewards(referrer), referrerReward);
    }

    /**
     * Settlement edge cases
     */

    /// @dev The settlement entrypoint is consumed by an offchain builder and a Safe UI, so its
    /// selector is part of the operational contract and must survive plugin changes.
    function testSettlementSelectorIsStable() public pure {
        assertEq(uint32(TANIssuanceHistory.increaseClaimableByBatch.selector), uint32(0x8bf2e6a1));
    }

    /// @dev An empty batch is how a settlement gap is closed, so it must advance the block without
    /// touching the plugin, which rejects empty batches outright.
    function testEmptyBatchAdvancesSettlementBlockWithoutTouchingPlugin() public {
        uint256 balanceBefore = tel.balanceOf(address(tanIssuanceHistory));
        uint256 targetBlock = block.number + 500;
        vm.roll(targetBlock);

        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(owner);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, targetBlock);

        assertEq(tanIssuanceHistory.lastSettlementBlock(), targetBlock);
        assertEq(tel.balanceOf(address(tanIssuanceHistory)), balanceBefore);
        assertEq(MockPlugin(address(mockPlugin)).totalClaimable(), 0);
    }

    /// @dev The gap-closing path has to keep working after the plugin winds down, which is only
    /// true while an empty batch skips the plugin entirely.
    function testEmptyBatchSucceedsWhenPluginDeactivated() public {
        MockPlugin(address(mockPlugin)).setDeactivated(true);

        uint256 targetBlock = block.number + 500;
        vm.roll(targetBlock);

        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(owner);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, targetBlock);

        assertEq(tanIssuanceHistory.lastSettlementBlock(), targetBlock);
    }

    /// @dev One period may be settled as several transactions sharing an end block.
    function testChunkedDistributionSameEndBlock() public {
        uint256 endBlock = block.number;

        TANIssuanceHistory.IssuanceReward[] memory chunkOne = new TANIssuanceHistory.IssuanceReward[](1);
        chunkOne[0] = TANIssuanceHistory.IssuanceReward(user1, 100);
        TANIssuanceHistory.IssuanceReward[] memory chunkTwo = new TANIssuanceHistory.IssuanceReward[](1);
        chunkTwo[0] = TANIssuanceHistory.IssuanceReward(user2, 200);

        vm.startPrank(owner);
        tanIssuanceHistory.increaseClaimableByBatch(chunkOne, endBlock);
        tanIssuanceHistory.increaseClaimableByBatch(chunkTwo, endBlock);
        vm.stopPrank();

        assertEq(tanIssuanceHistory.cumulativeRewards(user1), 100);
        assertEq(tanIssuanceHistory.cumulativeRewards(user2), 200);
        assertEq(tanIssuanceHistory.lastSettlementBlock(), endBlock);
    }

    /// @dev A repeated account accumulates on both this contract and the plugin.
    function testDuplicateAccountInSameBatch() public {
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](2);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, 100);
        rewards[1] = TANIssuanceHistory.IssuanceReward(user1, 250);

        vm.prank(owner);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, block.number);

        assertEq(tanIssuanceHistory.cumulativeRewards(user1), 350);
        assertEq(MockPlugin(address(mockPlugin)).claimable(user1), 350);
    }

    /// @dev A zero-amount row is credited nowhere but must not abort the surrounding batch.
    function testZeroAmountRowIsSkippedByPlugin() public {
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](2);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, 0);
        rewards[1] = TANIssuanceHistory.IssuanceReward(user2, 200);

        vm.prank(owner);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, block.number);

        assertEq(tanIssuanceHistory.cumulativeRewards(user1), 0);
        assertEq(tanIssuanceHistory.cumulativeRewards(user2), 200);
        assertEq(MockPlugin(address(mockPlugin)).totalClaimable(), 200);
    }

    /// @dev Exactly the settled total is pulled, leaving no standing allowance behind.
    function testSettlementPullsExactTotalAndClearsAllowance() public {
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](2);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, 100);
        rewards[1] = TANIssuanceHistory.IssuanceReward(user2, 200);

        uint256 historyBefore = tel.balanceOf(address(tanIssuanceHistory));

        vm.prank(owner);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, block.number);

        assertEq(tel.balanceOf(address(mockPlugin)), 300);
        assertEq(tel.balanceOf(address(tanIssuanceHistory)), historyBefore - 300);
        assertEq(tel.allowance(address(tanIssuanceHistory), address(mockPlugin)), 0);
    }

    function testConstructorRejectsPluginWithNoRewardToken() public {
        MockPlugin brokenPlugin = new MockPlugin(IERC20(address(0x0)));

        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.InvalidAddress.selector, address(0x0)));
        new TANIssuanceHistory(ISimplePlugin(address(brokenPlugin)), owner);
    }

    /**
     * Native reward token
     *
     * On a chain where TEL is the gas token the plugin reports the native sentinel and is funded by
     * `msg.value` rather than an approval, so settlement takes the other rail.
     */

    function testNativeDeploymentReportsNativeRail() public {
        (TANIssuanceHistory nativeHistory,) = _deployNative();

        assertEq(nativeHistory.tel(), MockPlugin(address(mockPlugin)).NATIVE_TOKEN());
        assertTrue(nativeHistory.telIsNative());
        assertFalse(tanIssuanceHistory.telIsNative());
    }

    function testNativeSettlementForwardsValueToPlugin() public {
        (TANIssuanceHistory nativeHistory, MockPlugin nativePlugin) = _deployNative();

        // the Safe funds the history contract ahead of settlement, exactly as it does for ERC20
        vm.deal(address(nativeHistory), 1 ether);

        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](2);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, 100);
        rewards[1] = TANIssuanceHistory.IssuanceReward(user2, 200);

        vm.prank(owner);
        nativeHistory.increaseClaimableByBatch(rewards, block.number);

        assertEq(address(nativePlugin).balance, 300);
        assertEq(address(nativeHistory).balance, 1 ether - 300);
        assertEq(nativeHistory.cumulativeRewards(user1), 100);
        assertEq(nativePlugin.claimable(user2), 200);
    }

    /// @dev The gap-closing path must not send value when there is nothing to settle.
    function testNativeEmptyBatchMovesNothing() public {
        (TANIssuanceHistory nativeHistory, MockPlugin nativePlugin) = _deployNative();
        vm.deal(address(nativeHistory), 1 ether);

        uint256 targetBlock = block.number + 500;
        vm.roll(targetBlock);

        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(owner);
        nativeHistory.increaseClaimableByBatch(rewards, targetBlock);

        assertEq(address(nativeHistory).balance, 1 ether);
        assertEq(address(nativePlugin).balance, 0);
        assertEq(nativeHistory.lastSettlementBlock(), targetBlock);
    }

    function testNativeDeploymentAcceptsNativeFunding() public {
        (TANIssuanceHistory nativeHistory,) = _deployNative();

        (bool sent,) = address(nativeHistory).call{ value: 1 ether }("");
        assertTrue(sent);
        assertEq(address(nativeHistory).balance, 1 ether);
    }

    /// @dev An ERC20 deployment has no use for native, so it refuses it rather than accruing dust.
    function testErc20DeploymentRefusesNativeFunding() public {
        vm.deal(address(this), 1 ether);

        (bool sent,) = address(tanIssuanceHistory).call{ value: 1 ether }("");
        assertFalse(sent);
        assertEq(address(tanIssuanceHistory).balance, 0);
    }

    /// @dev The rails must not be swapped under a live deployment, which the reward token check pins.
    function testNativeDeploymentRejectsErc20Plugin() public {
        (TANIssuanceHistory nativeHistory,) = _deployNative();

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.IncompatiblePlugin.selector));
        nativeHistory.setTanIssuancePlugin(mockPlugin);
    }

    function _deployNative() private returns (TANIssuanceHistory, MockPlugin) {
        MockPlugin nativePlugin = new MockPlugin(IERC20(MockPlugin(address(mockPlugin)).NATIVE_TOKEN()));
        TANIssuanceHistory nativeHistory = new TANIssuanceHistory(ISimplePlugin(address(nativePlugin)), owner);

        return (nativeHistory, nativePlugin);
    }

    function testSetTanIssuancePluginRejectsMismatchedRewardToken() public {
        MockTel otherToken = new MockTel("Other", "OTH");
        MockPlugin otherPlugin = new MockPlugin(IERC20(address(otherToken)));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.IncompatiblePlugin.selector));
        tanIssuanceHistory.setTanIssuancePlugin(ISimplePlugin(address(otherPlugin)));
    }

    function testSetTanIssuancePluginAcceptsMatchingRewardToken() public {
        MockPlugin replacement = new MockPlugin(IERC20(address(tel)));

        vm.prank(owner);
        tanIssuanceHistory.setTanIssuancePlugin(ISimplePlugin(address(replacement)));

        assertEq(address(tanIssuanceHistory.tanIssuancePlugin()), address(replacement));
    }

    /**
     * Backfill
     */

    function testBackfillSeedsHistoryAndAdvancesSettlementBlock() public {
        uint256 atBlock = block.number + 10;
        vm.roll(atBlock + 1);

        (address[] memory accounts, uint256[] memory amounts) = _pair(user1, 1000, user2, 2500);

        vm.prank(owner);
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, atBlock);

        assertEq(tanIssuanceHistory.cumulativeRewards(user1), 1000);
        assertEq(tanIssuanceHistory.cumulativeRewards(user2), 2500);
        assertEq(tanIssuanceHistory.lastSettlementBlock(), atBlock);
        // seeded history is only visible from the block it was keyed at
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(user1, atBlock - 1), 0);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(user1, atBlock), 1000);
        // no reward token moves during a backfill
        assertEq(tel.balanceOf(address(mockPlugin)), 0);
    }

    /// @dev While unsealed every checkpoint is a seed, so retrying a chunk is a no-op and restating an
    /// account corrects its seed in place rather than stacking a second checkpoint.
    function testBackfillRetryIsNoOpAndRestateCorrectsSeed() public {
        uint256 atBlock = block.number;
        (address[] memory accounts, uint256[] memory amounts) = _pair(user1, 1000, user2, 2500);

        vm.startPrank(owner);
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, atBlock);

        // an identical retry writes nothing
        vm.recordLogs();
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, atBlock);
        assertEq(vm.getRecordedLogs().length, 0);

        // a corrected value replaces the seed, including a correction down to zero
        amounts[0] = 999_999;
        amounts[1] = 0;
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, atBlock);
        vm.stopPrank();

        assertEq(tanIssuanceHistory.cumulativeRewards(user1), 999_999);
        assertEq(tanIssuanceHistory.cumulativeRewards(user2), 0);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(user1, atBlock), 999_999);
        assertEq(tanIssuanceHistory.backfillBlock(), atBlock);
    }

    /// @dev Settling creates history, and the backfill skips accounts that already carry history. A
    /// backfill running afterwards would silently drop everyone settled in between, so the first
    /// settlement closes the path rather than leaving that trap open.
    function testSettlementSealsBackfill() public {
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](1);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, 42);

        vm.startPrank(owner);
        assertFalse(tanIssuanceHistory.backfillSealed());

        vm.expectEmit(false, false, false, false);
        emit TANIssuanceHistory.BackfillSealed();
        tanIssuanceHistory.increaseClaimableByBatch(rewards, block.number);
        assertTrue(tanIssuanceHistory.backfillSealed());

        (address[] memory accounts, uint256[] memory amounts) = _pair(user2, 1000, referrer, 2500);
        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.BackfillIsSealed.selector));
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, block.number);
        vm.stopPrank();
    }

    /// @dev A gap-closing empty batch credits nobody, so it leaves the backfill open.
    function testEmptyBatchDoesNotSealBackfill() public {
        uint256 targetBlock = block.number + 500;
        vm.roll(targetBlock);

        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        (address[] memory accounts, uint256[] memory amounts) = _pair(user1, 1000, user2, 2500);

        vm.startPrank(owner);
        tanIssuanceHistory.increaseClaimableByBatch(empty, targetBlock);
        assertFalse(tanIssuanceHistory.backfillSealed());

        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, targetBlock);
        vm.stopPrank();

        assertEq(tanIssuanceHistory.cumulativeRewards(user1), 1000);
    }

    /// @dev The first backfill keys must not precede a gap already closed by an empty settlement.
    function testBackfillRejectsBlockBeforeLastSettlement() public {
        uint256 gapBlock = block.number + 100;
        vm.roll(gapBlock + 1);

        (address[] memory accounts, uint256[] memory amounts) = _pair(user1, 1000, user2, 2500);

        vm.startPrank(owner);
        tanIssuanceHistory.increaseClaimableByBatch(new TANIssuanceHistory.IssuanceReward[](0), gapBlock);

        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.InvalidBlock.selector, gapBlock - 1));
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, gapBlock - 1);
        vm.stopPrank();
    }

    /// @dev Every chunk shares the first chunk's key, so a mistyped block is refused rather than
    /// splitting the seed across two keys.
    function testBackfillPinsEveryChunkToOneBlock() public {
        uint256 atBlock = block.number + 100;
        vm.roll(atBlock + 10);

        (address[] memory accounts, uint256[] memory amounts) = _pair(user1, 1000, user2, 2500);
        (address[] memory more, uint256[] memory moreAmounts) = _pair(referrer, 1000, user, 2500);

        vm.startPrank(owner);
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, atBlock);

        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.BackfillBlockMismatch.selector, atBlock, atBlock + 1));
        tanIssuanceHistory.backfillCumulativeRewards(more, moreAmounts, atBlock + 1);

        // a gap close after the first chunk does not strand the remaining chunks
        tanIssuanceHistory.increaseClaimableByBatch(new TANIssuanceHistory.IssuanceReward[](0), atBlock + 5);
        tanIssuanceHistory.backfillCumulativeRewards(more, moreAmounts, atBlock);
        vm.stopPrank();

        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(referrer, atBlock), 1000);
        assertEq(tanIssuanceHistory.lastSettlementBlock(), atBlock + 5);
    }

    function testBackfillRejectsBlockZero() public {
        (address[] memory accounts, uint256[] memory amounts) = _pair(user1, 1000, user2, 2500);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.InvalidBlock.selector, 0));
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, 0);
    }

    function testBackfillRejectsFutureBlock() public {
        (address[] memory accounts, uint256[] memory amounts) = _pair(user1, 1000, user2, 2500);
        uint256 futureBlock = block.number + 1;

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.InvalidBlock.selector, futureBlock));
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, futureBlock);
    }

    function testBackfillRejectsLengthMismatch() public {
        address[] memory accounts = new address[](2);
        accounts[0] = user1;
        accounts[1] = user2;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1000;

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.BackfillLengthMismatch.selector, 2, 1));
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, block.number);
    }

    function testBackfillRejectsZeroAddressWithNonZeroAmount() public {
        (address[] memory accounts, uint256[] memory amounts) = _pair(address(0x0), 1000, user2, 2500);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.InvalidAddress.selector, address(0x0)));
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, block.number);
    }

    function testBackfillIsOnlyOwner() public {
        (address[] memory accounts, uint256[] memory amounts) = _pair(user1, 1000, user2, 2500);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, block.number);
    }

    function testSealBackfillIsOneWayAndBlocksFurtherBackfills() public {
        (address[] memory accounts, uint256[] memory amounts) = _pair(user1, 1000, user2, 2500);

        vm.startPrank(owner);
        assertFalse(tanIssuanceHistory.backfillSealed());
        tanIssuanceHistory.sealBackfill();
        assertTrue(tanIssuanceHistory.backfillSealed());

        // sealing twice is a no-op rather than a revert, so a retried seal transaction is harmless, and it
        // emits nothing the second time
        vm.recordLogs();
        tanIssuanceHistory.sealBackfill();
        assertEq(vm.getRecordedLogs().length, 0);
        assertTrue(tanIssuanceHistory.backfillSealed());

        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.BackfillIsSealed.selector));
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, block.number);
        vm.stopPrank();
    }

    /// @dev Settlement continues normally once the backfill is closed.
    function testSettlementAccumulatesOnTopOfBackfilledHistory() public {
        (address[] memory accounts, uint256[] memory amounts) = _pair(user1, 1000, user2, 2500);

        vm.startPrank(owner);
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, block.number);
        tanIssuanceHistory.sealBackfill();

        vm.roll(block.number + 50);
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](1);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, 500);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, block.number);
        vm.stopPrank();

        assertEq(tanIssuanceHistory.cumulativeRewards(user1), 1500);
        // only the newly settled amount is funded onto the plugin
        assertEq(MockPlugin(address(mockPlugin)).claimable(user1), 500);
    }

    /**
     * Zero rows, backfill boundary, and replay
     */

    /// @dev A batch whose rows are all zero credits nobody, so it neither calls the plugin nor seals.
    function testAllZeroBatchNeitherCallsPluginNorSeals() public {
        // a deactivated plugin reverts on any call, proving the plugin is never reached
        MockPlugin(address(mockPlugin)).setDeactivated(true);

        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](2);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, 0);
        rewards[1] = TANIssuanceHistory.IssuanceReward(user2, 0);

        vm.roll(block.number + 10);
        vm.prank(owner);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, block.number);

        assertFalse(tanIssuanceHistory.backfillSealed());
        assertEq(tanIssuanceHistory.lastSettlementBlock(), block.number);
        assertEq(tanIssuanceHistory.cumulativeRewards(user1), 0);
    }

    /// @dev A credit keyed at the backfill block would merge into the seed and hide it from a read one
    /// block earlier, so the first crediting settlement has to end after it.
    function testCreditingSettlementAtBackfillBlockReverts() public {
        uint256 atBlock = block.number + 10;
        vm.roll(atBlock + 10);
        (address[] memory accounts, uint256[] memory amounts) = _pair(user1, 1000, user2, 2500);

        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](1);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, 500);

        vm.startPrank(owner);
        tanIssuanceHistory.backfillCumulativeRewards(accounts, amounts, atBlock);

        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.InvalidBlock.selector, atBlock));
        tanIssuanceHistory.increaseClaimableByBatch(rewards, atBlock);

        // an empty gap close at the backfill block is still allowed, since it writes no checkpoint
        tanIssuanceHistory.increaseClaimableByBatch(new TANIssuanceHistory.IssuanceReward[](0), atBlock);

        tanIssuanceHistory.increaseClaimableByBatch(rewards, atBlock + 1);
        vm.stopPrank();

        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(user1, atBlock), 1000);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(user1, atBlock + 1), 1500);
    }

    /// @dev Re-executing an identical chunk would credit both ledgers twice, so it is refused.
    function testReplayedChunkReverts() public {
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](2);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, 100);
        rewards[1] = TANIssuanceHistory.IssuanceReward(user2, 200);
        uint256 endBlock = block.number;

        vm.startPrank(owner);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, endBlock);

        bytes32 chunkId = keccak256(abi.encode(rewards, endBlock));
        assertTrue(tanIssuanceHistory.settledChunks(chunkId));

        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.ChunkAlreadySettled.selector, chunkId));
        tanIssuanceHistory.increaseClaimableByBatch(rewards, endBlock);
        vm.stopPrank();

        assertEq(tanIssuanceHistory.cumulativeRewards(user1), 100);
        assertEq(MockPlugin(address(mockPlugin)).claimable(user1), 100);
    }

    /**
     * Settlement bounds and events
     */

    function testSettlementRejectsFutureEndBlock() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.InvalidBlock.selector, block.number + 1));
        tanIssuanceHistory.increaseClaimableByBatch(new TANIssuanceHistory.IssuanceReward[](0), block.number + 1);
    }

    function testSettlementRejectsEndBlockBeforeLastSettlement() public {
        vm.roll(block.number + 10);

        vm.startPrank(owner);
        tanIssuanceHistory.increaseClaimableByBatch(new TANIssuanceHistory.IssuanceReward[](0), block.number);

        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.InvalidBlock.selector, block.number - 1));
        tanIssuanceHistory.increaseClaimableByBatch(new TANIssuanceHistory.IssuanceReward[](0), block.number - 1);
        vm.stopPrank();
    }

    function testSettlementEmitsSettled() public {
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](2);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, 100);
        rewards[1] = TANIssuanceHistory.IssuanceReward(user2, 0);

        vm.expectEmit(address(tanIssuanceHistory));
        emit TANIssuanceHistory.Settled(block.number, 100, 2);

        vm.prank(owner);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, block.number);
    }

    function testSetTanIssuancePluginEmitsUpdate() public {
        MockPlugin newPlugin = new MockPlugin(IERC20(address(tel)));

        vm.expectEmit(address(tanIssuanceHistory));
        emit TANIssuanceHistory.TanIssuancePluginUpdated(address(mockPlugin), address(newPlugin));

        vm.prank(owner);
        tanIssuanceHistory.setTanIssuancePlugin(ISimplePlugin(address(newPlugin)));
    }

    /**
     * Access control
     */

    function testWritersAreOnlyOwner() public {
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user);

        vm.startPrank(user);
        vm.expectRevert(unauthorized);
        tanIssuanceHistory.increaseClaimableByBatch(new TANIssuanceHistory.IssuanceReward[](0), block.number);

        vm.expectRevert(unauthorized);
        tanIssuanceHistory.setTanIssuancePlugin(mockPlugin);

        vm.expectRevert(unauthorized);
        tanIssuanceHistory.sealBackfill();

        vm.expectRevert(unauthorized);
        tanIssuanceHistory.rescueTokens(IERC20(address(tel)), user);

        vm.expectRevert(unauthorized);
        tanIssuanceHistory.renounceOwnership();
        vm.stopPrank();
    }

    function testRenounceOwnershipIsDisabled() public {
        vm.prank(owner);
        vm.expectRevert(TANIssuanceHistory.RenounceOwnershipDisabled.selector);
        tanIssuanceHistory.renounceOwnership();

        assertEq(tanIssuanceHistory.owner(), owner);
    }

    /// @dev A transfer only takes effect once the new owner accepts, so a mistyped address cannot
    /// strand the contract.
    function testOwnershipTransferIsTwoStep() public {
        vm.prank(owner);
        tanIssuanceHistory.transferOwnership(user);

        assertEq(tanIssuanceHistory.owner(), owner);
        assertEq(tanIssuanceHistory.pendingOwner(), user);

        vm.prank(user);
        tanIssuanceHistory.acceptOwnership();
        assertEq(tanIssuanceHistory.owner(), user);
    }

    /**
     * Rescue
     */

    function testRescueTokensSweepsErc20Balance() public {
        uint256 balance = tel.balanceOf(address(tanIssuanceHistory));

        vm.prank(owner);
        tanIssuanceHistory.rescueTokens(IERC20(address(tel)), user);

        assertEq(tel.balanceOf(address(tanIssuanceHistory)), 0);
        assertEq(tel.balanceOf(user), balance);
    }

    function testRescueTokensSweepsNativeBalance() public {
        (TANIssuanceHistory nativeHistory,) = _deployNative();
        vm.deal(address(nativeHistory), 5 ether);

        vm.prank(owner);
        nativeHistory.rescueTokens(IERC20(address(0x0)), user);

        assertEq(address(nativeHistory).balance, 0);
        assertEq(user.balance, 5 ether);
    }

    /// @dev The cap the offchain calculator applies: stake held over the period, less rewards
    /// already issued to that account.
    function _rewardCap(address account) private view returns (uint256) {
        uint256 queryBlock = block.number - 1;

        return stakingModule.getPastVotes(account, queryBlock)
            - tanIssuanceHistory.cumulativeRewardsAtBlock(account, queryBlock);
    }

    function _pair(
        address accountOne,
        uint256 amountOne,
        address accountTwo,
        uint256 amountTwo
    )
        private
        pure
        returns (address[] memory accounts, uint256[] memory amounts)
    {
        accounts = new address[](2);
        accounts[0] = accountOne;
        accounts[1] = accountTwo;
        amounts = new uint256[](2);
        amounts[0] = amountOne;
        amounts[1] = amountTwo;
    }
}
