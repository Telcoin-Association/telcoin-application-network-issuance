// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.26;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

interface ITANIssuanceHistory {
    function lastSettlementBlock() external view returns (uint256);
}

/**
 * @title RewardsNotifier
 * @notice Emits a public on-chain event each time a rewards period is settled.
 *
 * @dev Exists solely because the TAO Safe executes settlements as a multisig
 *      transaction, which does not emit a standard event that downstream
 *      observers (community dashboards, keepers, notification bots) can
 *      subscribe to cheaply. This contract provides that signal.
 *
 *      The notifier is intentionally stateless — it holds no funds and stores
 *      no state. The only effect of calling `notifyRewardsSettled` is the
 *      emitted event.
 *
 *      AccessControl is used instead of Ownable so that multiple callers can
 *      hold NOTIFIER_ROLE if needed (e.g., the TAO Safe plus a future
 *      keeper) without changing ownership semantics.
 *
 * Deployment:
 *   - Deploy once per chain where TAN rewards are settled (currently Polygon).
 *   - Grant DEFAULT_ADMIN_ROLE to the TAO Safe (or a governance address).
 *   - Grant NOTIFIER_ROLE to the TAO Safe so it can call the function as
 *     part of the settlement batch.
 *   - Record the deployed address in deployments/deployments.json.
 *
 * Safe batch order (TANIP-1 settlement):
 *   1. TEL.approve(TANIssuanceHistory, totalRewards)
 *   2. TANIssuanceHistory.increaseClaimableByBatch(issuanceRewards[], endBlock)
 *   3. RewardsNotifier.notifyRewardsSettled(period, endBlock, totalRewards)
 */
contract RewardsNotifier is AccessControl {
    bytes32 public constant NOTIFIER_ROLE = keccak256("NOTIFIER_ROLE");

    /**
     * @notice Emitted when a rewards period is settled on chain.
     * @param period       The TANIP-1 period number that was settled.
     * @param endBlock     The block at which the settled epoch closed.
     * @param totalRewards Total TEL (in raw EVM units, no decimals applied)
     *                     distributed in this period.
     * @param settler      The address that called `notifyRewardsSettled`
     *                     (the TAO Safe).
     */
    event RewardsSettled(
        uint256 indexed period,
        uint256 endBlock,
        uint256 totalRewards,
        address indexed settler
    );

    /// @notice The TANIssuanceHistory whose `lastSettlementBlock` must equal a
    ///         reported `endBlock`. Set once at deployment.
    ITANIssuanceHistory public immutable tanIssuanceHistory;

    /**
     * @param admin Address that receives DEFAULT_ADMIN_ROLE and NOTIFIER_ROLE.
     *              Pass the TAO Safe address on deployment.
     * @param tanIssuanceHistory_ The TANIssuanceHistory used to settle TANIP-1
     *              rewards. `notifyRewardsSettled` asserts the reported endBlock
     *              matches its `lastSettlementBlock`, so a mis-built batch cannot
     *              emit a wrong endBlock.
     */
    constructor(address admin, address tanIssuanceHistory_) {
        require(admin != address(0), "admin is zero address");
        require(tanIssuanceHistory_ != address(0), "history is zero address");
        tanIssuanceHistory = ITANIssuanceHistory(tanIssuanceHistory_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(NOTIFIER_ROLE, admin);
    }

    /**
     * @notice Records that a TANIP-1 rewards period has been settled.
     * @dev    Call this as the final step in the Safe settlement batch, after
     *         `TANIssuanceHistory.increaseClaimableByBatch` succeeds.
     * @param period       TANIP-1 period number (e.g., 38).
     * @param endBlock     The `endBlock` passed to `increaseClaimableByBatch`.
     * @param totalRewards Sum of all `IssuanceReward.amount` values in the
     *                     batch, in raw EVM units (TEL × 10^2 per the TANIP-1
     *                     calculator output; match what was passed on chain).
     *
     * Reverts if `endBlock` does not equal the TANIssuanceHistory's current
     * `lastSettlementBlock`. Because `increaseClaimableByBatch` sets that value
     * to `endBlock` earlier in the same Safe batch, the check passes for a
     * correctly-built batch and rejects a mismatched `endBlock`.
     */
    function notifyRewardsSettled(
        uint256 period,
        uint256 endBlock,
        uint256 totalRewards
    ) external onlyRole(NOTIFIER_ROLE) {
        require(
            endBlock == tanIssuanceHistory.lastSettlementBlock(),
            "endBlock != lastSettlementBlock"
        );
        emit RewardsSettled(period, endBlock, totalRewards, msg.sender);
    }
}
