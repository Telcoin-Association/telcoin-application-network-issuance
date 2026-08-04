// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { Checkpoints } from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import { Time } from "@openzeppelin/contracts/utils/types/Time.sol";
import { SafeERC20, IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ISimplePlugin } from "../interfaces/ISimplePlugin.sol";

/**
 * @title TANIssuanceHistory
 * @author Robriks 📯️📯️📯️.eth
 * @notice A Telcoin Contract
 *
 * @notice This contract persists historical information related to TAN Issuance onchain
 * The stored data is required for TAN Issuance rewards calculations, specifically rewards caps
 * It is designed to serve as the `increaser` for a Telcoin `SimplePlugin` module
 * which is attached to the canonical TEL `StakingModule` contract.
 */
contract TANIssuanceHistory is Ownable {
    using Checkpoints for Checkpoints.Trace224;
    using SafeERC20 for IERC20;

    error ERC6372InconsistentClock();
    error IncompatiblePlugin();
    error InvalidAddress(address invalidAddress);
    error InvalidBlock(uint256 endBlock);
    error FutureLookup(uint256 queriedBlock, uint48 clockBlock);
    error IncreaseClaimableByBatchFailed();
    error UnexpectedNative();
    error BackfillIsSealed();
    error BackfillLengthMismatch(uint256 accountsLength, uint256 amountsLength);

    struct IssuanceReward {
        address account;
        uint256 amount;
    }

    /// @dev Sentinel a plugin reports from `rewardToken()` when it pays rewards in the chain's
    /// native asset, which is how TEL presents itself on a chain where it is the gas token.
    address private constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    ISimplePlugin public tanIssuancePlugin;

    /// @notice The reward token this contract settles in: an ERC20 address, or `NATIVE_TOKEN` on a
    /// chain where TEL is native.
    address public immutable tel;

    /// @notice Whether `tel` is the chain's native asset rather than an ERC20.
    /// @dev Fixed at construction from the plugin's `rewardToken()`, and decides which funding rail
    /// settlement uses: native is forwarded as `msg.value`, ERC20 is approved and pulled.
    bool public immutable telIsNative;

    mapping(address => Checkpoints.Trace224) private _cumulativeRewards;

    uint256 public lastSettlementBlock;

    /// @notice Once true, `backfillCumulativeRewards` is permanently disabled
    /// @dev Set by `sealBackfill`, and automatically by the first settlement that credits anyone
    bool public backfillSealed;

    /// @notice Emitted when users' (temporarily mocked) claimable rewards are increased
    event ClaimableIncreased(address indexed account, uint256 oldClaimable, uint256 newClaimable);

    /// @notice Emitted for each account seeded with reward history carried over from a predecessor
    event CumulativeRewardsBackfilled(address indexed account, uint256 amount, uint256 atBlock);

    /// @notice Emitted when the backfill path is permanently closed
    event BackfillSealed();

    constructor(ISimplePlugin tanIssuancePlugin_, address owner_) Ownable(owner_) {
        tanIssuancePlugin = tanIssuancePlugin_;

        address rewardToken = tanIssuancePlugin_.rewardToken();
        // a plugin reporting no reward token at all is misconfigured, whichever rail it uses
        if (rewardToken == address(0x0)) revert InvalidAddress(rewardToken);

        tel = rewardToken;
        telIsNative = rewardToken == NATIVE_TOKEN;
    }

    /// @notice Accepts the native reward funding that settlement forwards to the plugin
    /// @dev Only meaningful when TEL is the chain's native asset. On an ERC20 deployment there is no
    /// reason for native to arrive here, so it is refused rather than silently accumulated.
    receive() external payable {
        if (!telIsNative) revert UnexpectedNative();
    }

    /**
     * Views
     */

    /// @dev Returns the current cumulative rewards for an account
    function cumulativeRewards(address account) public view returns (uint256) {
        return _cumulativeRewards[account].latest();
    }

    /// @dev Returns the cumulative rewards for an account at the **end** of the supplied block
    function cumulativeRewardsAtBlock(address account, uint256 queryBlock) external view returns (uint256) {
        uint32 validatedBlock = _validateQueryBlock(queryBlock);
        return _cumulativeRewards[account].upperLookupRecent(validatedBlock);
    }

    /// @dev Returns the cumulative rewards for `accounts` at the **end** of the supplied block
    /// @notice To query for the current block, supply `queryBlock == 0`
    function cumulativeRewardsAtBlockBatched(
        address[] calldata accounts,
        uint256 queryBlock
    )
        external
        view
        returns (address[] memory, uint256[] memory)
    {
        uint32 validatedBlock;
        if (queryBlock == 0) {
            // no need for safecast when dealing with global block number variable
            validatedBlock = uint32(block.number);
        } else {
            validatedBlock = _validateQueryBlock(queryBlock);
        }

        uint256 len = accounts.length;
        uint256[] memory rewards = new uint256[](accounts.length);
        for (uint256 i; i < len; ++i) {
            rewards[i] = _cumulativeRewardsAtBlock(accounts[i], validatedBlock);
        }

        return (accounts, rewards);
    }

    /// @dev The active status of this contract is tethered to its designated plugin
    function deactivated() public view returns (bool) {
        return tanIssuancePlugin.deactivated();
    }

    /**
     * Writes
     */

    /// @dev Saves the settlement block, updates cumulative rewards history, and settles TEL rewards on the plugin
    /// @notice An empty `rewards` array advances `lastSettlementBlock` without moving any TEL, which is how a
    /// settlement gap is closed. `endBlock` may equal `lastSettlementBlock` so that one period can be settled as
    /// several chunked transactions that all carry the same end block.
    function increaseClaimableByBatch(IssuanceReward[] calldata rewards, uint256 endBlock) external onlyOwner {
        // ensure temporal ordering of reward settlements
        if (endBlock < lastSettlementBlock || endBlock > block.number) revert InvalidBlock(endBlock);
        lastSettlementBlock = endBlock;

        uint256 totalAmount = 0;
        uint256 len = rewards.length;
        // the plugin credits parallel arrays, so unpack the structs while accumulating history
        address[] memory accounts = new address[](len);
        uint256[] memory amounts = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            address account = rewards[i].account;
            uint256 amount = rewards[i].amount;

            accounts[i] = account;
            amounts[i] = amount;

            totalAmount += amount;
            _incrementCumulativeRewards(account, amount, endBlock);
        }

        // the plugin rejects an empty batch, and a settlement with no recipients has nothing to fund,
        // so skip the plugin entirely rather than funding and calling into it
        if (len != 0) {
            // cache plugin in memory; either rail moves exactly `totalAmount` out of this contract
            ISimplePlugin plugin = tanIssuancePlugin;
            // event emission on this contract is omitted since the plugin emits a `ClaimableIncreased`
            // event per credited account. The plugin reverts on every failure path; the bool is a
            // vestigial success signal that is checked anyway.
            bool success;
            if (telIsNative) {
                // native rewards are funded by the call itself, so no approval is involved
                success = plugin.increaseClaimableByBatch{ value: totalAmount }(accounts, amounts, totalAmount);
            } else {
                // set approval as the plugin pulls `totalAmount` from this address
                IERC20(tel).forceApprove(address(plugin), totalAmount);
                success = plugin.increaseClaimableByBatch(accounts, amounts, totalAmount);
                // a conforming plugin consumes the allowance exactly; clearing it regardless means a
                // plugin that under-pulls cannot leave a standing claim on this contract's balance
                IERC20(tel).forceApprove(address(plugin), 0);
            }
            if (!success) revert IncreaseClaimableByBatchFailed();

            // Settling creates history, and `backfillCumulativeRewards` skips any account that already
            // carries history. Were a backfill to run after this point it would silently drop every
            // account settled in the interim, overstating their reward caps for good, so the first
            // settlement closes the backfill permanently.
            if (!backfillSealed) {
                backfillSealed = true;

                emit BackfillSealed();
            }
        }
    }

    /// @dev Permissioned function to set a new issuance plugin
    /// @notice Comparing the reward token also pins the funding rail, since a native plugin reports
    /// the native sentinel and an ERC20 plugin reports a token address
    function setTanIssuancePlugin(ISimplePlugin newPlugin) external onlyOwner {
        if (newPlugin.rewardToken() != tel) {
            revert IncompatiblePlugin();
        }
        tanIssuancePlugin = newPlugin;
    }

    /**
     * @notice Seeds reward history for accounts that accrued TAN rewards under a predecessor contract
     * @dev Owner-only, and disabled for good by `sealBackfill` or by the first settlement that credits
     * anyone. An account that already carries history is skipped rather than overwritten, so a backfill
     * split across several transactions can be retried safely without double counting. That skip is also
     * why settlement closes this path: an account settled midway through a chunked backfill would be
     * skipped by the remaining chunks and lose its carried-over history silently.
     *
     * Every entry is written at the single key `atBlock`, which becomes the new `lastSettlementBlock`.
     * `cumulativeRewardsAtBlock` therefore reports zero for any block below `atBlock`; queries at or above
     * it return the carried-over totals. Callers must supply `cumulativeAmounts` already denominated in the
     * reward token this contract settles in.
     *
     * @param accounts Accounts to seed, aligned with `cumulativeAmounts`
     * @param cumulativeAmounts Lifetime cumulative reward per account. A zero entry is skipped.
     * @param atBlock Block the seeded checkpoints are keyed at. Must not precede `lastSettlementBlock`.
     */
    function backfillCumulativeRewards(
        address[] calldata accounts,
        uint256[] calldata cumulativeAmounts,
        uint256 atBlock
    )
        external
        onlyOwner
    {
        if (backfillSealed) revert BackfillIsSealed();
        if (accounts.length != cumulativeAmounts.length) {
            revert BackfillLengthMismatch(accounts.length, cumulativeAmounts.length);
        }
        // keep checkpoint keys ordered against any settlement that already landed
        if (atBlock < lastSettlementBlock || atBlock > block.number) revert InvalidBlock(atBlock);

        uint256 len = accounts.length;
        for (uint256 i; i < len; ++i) {
            uint256 amount = cumulativeAmounts[i];
            if (amount == 0) continue;

            address account = accounts[i];
            if (account == address(0x0)) revert InvalidAddress(account);
            // an account with existing history is authoritative and is never overwritten
            if (_cumulativeRewards[account].latest() != 0) continue;

            _cumulativeRewards[account].push(SafeCast.toUint32(atBlock), SafeCast.toUint224(amount));

            emit CumulativeRewardsBackfilled(account, amount, atBlock);
        }

        lastSettlementBlock = atBlock;
    }

    /// @notice Permanently closes the backfill path
    /// @dev One-way. Call once the seeded history has been reconciled against its source.
    function sealBackfill() external onlyOwner {
        backfillSealed = true;

        emit BackfillSealed();
    }

    /// @notice Rescues any tokens stuck on this contract
    /// @dev Provide `address(0x0)` to recover native gas token
    function rescueTokens(IERC20 token, address recipient) external onlyOwner {
        if (address(token) == address(0x0)) {
            uint256 bal = address(this).balance;
            (bool r,) = recipient.call{ value: bal }("");
            if (!r) revert InvalidAddress(recipient);
        } else {
            // for other ERC20 tokens, any tokens owned by this address are accidental; send the full balance.
            token.safeTransfer(recipient, token.balanceOf(address(this)));
        }
    }

    /**
     * ERC6372
     */
    function clock() public view returns (uint48) {
        return Time.blockNumber();
    }

    function CLOCK_MODE() public view returns (string memory) {
        if (clock() != Time.blockNumber()) {
            revert ERC6372InconsistentClock();
        }
        return "mode=blocknumber&from=default";
    }

    /**
     * Internals
     */
    function _incrementCumulativeRewards(address account, uint256 amount, uint256 endBlock) internal {
        uint256 prevCumulativeReward = cumulativeRewards(account);
        uint224 newCumulativeReward = SafeCast.toUint224(prevCumulativeReward + amount);

        _cumulativeRewards[account].push(SafeCast.toUint32(endBlock), newCumulativeReward);
    }

    /// @dev Validate that user-supplied block is in the past, and return it as a uint48.
    function _validateQueryBlock(uint256 queryBlock) internal view returns (uint32) {
        uint48 currentBlock = clock();
        if (queryBlock > currentBlock) revert FutureLookup(queryBlock, currentBlock);
        return SafeCast.toUint32(queryBlock);
    }

    function _cumulativeRewardsAtBlock(address account, uint32 queryBlock) internal view returns (uint256) {
        return _cumulativeRewards[account].upperLookupRecent(queryBlock);
    }
}
