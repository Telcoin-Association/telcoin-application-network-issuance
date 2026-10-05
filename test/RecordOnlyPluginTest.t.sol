// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "../src/issuance/TANIssuanceHistory.sol";
import "../src/issuance/RecordOnlyPlugin.sol";
import "../src/interfaces/ISimplePlugin.sol";
import "./mocks/MockImplementations.sol";

contract RecordOnlyPluginTest is Test {
    MockTel oldTel;
    MockPlugin realPlugin;
    TANIssuanceHistory history;
    RecordOnlyPlugin stub;

    address owner = address(0x123);
    address user1 = address(0x456);
    address user2 = address(0x789);

    event RewardRecorded(address indexed account, uint256 amount);

    function setUp() public {
        oldTel = new MockTel("Telcoin", "TEL");
        realPlugin = new MockPlugin(IERC20(address(oldTel)));
        history = new TANIssuanceHistory(ISimplePlugin(address(realPlugin)), owner);
        stub = new RecordOnlyPlugin(IERC20(address(oldTel)), address(history));
    }

    function _rewards(uint256 amount1, uint256 amount2)
        internal
        view
        returns (TANIssuanceHistory.IssuanceReward[] memory rewards)
    {
        rewards = new TANIssuanceHistory.IssuanceReward[](2);
        rewards[0] = TANIssuanceHistory.IssuanceReward(user1, amount1);
        rewards[1] = TANIssuanceHistory.IssuanceReward(user2, amount2);
    }

    function _useStub() internal {
        vm.prank(owner);
        history.setTanIssuancePlugin(ISimplePlugin(address(stub)));
    }

    function test_constructor_revertsOnZeroAddresses() public {
        vm.expectRevert(abi.encodeWithSelector(RecordOnlyPlugin.InvalidAddress.selector, address(0)));
        new RecordOnlyPlugin(IERC20(address(0)), address(history));

        vm.expectRevert(abi.encodeWithSelector(RecordOnlyPlugin.InvalidAddress.selector, address(0)));
        new RecordOnlyPlugin(IERC20(address(oldTel)), address(0));
    }

    function test_views() public view {
        assertEq(address(stub.tel()), address(oldTel));
        assertEq(stub.increaser(), address(history));
        assertEq(stub.totalClaimable(), 0);
        assertFalse(stub.deactivated());
    }

    /// @dev Pins the id the off-chain setup preflight queries (`ISIMPLE_PLUGIN_INTERFACE_ID`)
    function test_interfaceId_matchesBuilderConstant() public pure {
        assertEq(type(ISimplePlugin).interfaceId, bytes4(0xdc8646c1));
    }

    function test_supportsInterface() public view {
        assertTrue(stub.supportsInterface(type(ISimplePlugin).interfaceId));
        assertTrue(stub.supportsInterface(type(IERC165).interfaceId));
        assertFalse(stub.supportsInterface(0xdeadbeef));
    }

    function test_increaseClaimableBy_revertsForNonIncreaser() public {
        vm.expectRevert(abi.encodeWithSelector(RecordOnlyPlugin.OnlyIncreaser.selector, address(this)));
        stub.increaseClaimableBy(user1, 100);
    }

    function test_increaseClaimableBy_emitsAndReturnsTrueWithoutMovingTokens() public {
        oldTel.mint(address(history), 1000);

        vm.expectEmit(true, false, false, true, address(stub));
        emit RewardRecorded(user1, 100);
        vm.prank(address(history));
        assertTrue(stub.increaseClaimableBy(user1, 100));

        assertEq(oldTel.balanceOf(address(history)), 1000);
        assertEq(oldTel.balanceOf(address(stub)), 0);
        assertEq(oldTel.balanceOf(user1), 0);
    }

    function test_setTanIssuancePlugin_acceptsStubBoundToHistoryToken() public {
        _useStub();
        assertEq(address(history.tanIssuancePlugin()), address(stub));
    }

    function test_setTanIssuancePlugin_rejectsStubBoundToOtherToken() public {
        MockTel otherTel = new MockTel("New Telcoin", "TEL");
        RecordOnlyPlugin wrongStub = new RecordOnlyPlugin(IERC20(address(otherTel)), address(history));

        vm.prank(owner);
        vm.expectRevert(TANIssuanceHistory.IncompatiblePlugin.selector);
        history.setTanIssuancePlugin(ISimplePlugin(address(wrongStub)));
    }

    /// @dev The history holds no TEL: recording must succeed without any token movement
    function test_increaseClaimableByBatch_recordsWithoutFunding() public {
        _useStub();
        uint256 endBlock = block.number;

        vm.expectEmit(true, false, false, true, address(stub));
        emit RewardRecorded(user1, 150);
        vm.expectEmit(true, false, false, true, address(stub));
        emit RewardRecorded(user2, 275);
        vm.prank(owner);
        history.increaseClaimableByBatch(_rewards(150, 275), endBlock);

        assertEq(history.cumulativeRewards(user1), 150);
        assertEq(history.cumulativeRewards(user2), 275);
        assertEq(history.lastSettlementBlock(), endBlock);
        assertEq(oldTel.balanceOf(address(history)), 0);
        assertEq(oldTel.balanceOf(address(stub)), 0);
        assertEq(realPlugin.claimable(user1), 0);
        assertEq(realPlugin.claimable(user2), 0);
    }

    /// @dev Chunked settlements reuse the same `endBlock`; cumulative values must add up
    function test_increaseClaimableByBatch_chunksWithSameEndBlockAccumulate() public {
        _useStub();
        uint256 endBlock = block.number;

        vm.startPrank(owner);
        history.increaseClaimableByBatch(_rewards(100, 200), endBlock);
        history.increaseClaimableByBatch(_rewards(1, 2), endBlock);
        vm.stopPrank();

        assertEq(history.cumulativeRewards(user1), 101);
        assertEq(history.cumulativeRewards(user2), 202);
    }

    /// @dev Rewards recorded via the real plugin before the switch carry over into the stub era
    function test_cumulativeRewards_continueAcrossPluginSwitch() public {
        vm.roll(10);
        oldTel.mint(address(history), 100);
        vm.prank(owner);
        history.increaseClaimableByBatch(_rewards(60, 40), 10);
        assertEq(realPlugin.claimable(user1), 60);

        _useStub();
        vm.roll(20);
        vm.prank(owner);
        history.increaseClaimableByBatch(_rewards(5, 7), 20);

        assertEq(history.cumulativeRewardsAtBlock(user1, 15), 60);
        assertEq(history.cumulativeRewardsAtBlock(user1, 20), 65);
        assertEq(history.cumulativeRewardsAtBlock(user2, 20), 47);
        // real plugin claimables untouched by stub-era settlements
        assertEq(realPlugin.claimable(user1), 60);
        assertEq(realPlugin.claimable(user2), 40);
    }

    function test_setTanIssuancePlugin_switchBackToRealPlugin() public {
        _useStub();
        vm.prank(owner);
        history.setTanIssuancePlugin(ISimplePlugin(address(realPlugin)));
        assertEq(address(history.tanIssuancePlugin()), address(realPlugin));
    }

    function testFuzz_increaseClaimableByBatch_cumulativeMatchesSum(uint128 a, uint128 b, uint128 c) public {
        _useStub();
        uint256 endBlock = block.number;

        vm.startPrank(owner);
        history.increaseClaimableByBatch(_rewards(a, b), endBlock);
        history.increaseClaimableByBatch(_rewards(c, 0), endBlock);
        vm.stopPrank();

        assertEq(history.cumulativeRewards(user1), uint256(a) + c);
        assertEq(history.cumulativeRewards(user2), b);
    }
}
