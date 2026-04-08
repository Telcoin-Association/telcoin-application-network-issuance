// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/issuance/TANIssuanceHistory.sol";
import "../src/interfaces/ISimplePlugin.sol";
import "./mocks/MockImplementations.sol";

/**
 * @title ResumeAfterPauseTest
 * @notice Tests that validate the safety of resuming TANIP-1 staker incentives
 *         after a multi-month pause by advancing `lastSettlementBlock` via
 *         empty-batch calls to `increaseClaimableByBatch`.
 *
 * Categories:
 *   1. Empty-batch jump mechanics
 *   2. Cumulative rewards preservation across the gap
 *   3. Stake-based cap correctness for various user categories
 *   4. Plugin deactivation edge case
 *   5. Full end-to-end: pre-pause -> jump -> resume with real rewards
 */
contract ResumeAfterPauseTest is Test {
    MockTel tel;
    MockStakingModule public stakingModule;
    ISimplePlugin public mockPlugin;
    TANIssuanceHistory public tanIssuanceHistory;

    address public tanSafe = address(0xAAA);
    address public userA = address(0x1001);
    address public userB = address(0x1002);
    address public userC = address(0x1003);
    address public newUser = address(0x2001);

    uint256 constant PERIOD_27_END = 100;
    uint256 constant RESUME_BLOCK = 1000;
    uint256 constant FIRST_REAL_PERIOD_END = 1100;

    function setUp() public {
        tel = new MockTel("Telcoin", "TEL");
        stakingModule = new MockStakingModule();
        mockPlugin = ISimplePlugin(address(new MockPlugin(IERC20(address(tel)))));
        tanIssuanceHistory = new TANIssuanceHistory(mockPlugin, tanSafe);
        tel.mint(address(tanIssuanceHistory), 100_000_000);
    }

    // ================================================================
    //  1. EMPTY-BATCH JUMP MECHANICS
    // ================================================================

    function testEmptyBatchAdvancesSettlementBlock() public {
        vm.roll(RESUME_BLOCK);
        assertEq(tanIssuanceHistory.lastSettlementBlock(), 0);

        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, RESUME_BLOCK);

        assertEq(tanIssuanceHistory.lastSettlementBlock(), RESUME_BLOCK);
    }

    function testSingleJumpEquivalentToManySmallJumps() public {
        TANIssuanceHistory historyA = new TANIssuanceHistory(mockPlugin, tanSafe);
        TANIssuanceHistory historyB = new TANIssuanceHistory(mockPlugin, tanSafe);
        tel.mint(address(historyA), 100_000_000);
        tel.mint(address(historyB), 100_000_000);

        // Settle period 27 on both
        vm.roll(PERIOD_27_END);
        TANIssuanceHistory.IssuanceReward[] memory p27 = new TANIssuanceHistory.IssuanceReward[](2);
        p27[0] = TANIssuanceHistory.IssuanceReward(userA, 500);
        p27[1] = TANIssuanceHistory.IssuanceReward(userB, 300);
        vm.prank(tanSafe);
        historyA.increaseClaimableByBatch(p27, PERIOD_27_END);
        vm.prank(tanSafe);
        historyB.increaseClaimableByBatch(p27, PERIOD_27_END);

        vm.roll(RESUME_BLOCK);
        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);

        // A: single big jump
        vm.prank(tanSafe);
        historyA.increaseClaimableByBatch(empty, RESUME_BLOCK);

        // B: many small jumps
        for (uint256 b = 200; b <= RESUME_BLOCK; b += 100) {
            vm.prank(tanSafe);
            historyB.increaseClaimableByBatch(empty, b);
        }

        // Identical end state
        assertEq(historyA.lastSettlementBlock(), historyB.lastSettlementBlock());
        assertEq(historyA.cumulativeRewards(userA), historyB.cumulativeRewards(userA));
        assertEq(historyA.cumulativeRewards(userB), historyB.cumulativeRewards(userB));
        assertEq(historyA.cumulativeRewards(newUser), 0);
        assertEq(historyB.cumulativeRewards(newUser), 0);
    }

    function testNoTelMovementDuringEmptyBatch() public {
        vm.roll(RESUME_BLOCK);
        uint256 histBal = tel.balanceOf(address(tanIssuanceHistory));
        uint256 plugBal = tel.balanceOf(address(mockPlugin));

        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, RESUME_BLOCK);

        assertEq(tel.balanceOf(address(tanIssuanceHistory)), histBal);
        assertEq(tel.balanceOf(address(mockPlugin)), plugBal);
    }

    // ================================================================
    //  2. CUMULATIVE REWARDS PRESERVATION ACROSS THE GAP
    // ================================================================

    function testCumulativeRewardsPreservedAfterJump() public {
        vm.roll(PERIOD_27_END);
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](3);
        rewards[0] = TANIssuanceHistory.IssuanceReward(userA, 500);
        rewards[1] = TANIssuanceHistory.IssuanceReward(userB, 300);
        rewards[2] = TANIssuanceHistory.IssuanceReward(userC, 100);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, PERIOD_27_END);

        // Jump
        vm.roll(RESUME_BLOCK);
        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, RESUME_BLOCK);

        assertEq(tanIssuanceHistory.cumulativeRewards(userA), 500);
        assertEq(tanIssuanceHistory.cumulativeRewards(userB), 300);
        assertEq(tanIssuanceHistory.cumulativeRewards(userC), 100);
    }

    function testCumulativeRewardsAtBlockInGap() public {
        vm.roll(PERIOD_27_END);
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](1);
        rewards[0] = TANIssuanceHistory.IssuanceReward(userA, 500);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, PERIOD_27_END);

        vm.roll(RESUME_BLOCK);
        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, RESUME_BLOCK);

        // upperLookupRecent finds the checkpoint at PERIOD_27_END for all gap blocks
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, PERIOD_27_END), 500);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, PERIOD_27_END + 50), 500);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, RESUME_BLOCK - 1), 500);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, RESUME_BLOCK), 500);
    }

    function testNewUserCumulativeRewardsZeroAfterJump() public {
        vm.roll(PERIOD_27_END);
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](1);
        rewards[0] = TANIssuanceHistory.IssuanceReward(userA, 500);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, PERIOD_27_END);

        vm.roll(RESUME_BLOCK);
        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, RESUME_BLOCK);

        // newUser never received rewards; cumulative is 0 everywhere
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(newUser, PERIOD_27_END), 0);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(newUser, RESUME_BLOCK), 0);
    }

    // ================================================================
    //  3. STAKE-CAP CORRECTNESS (simulated offchain logic)
    // ================================================================

    /// @notice Proves the cap formula for various user categories after the gap
    function testStakeCapCalculationAfterResume() public {
        vm.roll(PERIOD_27_END);
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](2);
        rewards[0] = TANIssuanceHistory.IssuanceReward(userA, 500);
        rewards[1] = TANIssuanceHistory.IssuanceReward(userB, 800);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, PERIOD_27_END);

        vm.roll(RESUME_BLOCK);
        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, RESUME_BLOCK);

        // The calculator queries at endBlock - 1
        uint256 queryBlock = RESUME_BLOCK - 1;

        // userA: stayed staked at 1000 => cap = 1000 - 500 = 500
        uint256 userACum = tanIssuanceHistory.cumulativeRewardsAtBlock(userA, queryBlock);
        assertEq(userACum, 500);
        assertEq(1000 - userACum, 500);

        // userB: increased stake to 2000 => cap = 2000 - 800 = 1200
        uint256 userBCum = tanIssuanceHistory.cumulativeRewardsAtBlock(userB, queryBlock);
        assertEq(userBCum, 800);
        assertEq(2000 - userBCum, 1200);

        // userA with reduced stake to 400 => 400 < 500, underflow
        // Calculator clamps negative caps to 0 via `if (currentChainRewardCap > 0)`
        assertTrue(400 < userACum, "reduced stake < cumulative => cap clamped to 0 offchain");

        // newUser: no prior rewards => cap = full stake
        uint256 newCum = tanIssuanceHistory.cumulativeRewardsAtBlock(newUser, queryBlock);
        assertEq(newCum, 0);
        assertEq(5000 - newCum, 5000);
    }

    // ================================================================
    //  4. PLUGIN DEACTIVATION
    // ================================================================

    function testEmptyBatchSucceedsWhenPluginDeactivated() public {
        MockPlugin(address(mockPlugin)).setDeactivated(true);
        vm.roll(RESUME_BLOCK);

        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, RESUME_BLOCK);
        assertEq(tanIssuanceHistory.lastSettlementBlock(), RESUME_BLOCK);
    }

    function testNonEmptyBatchRevertsWhenPluginDeactivated() public {
        MockPlugin(address(mockPlugin)).setDeactivated(true);
        vm.roll(RESUME_BLOCK);

        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](1);
        rewards[0] = TANIssuanceHistory.IssuanceReward(userA, 100);

        vm.prank(tanSafe);
        vm.expectRevert(abi.encodeWithSelector(MockPlugin.Deactivated.selector));
        tanIssuanceHistory.increaseClaimableByBatch(rewards, RESUME_BLOCK);
    }

    function testReactivatePluginThenDistribute() public {
        MockPlugin(address(mockPlugin)).setDeactivated(true);

        vm.roll(RESUME_BLOCK);
        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, RESUME_BLOCK);

        MockPlugin(address(mockPlugin)).setDeactivated(false);

        vm.roll(FIRST_REAL_PERIOD_END);
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](1);
        rewards[0] = TANIssuanceHistory.IssuanceReward(userA, 100);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, FIRST_REAL_PERIOD_END);
        assertEq(tanIssuanceHistory.cumulativeRewards(userA), 100);
    }

    // ================================================================
    //  5. FULL END-TO-END: PRE-PAUSE -> JUMP -> RESUME
    // ================================================================

    function testFullEndToEndResumeFlow() public {
        // --- Period 25 ---
        vm.roll(60);
        TANIssuanceHistory.IssuanceReward[] memory p25 = new TANIssuanceHistory.IssuanceReward[](2);
        p25[0] = TANIssuanceHistory.IssuanceReward(userA, 200);
        p25[1] = TANIssuanceHistory.IssuanceReward(userB, 100);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(p25, 60);

        // --- Period 26 ---
        vm.roll(80);
        TANIssuanceHistory.IssuanceReward[] memory p26 = new TANIssuanceHistory.IssuanceReward[](2);
        p26[0] = TANIssuanceHistory.IssuanceReward(userA, 300);
        p26[1] = TANIssuanceHistory.IssuanceReward(userB, 150);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(p26, 80);

        // --- Period 27 (last before pause) ---
        vm.roll(PERIOD_27_END);
        TANIssuanceHistory.IssuanceReward[] memory p27 = new TANIssuanceHistory.IssuanceReward[](2);
        p27[0] = TANIssuanceHistory.IssuanceReward(userA, 500);
        p27[1] = TANIssuanceHistory.IssuanceReward(userB, 250);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(p27, PERIOD_27_END);

        // Verify pre-pause cumulative: userA=1000, userB=500
        assertEq(tanIssuanceHistory.cumulativeRewards(userA), 1000);
        assertEq(tanIssuanceHistory.cumulativeRewards(userB), 500);

        // --- Jump to resume (single empty batch) ---
        vm.roll(RESUME_BLOCK);
        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, RESUME_BLOCK);

        // Cumulative unchanged
        assertEq(tanIssuanceHistory.cumulativeRewards(userA), 1000);
        assertEq(tanIssuanceHistory.cumulativeRewards(userB), 500);
        assertEq(tanIssuanceHistory.lastSettlementBlock(), RESUME_BLOCK);

        // Historical queries at each period boundary
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, 60), 200);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, 80), 500);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, PERIOD_27_END), 1000);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, RESUME_BLOCK - 1), 1000);

        // --- First real period after resume, including a new user ---
        vm.roll(FIRST_REAL_PERIOD_END);
        TANIssuanceHistory.IssuanceReward[] memory resume = new TANIssuanceHistory.IssuanceReward[](3);
        resume[0] = TANIssuanceHistory.IssuanceReward(userA, 100);
        resume[1] = TANIssuanceHistory.IssuanceReward(userB, 75);
        resume[2] = TANIssuanceHistory.IssuanceReward(newUser, 400);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(resume, FIRST_REAL_PERIOD_END);

        assertEq(tanIssuanceHistory.cumulativeRewards(userA), 1100);
        assertEq(tanIssuanceHistory.cumulativeRewards(userB), 575);
        assertEq(tanIssuanceHistory.cumulativeRewards(newUser), 400);
        assertEq(tanIssuanceHistory.lastSettlementBlock(), FIRST_REAL_PERIOD_END);

        // Gap queries still correct
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, RESUME_BLOCK - 1), 1000);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, FIRST_REAL_PERIOD_END), 1100);
    }

    // ================================================================
    //  6. EDGE CASES
    // ================================================================

    function testCannotGoBackwardsAfterJump() public {
        vm.roll(RESUME_BLOCK);
        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, RESUME_BLOCK);

        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.InvalidBlock.selector, RESUME_BLOCK - 100));
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, RESUME_BLOCK - 100);
    }

    function testFuzz_arbitraryGapSize(uint32 gapSize) public {
        gapSize = uint32(bound(gapSize, 1, 10_000_000));

        vm.roll(PERIOD_27_END);
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](1);
        rewards[0] = TANIssuanceHistory.IssuanceReward(userA, 500);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, PERIOD_27_END);

        uint256 target = PERIOD_27_END + gapSize;
        vm.roll(target);
        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, target);

        assertEq(tanIssuanceHistory.lastSettlementBlock(), target);
        assertEq(tanIssuanceHistory.cumulativeRewards(userA), 500);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, target - 1), 500);
    }

    /// @notice Duplicate user in same rewards batch should accumulate correctly
    ///         OZ Checkpoints.push overwrites at the same key, but _incrementCumulativeRewards
    ///         reads .latest() first, so sequential pushes at the same block accumulate.
    function testDuplicateUserInSameBatch() public {
        vm.roll(PERIOD_27_END);
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](1);
        rewards[0] = TANIssuanceHistory.IssuanceReward(userA, 500);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, PERIOD_27_END);

        vm.roll(RESUME_BLOCK);
        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, RESUME_BLOCK);

        // Resume period: userA appears TWICE in the same batch
        vm.roll(FIRST_REAL_PERIOD_END);
        TANIssuanceHistory.IssuanceReward[] memory duped = new TANIssuanceHistory.IssuanceReward[](2);
        duped[0] = TANIssuanceHistory.IssuanceReward(userA, 100);
        duped[1] = TANIssuanceHistory.IssuanceReward(userA, 50);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(duped, FIRST_REAL_PERIOD_END);

        // cumulative should be 500 + 100 + 50 = 650
        // First push: latest()=500, new=600, push(1100, 600) -> checkpoint created
        // Second push: latest()=600, new=650, push(1100, 650) -> overwrites to 650
        assertEq(tanIssuanceHistory.cumulativeRewards(userA), 650);
    }

    /// @notice Chunked distribution: two batches at the same endBlock (simulating Safe chunks)
    function testChunkedDistributionSameEndBlock() public {
        vm.roll(PERIOD_27_END);
        TANIssuanceHistory.IssuanceReward[] memory p27 = new TANIssuanceHistory.IssuanceReward[](1);
        p27[0] = TANIssuanceHistory.IssuanceReward(userA, 500);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(p27, PERIOD_27_END);

        vm.roll(RESUME_BLOCK);
        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, RESUME_BLOCK);

        // Chunk 1: userA gets rewards
        vm.roll(FIRST_REAL_PERIOD_END);
        TANIssuanceHistory.IssuanceReward[] memory chunk1 = new TANIssuanceHistory.IssuanceReward[](1);
        chunk1[0] = TANIssuanceHistory.IssuanceReward(userA, 100);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(chunk1, FIRST_REAL_PERIOD_END);

        // Chunk 2: userB gets rewards, at the SAME endBlock
        // endBlock == lastSettlementBlock is allowed by the contract
        TANIssuanceHistory.IssuanceReward[] memory chunk2 = new TANIssuanceHistory.IssuanceReward[](1);
        chunk2[0] = TANIssuanceHistory.IssuanceReward(userB, 200);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(chunk2, FIRST_REAL_PERIOD_END);

        assertEq(tanIssuanceHistory.cumulativeRewards(userA), 600); // 500 + 100
        assertEq(tanIssuanceHistory.cumulativeRewards(userB), 200);
        assertEq(tanIssuanceHistory.lastSettlementBlock(), FIRST_REAL_PERIOD_END);
    }

    /// @notice Query cumulative rewards at a block BEFORE the user's first checkpoint
    function testCumulativeRewardsBeforeFirstCheckpoint() public {
        // User first receives rewards at block 100
        vm.roll(PERIOD_27_END);
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](1);
        rewards[0] = TANIssuanceHistory.IssuanceReward(userA, 500);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, PERIOD_27_END);

        vm.roll(RESUME_BLOCK);

        // Query at block 50 (before userA's first checkpoint at block 100)
        // upperLookupRecent should return 0 since no checkpoint exists at or before block 50
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, PERIOD_27_END - 1), 0);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, 1), 0);
    }

    /// @notice Second real period after resume correctly accumulates rewards
    function testSecondPeriodAfterResumeCapQuery() public {
        // Period 27
        vm.roll(PERIOD_27_END);
        TANIssuanceHistory.IssuanceReward[] memory p27 = new TANIssuanceHistory.IssuanceReward[](1);
        p27[0] = TANIssuanceHistory.IssuanceReward(userA, 500);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(p27, PERIOD_27_END);

        // Jump
        vm.roll(RESUME_BLOCK);
        TANIssuanceHistory.IssuanceReward[] memory empty = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(empty, RESUME_BLOCK);

        // First real period
        vm.roll(FIRST_REAL_PERIOD_END);
        TANIssuanceHistory.IssuanceReward[] memory r1 = new TANIssuanceHistory.IssuanceReward[](1);
        r1[0] = TANIssuanceHistory.IssuanceReward(userA, 200);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(r1, FIRST_REAL_PERIOD_END);

        // Verify: for second period's cap calculation
        // Calculator queries endBlock-1 to get pre-settlement cumulative
        // At block 1099 (just before period 1 settlement): returns period 27 value = 500
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, FIRST_REAL_PERIOD_END - 1), 500);
        // At block 1100 (period 1 settlement): returns accumulated = 700
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, FIRST_REAL_PERIOD_END), 700);

        // Second real period: query at any block after 1100 returns 700
        vm.roll(1200);
        assertEq(tanIssuanceHistory.cumulativeRewardsAtBlock(userA, 1199), 700);
    }
}
