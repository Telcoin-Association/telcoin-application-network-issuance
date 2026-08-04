// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title ISimplePlugin
 * @notice The subset of the V3 `SimplePlugin` surface that `TANIssuanceHistory` depends on.
 *
 * @dev `increaseClaimableBy` and `increaseClaimableByBatch` are `payable` because a plugin may pay
 * rewards in the chain's native asset, in which case it is funded through `msg.value`. TAN issuance
 * settles in TEL, so every call this repo makes passes zero value; `TANIssuanceHistory` rejects a
 * native-reward plugin outright.
 *
 * `rewardToken()` returns either an ERC-20 address or the native sentinel
 * `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`.
 */
interface ISimplePlugin is IERC165 {
    /// @notice Credit a single `account` by `amount`, funded by one inbound transfer.
    function increaseClaimableBy(address account, uint256 amount) external payable returns (bool);

    /**
     * @notice Credit many `accounts` by `amounts` from a single transfer of `totalAmount`.
     * @dev `totalAmount` must equal the sum of `amounts`; the plugin reverts otherwise. Rows with a
     * zero amount are skipped. An empty batch reverts, so callers must guard on length.
     */
    function increaseClaimableByBatch(
        address[] calldata accounts,
        uint256[] calldata amounts,
        uint256 totalAmount
    )
        external
        payable
        returns (bool);

    /// @notice The token this plugin pays rewards in, or the native sentinel.
    function rewardToken() external view returns (address);

    function totalClaimable() external view returns (uint256);

    function deactivated() external view returns (bool);
}
