// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { Test, console2 } from "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Deployments } from "../deployments/Deployments.sol";
import "../src/issuance/TANIssuanceHistory.sol";
import "../src/interfaces/ISimplePlugin.sol";

/**
 * @title ResumeAfterPauseForkTest
 * @notice Fork tests against the real deployed TANIssuanceHistory on Polygon.
 *         Validates that the resume approach (empty-batch jump) works correctly
 *         with actual on-chain state including real cumulative rewards from period 27.
 *
 * Prerequisites:
 *   - POLYGON_RPC_URL env var set
 *   - Run: forge test --match-contract ResumeAfterPauseForkTest -vvv
 */
contract ResumeAfterPauseForkTest is Test {
    string POLYGON_RPC_URL = vm.envString("POLYGON_RPC_URL");
    uint256 polygonFork;

    Deployments deployments;

    TANIssuanceHistory public tanIssuanceHistory;
    ISimplePlugin public plugin;
    ERC20 public tel;
    address public tanSafe;

    // Period 27 endBlock from rewards/staker_rewards_period_27.json
    uint256 constant PERIOD_27_END_BLOCK = 75_981_194;

    // Some known reward recipients from period 27 (for cumulative reward verification)
    address constant KNOWN_USER_1 = 0x964087989Df5D5e89cF7527b72A3949367a337bA;
    address constant KNOWN_USER_2 = 0x9b771aB7e36Df66255bCfe56b56243AF1DAAEfB9;

    function setUp() public {
        string memory root = vm.projectRoot();
        string memory path = string.concat(root, "/deployments/deployments.json");
        string memory json = vm.readFile(path);
        bytes memory data = vm.parseJson(json);
        deployments = abi.decode(data, (Deployments));

        tanIssuanceHistory = TANIssuanceHistory(deployments.TANIssuanceHistory);
        plugin = ISimplePlugin(deployments.TANIssuancePlugin);
        tel = ERC20(deployments.polygonTEL);
        tanSafe = deployments.TANSafe;

        polygonFork = vm.createFork(POLYGON_RPC_URL);
    }

    /// @notice Preflight: read and log real on-chain state before attempting any changes
    function testPreflightChecks() public {
        vm.selectFork(polygonFork);

        uint256 lastSettlement = tanIssuanceHistory.lastSettlementBlock();
        bool isDeactivated = tanIssuanceHistory.deactivated();
        address owner = tanIssuanceHistory.owner();
        uint256 safeTelBalance = tel.balanceOf(tanSafe);
        uint256 historyTelBalance = tel.balanceOf(address(tanIssuanceHistory));
        uint256 currentBlock = block.number;

        console2.log("=== PREFLIGHT CHECKS ===");
        console2.log("Current block:", currentBlock);
        console2.log("lastSettlementBlock:", lastSettlement);
        console2.log("Plugin deactivated:", isDeactivated);
        console2.log("Contract owner (should be TAN Safe):", owner);
        console2.log("TAN Safe TEL balance:", safeTelBalance);
        console2.log("TANIssuanceHistory TEL balance:", historyTelBalance);
        console2.log("Blocks since last settlement:", currentBlock - lastSettlement);

        // Assertions
        assertEq(owner, tanSafe, "Owner should be TAN Safe");
        assertFalse(isDeactivated, "Plugin should NOT be deactivated");
        assertGe(lastSettlement, PERIOD_27_END_BLOCK, "lastSettlement should be >= period 27 endBlock");
        assertGt(safeTelBalance, 0, "TAN Safe should have TEL balance");

        // Check cumulative rewards for known users
        uint256 user1Cumulative = tanIssuanceHistory.cumulativeRewards(KNOWN_USER_1);
        uint256 user2Cumulative = tanIssuanceHistory.cumulativeRewards(KNOWN_USER_2);
        console2.log("Known user 1 cumulative rewards:", user1Cumulative);
        console2.log("Known user 2 cumulative rewards:", user2Cumulative);
        assertGt(user1Cumulative, 0, "Known user should have nonzero cumulative rewards");
    }

    /// @notice Simulate the empty-batch jump on a fork and verify all state is correct
    function testEmptyBatchJumpOnFork() public {
        vm.selectFork(polygonFork);

        uint256 lastSettlement = tanIssuanceHistory.lastSettlementBlock();
        uint256 currentBlock = block.number;

        // Snapshot cumulative rewards for known users before the jump
        uint256 user1CumBefore = tanIssuanceHistory.cumulativeRewards(KNOWN_USER_1);
        uint256 user2CumBefore = tanIssuanceHistory.cumulativeRewards(KNOWN_USER_2);

        // Pick a reorg-safe target block (current - 500)
        uint256 targetBlock = currentBlock - 500;
        require(targetBlock > lastSettlement, "Target must be after lastSettlement");

        console2.log("Jumping from lastSettlement", lastSettlement, "to targetBlock", targetBlock);

        // Execute empty batch as TAN Safe
        TANIssuanceHistory.IssuanceReward[] memory emptyRewards = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(emptyRewards, targetBlock);

        // Verify lastSettlementBlock advanced
        assertEq(tanIssuanceHistory.lastSettlementBlock(), targetBlock);

        // Verify cumulative rewards unchanged
        assertEq(tanIssuanceHistory.cumulativeRewards(KNOWN_USER_1), user1CumBefore);
        assertEq(tanIssuanceHistory.cumulativeRewards(KNOWN_USER_2), user2CumBefore);

        // Verify historical lookup at the gap returns correct values
        assertEq(
            tanIssuanceHistory.cumulativeRewardsAtBlock(KNOWN_USER_1, targetBlock - 1),
            user1CumBefore
        );

        // Verify no TEL moved
        assertEq(tel.balanceOf(address(tanIssuanceHistory)), 0, "History contract should still have 0 TEL");

        console2.log("Empty batch jump succeeded. lastSettlementBlock is now:", targetBlock);
        console2.log("Cumulative rewards preserved for user1:", user1CumBefore);
        console2.log("Cumulative rewards preserved for user2:", user2CumBefore);
    }

    /// @notice After the jump, simulate a real reward distribution for one period
    function testRealRewardsAfterJumpOnFork() public {
        vm.selectFork(polygonFork);

        uint256 currentBlock = block.number;
        uint256 targetBlock = currentBlock - 500;

        // Snapshot pre-jump state
        uint256 user1CumBefore = tanIssuanceHistory.cumulativeRewards(KNOWN_USER_1);

        // Step 1: Empty batch jump
        TANIssuanceHistory.IssuanceReward[] memory emptyRewards = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(emptyRewards, targetBlock);

        // Step 2: Advance to a "first real period" endBlock
        uint256 firstPeriodEnd = currentBlock;
        vm.roll(firstPeriodEnd + 1); // ensure endBlock <= block.number

        // Step 3: Simulate real rewards distribution
        uint256 rewardAmount = 1000; // small test reward
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](1);
        rewards[0] = TANIssuanceHistory.IssuanceReward(KNOWN_USER_1, rewardAmount);

        // Fund the TANIssuanceHistory with TEL from TAN Safe
        vm.prank(tanSafe);
        tel.transfer(address(tanIssuanceHistory), rewardAmount);

        // Distribute
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(rewards, firstPeriodEnd);

        // Verify cumulative rewards updated correctly
        uint256 user1CumAfter = tanIssuanceHistory.cumulativeRewards(KNOWN_USER_1);
        assertEq(user1CumAfter, user1CumBefore + rewardAmount, "Cumulative should include new reward");
        assertEq(tanIssuanceHistory.lastSettlementBlock(), firstPeriodEnd);

        // Verify historical lookup still works across the gap
        assertEq(
            tanIssuanceHistory.cumulativeRewardsAtBlock(KNOWN_USER_1, targetBlock - 1),
            user1CumBefore,
            "Gap query should return pre-jump value"
        );
        assertEq(
            tanIssuanceHistory.cumulativeRewardsAtBlock(KNOWN_USER_1, firstPeriodEnd),
            user1CumBefore + rewardAmount,
            "Post-period query should return accumulated value"
        );

        console2.log("Real rewards after jump succeeded.");
        console2.log("User1 cumulative before:", user1CumBefore);
        console2.log("User1 cumulative after:", user1CumAfter);
    }

    /// @notice Verify the cap calculation would be correct for a known user after the jump.
    ///         This simulates what the offchain calculator does.
    function testCapCalculationOnFork() public {
        vm.selectFork(polygonFork);

        uint256 currentBlock = block.number;
        uint256 targetBlock = currentBlock - 500;

        // Jump
        TANIssuanceHistory.IssuanceReward[] memory emptyRewards = new TANIssuanceHistory.IssuanceReward[](0);
        vm.prank(tanSafe);
        tanIssuanceHistory.increaseClaimableByBatch(emptyRewards, targetBlock);

        // Query cumulative rewards at (targetBlock - 1) as the calculator does
        uint256 cumRewards = tanIssuanceHistory.cumulativeRewardsAtBlock(KNOWN_USER_1, targetBlock - 1);

        console2.log("=== CAP CALCULATION SIMULATION ===");
        console2.log("User:", KNOWN_USER_1);
        console2.log("Cumulative rewards (pre-settlement):", cumRewards);

        // Read the user's current stake from StakingModule
        // stakedByAt(address, blockNumber) - use targetBlock-1 so it's in the past
        (bool success, bytes memory ret) = deployments.StakingModule.staticcall(
            abi.encodeWithSignature("stakedByAt(address,uint256)", KNOWN_USER_1, targetBlock - 1)
        );

        if (success && ret.length >= 32) {
            uint256 userStake = abi.decode(ret, (uint256));
            console2.log("User stake at targetBlock-1:", userStake);

            if (userStake > cumRewards) {
                uint256 cap = userStake - cumRewards;
                console2.log("Reward cap (stake - cumulative):", cap);
                assertGt(cap, 0, "Cap should be positive for a staked user");
            } else {
                console2.log("WARNING: stake <= cumulative rewards. Cap would be 0.");
                console2.log("This user cannot earn rewards until their stake exceeds cumulative.");
            }
        } else {
            console2.log("Could not read stake (user may have unstaked)");
        }
    }
}
