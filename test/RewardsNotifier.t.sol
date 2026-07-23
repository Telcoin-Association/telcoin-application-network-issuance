// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { RewardsNotifier } from "../src/issuance/RewardsNotifier.sol";

/// @dev Minimal stand-in for TANIssuanceHistory exposing a settable
///      `lastSettlementBlock` (the notifier only reads that getter).
contract MockHistory {
    uint256 public lastSettlementBlock;

    function set(uint256 block_) external {
        lastSettlementBlock = block_;
    }
}

contract RewardsNotifierTest is Test {
    RewardsNotifier internal notifier;
    MockHistory internal history;

    address internal admin = address(0xA11CE);
    address internal stranger = address(0xBEEF);

    event RewardsSettled(
        uint256 indexed period, uint256 endBlock, uint256 totalRewards, address indexed settler
    );

    function setUp() public {
        history = new MockHistory();
        history.set(1000);
        notifier = new RewardsNotifier(admin, address(history));
    }

    function test_constructor_grantsRolesAndBindsHistory() public view {
        assertTrue(notifier.hasRole(notifier.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(notifier.hasRole(notifier.NOTIFIER_ROLE(), admin));
        assertEq(address(notifier.tanIssuanceHistory()), address(history));
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(bytes("admin is zero address"));
        new RewardsNotifier(address(0), address(history));
    }

    function test_constructor_revertsOnZeroHistory() public {
        vm.expectRevert(bytes("history is zero address"));
        new RewardsNotifier(admin, address(0));
    }

    /// endBlock matches lastSettlementBlock and caller holds NOTIFIER_ROLE.
    function test_notify_emitsWhenEndBlockMatches() public {
        vm.expectEmit(true, true, true, true, address(notifier));
        emit RewardsSettled(40, 1000, 12_345, admin);
        vm.prank(admin);
        notifier.notifyRewardsSettled(40, 1000, 12_345);
    }

    /// A mis-built batch reporting the wrong endBlock is rejected.
    function test_notify_revertsOnEndBlockMismatch() public {
        vm.prank(admin);
        vm.expectRevert(bytes("endBlock != lastSettlementBlock"));
        notifier.notifyRewardsSettled(40, 999, 12_345);
    }

    /// Callers without NOTIFIER_ROLE are rejected by AccessControl (endBlock
    /// here is valid, so only the role gate can trip).
    function test_notify_revertsForNonNotifier() public {
        // Cache the role before pranking: an external call in the expectRevert
        // argument would otherwise consume the prank, so the notify call would
        // run as the default sender instead of `stranger`.
        bytes32 role = notifier.NOTIFIER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        notifier.notifyRewardsSettled(40, 1000, 12_345);
    }
}
