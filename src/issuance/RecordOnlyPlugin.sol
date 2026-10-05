// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { ISimplePlugin } from "../interfaces/ISimplePlugin.sol";

/**
 * @title RecordOnlyPlugin
 * @notice Stand-in `tanIssuancePlugin` for `TANIssuanceHistory` after the TEL token migration.
 * The history contract keeps recording cumulative rewards in old-TEL (2 decimal) units for stake-cap
 * accounting, while the rewards themselves are paid in new TEL directly to wallets in the same Safe batch.
 * @dev Reports the old TEL as `tel()` to satisfy `TANIssuanceHistory::setTanIssuancePlugin()`.
 * `increaseClaimableBy()` moves no tokens, so the history contract never needs to hold old TEL.
 * The old-TEL allowance the history grants this contract is never spent.
 */
contract RecordOnlyPlugin is ISimplePlugin {
    error InvalidAddress(address invalidAddress);
    error OnlyIncreaser(address caller);

    event RewardRecorded(address indexed account, uint256 amount);

    IERC20 public immutable tel;
    address public immutable increaser;

    constructor(IERC20 tel_, address increaser_) {
        if (address(tel_) == address(0x0)) revert InvalidAddress(address(tel_));
        if (increaser_ == address(0x0)) revert InvalidAddress(increaser_);

        tel = tel_;
        increaser = increaser_;
    }

    function increaseClaimableBy(address account, uint256 amount) external returns (bool) {
        if (msg.sender != increaser) revert OnlyIncreaser(msg.sender);

        emit RewardRecorded(account, amount);
        return true;
    }

    function totalClaimable() external pure returns (uint256) {
        return 0;
    }

    function deactivated() external pure returns (bool) {
        return false;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(ISimplePlugin).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
