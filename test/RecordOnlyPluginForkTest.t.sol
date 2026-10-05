// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Deployments } from "../deployments/Deployments.sol";
import "../src/issuance/TANIssuanceHistory.sol";
import "../src/issuance/RecordOnlyPlugin.sol";
import "../src/interfaces/ISimplePlugin.sol";

/// @dev Simulates the migrated per-period TAN Safe batch against live Polygon state:
/// record old-TEL (2 decimals) rewards on TANIssuanceHistory via the stub, pay new TEL (18 decimals) directly
contract RecordOnlyPluginForkTest is Test {
    string POLYGON_RPC_URL = vm.envString("POLYGON_RPC_URL");
    uint256 polygonFork;

    Deployments deployments;
    TANIssuanceHistory history;
    ISimplePlugin realPlugin;
    IERC20 oldTel;
    IERC20 newTel = IERC20(0x7E13B43065380aCdeC1c2d138c579cbBbafA0731);
    address tanSafe;
    RecordOnlyPlugin stub;

    uint256 constant OLD_TO_NEW_SCALE = 1e16;
    address user1 = address(0xabc1);
    address user2 = address(0xabc2);

    function setUp() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/deployments.json"));
        deployments = abi.decode(vm.parseJson(json), (Deployments));

        history = TANIssuanceHistory(deployments.TANIssuanceHistory);
        realPlugin = ISimplePlugin(deployments.TANIssuancePlugin);
        oldTel = IERC20(deployments.polygonTEL);
        tanSafe = deployments.TANSafe;

        polygonFork = vm.createSelectFork(POLYGON_RPC_URL);
        stub = new RecordOnlyPlugin(oldTel, address(history));
    }

    function testFork_setupAndPeriodBatch() public {
        // one-time setup tx from the TAN Safe
        vm.prank(tanSafe);
        history.setTanIssuancePlugin(ISimplePlugin(address(stub)));
        assertEq(address(history.tanIssuancePlugin()), address(stub));

        uint256 reward1 = 123_456; // 1,234.56 old TEL
        uint256 reward2 = 7; // 0.07 old TEL
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](2);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, reward1);
        rewards[1] = TANIssuanceHistory.IssuanceReward(user2, reward2);

        uint256 endBlock = block.number;
        uint256 prevCumulative1 = history.cumulativeRewards(user1);
        uint256 prevCumulative2 = history.cumulativeRewards(user2);
        uint256 historyOldTelBefore = oldTel.balanceOf(address(history));
        uint256 pluginOldTelBefore = oldTel.balanceOf(address(realPlugin));
        uint256 pluginTotalClaimableBefore = realPlugin.totalClaimable();

        // fund the Safe with new TEL for the simulation
        uint256 totalNew = (reward1 + reward2) * OLD_TO_NEW_SCALE;
        deal(address(newTel), tanSafe, totalNew);

        // per-period batch: record, then direct transfers
        vm.startPrank(tanSafe);
        history.increaseClaimableByBatch(rewards, endBlock);
        newTel.transfer(user1, reward1 * OLD_TO_NEW_SCALE);
        newTel.transfer(user2, reward2 * OLD_TO_NEW_SCALE);
        vm.stopPrank();

        // record side: old-TEL units
        assertEq(history.cumulativeRewards(user1), prevCumulative1 + reward1);
        assertEq(history.cumulativeRewards(user2), prevCumulative2 + reward2);
        assertEq(history.lastSettlementBlock(), endBlock);
        // no old TEL moved anywhere
        assertEq(oldTel.balanceOf(address(history)), historyOldTelBefore);
        assertEq(oldTel.balanceOf(address(realPlugin)), pluginOldTelBefore);
        assertEq(oldTel.balanceOf(address(stub)), 0);
        assertEq(realPlugin.totalClaimable(), pluginTotalClaimableBefore);
        // pay side: new-TEL units, 1:1 value
        assertEq(newTel.balanceOf(user1), reward1 * OLD_TO_NEW_SCALE);
        assertEq(newTel.balanceOf(user2), reward2 * OLD_TO_NEW_SCALE);
        assertEq(newTel.balanceOf(tanSafe), 0);
    }

    /// @dev Old-TEL rewards already claimable on the original plugin stay claimable through the StakingModule
    function testFork_existingClaimsUnaffectedBySwap() public {
        address stakingModule = deployments.StakingModule;
        uint256 claimableBefore = 500;
        uint256 endBlock = block.number;

        // pre-swap: settle via the original plugin, which pulls old TEL from the funded history
        deal(address(oldTel), address(history), claimableBefore);
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](1);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, claimableBefore);
        vm.prank(tanSafe);
        history.increaseClaimableByBatch(rewards, endBlock);
        assertEq(_moduleClaimable(stakingModule, user1), claimableBefore);

        // swap and record a stub-era reward
        vm.startPrank(tanSafe);
        history.setTanIssuancePlugin(ISimplePlugin(address(stub)));
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, 7);
        history.increaseClaimableByBatch(rewards, endBlock);
        vm.stopPrank();

        // stub-era records add nothing claimable; the old balance still claims in full
        assertEq(_moduleClaimable(stakingModule, user1), claimableBefore);
        vm.prank(user1);
        (bool ok, bytes memory ret) = stakingModule.call(abi.encodeWithSignature("claim(bytes)", ""));
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint256)), claimableBefore);
        assertEq(oldTel.balanceOf(user1), claimableBefore);
        assertEq(_moduleClaimable(stakingModule, user1), 0);
        assertEq(history.cumulativeRewards(user1), claimableBefore + 7);
    }

    function _moduleClaimable(address stakingModule, address account) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            stakingModule.staticcall(abi.encodeWithSignature("claimable(address,bytes)", account, ""));
        require(ok, "claimable failed");
        return abi.decode(ret, (uint256));
    }

    /// @dev Safety net: if the setup tx was skipped, the real plugin pulls old TEL from an unfunded history and reverts
    function testFork_recordRevertsWhenStubNotSet() public {
        assertEq(address(history.tanIssuancePlugin()), address(realPlugin));
        // precondition for the revert; guards against the history being funded on the fork block
        assertEq(oldTel.balanceOf(address(history)), 0);

        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](1);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, 100);
        uint256 endBlock = block.number;

        vm.prank(tanSafe);
        vm.expectRevert();
        history.increaseClaimableByBatch(rewards, endBlock);
    }
}
