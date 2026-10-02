// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { Checkpoints } from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import { Time } from "@openzeppelin/contracts/utils/types/Time.sol";
import { SafeERC20, IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ISimplePlugin } from "../interfaces/ISimplePlugin.sol";

/**
 * @title TANIssuanceHistory
 * @author Robriks 📯️📯️📯️.eth
 * @notice A Telcoin Contract
 *
 * @notice This contract persists historical information related to TAN Issuance onchain
 * The stored data is required for TAN Issuance rewards calculations, specifically rewards caps
 * It is designed to serve as the `increaser` for a V3 `SimplePlugin` registered on the sTEL
 * `StakingModule`, crediting rewards in the plugin's `rewardToken()`.
 *
 * @dev Lifecycle on a chain with a predecessor: deploy, become the plugin's increaser, seed carried-over
 * history with `backfillCumulativeRewards`, verify it, then `sealBackfill`. Settlement credits rewards
 * from the first block after the backfill onward.
 */
contract TANIssuanceHistory is Ownable2Step {
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
    error BackfillBlockMismatch(uint256 backfillBlock, uint256 atBlock);
    error ChunkAlreadySettled(bytes32 chunkId);
    error RenounceOwnershipDisabled();

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
    /// @dev Set by `sealBackfill`, and automatically by the first settlement that credits a non-zero amount
    bool public backfillSealed;

    /// @notice The block every backfilled checkpoint is keyed at, or zero if nothing has been backfilled
    /// @dev Fixed by the first backfill call. Crediting settlements must end strictly after it, so the
    /// seeded value stays readable at `backfillBlock` and the first credit lands on a later key.
    uint256 public backfillBlock;

    /// @notice Crediting settlement chunks already applied, keyed by `keccak256(abi.encode(rewards, endBlock))`
    /// @dev Several chunks may share an `endBlock`, so the block alone cannot tell a new chunk from a
    /// repeated one. Rejecting a repeated chunk stops an accidental re-execution from double crediting.
    mapping(bytes32 => bool) public settledChunks;

    /// @notice Emitted for each account whose carried-over reward history is set by a backfill
    event CumulativeRewardsBackfilled(address indexed account, uint256 amount, uint256 atBlock);

    /// @notice Emitted when the backfill path is permanently closed
    event BackfillSealed();

    /// @notice Emitted on every settlement, including one that only advances `lastSettlementBlock`
    event Settled(uint256 indexed endBlock, uint256 totalAmount, uint256 recipients);

    /// @notice Emitted when the owner points this contract at a different plugin
    event TanIssuancePluginUpdated(address indexed oldPlugin, address indexed newPlugin);

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

    /// @notice Returns the current cumulative rewards for an account
    function cumulativeRewards(address account) public view returns (uint256) {
        return _cumulativeRewards[account].latest();
    }

    /// @notice Returns the cumulative rewards for an account at the **end** of the supplied block
    /// @dev `queryBlock` is read literally, so zero means block zero. Reverts for a future block.
    function cumulativeRewardsAtBlock(address account, uint256 queryBlock) external view returns (uint256) {
        uint32 validatedBlock = _validateQueryBlock(queryBlock);
        return _cumulativeRewards[account].upperLookupRecent(validatedBlock);
    }

    /// @notice Returns the cumulative rewards for `accounts` at the **end** of the supplied block
    /// @dev Unlike `cumulativeRewardsAtBlock`, a `queryBlock` of zero means the current block
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
            validatedBlock = SafeCast.toUint32(block.number);
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

    /// @notice The active status of this contract is tethered to its designated plugin
    function deactivated() public view returns (bool) {
        return tanIssuancePlugin.deactivated();
    }

    /**
     * Writes
     */

    /**
     * @notice Saves the settlement block, updates cumulative rewards history, and settles TEL rewards on the plugin
     * @dev The contract must hold the sum of `rewards` amounts in the reward token when called; the plugin
     * pulls exactly that much, or receives it as `msg.value` on a native chain.
     *
     * An empty `rewards` array, or one whose amounts are all zero, advances `lastSettlementBlock` without
     * moving any TEL or calling the plugin, which is how a settlement gap is closed. `endBlock` may equal
     * `lastSettlementBlock` so that one period can be settled as several chunked transactions that all
     * carry the same end block. Zero-amount rows are skipped, mirroring the plugin.
     *
     * A settlement that credits anything must end after `backfillBlock`, is rejected if the identical
     * chunk was already applied, and seals the backfill.
     *
     * @param rewards Recipients and amounts, in the reward token's own decimals
     * @param endBlock Last block of the period being settled
     */
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

            // the plugin skips zero rows without crediting, so they carry no history either
            if (amount == 0) continue;

            totalAmount += amount;
            _incrementCumulativeRewards(account, amount, endBlock);
        }

        emit Settled(endBlock, totalAmount, len);

        // the plugin rejects an empty batch, and a settlement that credits nothing has nothing to fund,
        // so skip the plugin entirely rather than funding and calling into it
        if (totalAmount == 0) return;

        // a credit keyed at the backfill block would merge into the seeded checkpoint, hiding the seed
        // from a read at `backfillBlock - 1`
        if (endBlock <= backfillBlock) revert InvalidBlock(endBlock);

        bytes32 chunkId = keccak256(abi.encode(rewards, endBlock));
        if (settledChunks[chunkId]) revert ChunkAlreadySettled(chunkId);
        settledChunks[chunkId] = true;

        // Unsealed, every checkpoint on this contract is a backfill seed, which is what lets the backfill
        // restate a seed safely. A credit breaks that, so the first one closes the backfill for good.
        if (!backfillSealed) {
            backfillSealed = true;

            emit BackfillSealed();
        }

        // cache plugin in memory; either rail moves exactly `totalAmount` out of this contract
        ISimplePlugin plugin = tanIssuancePlugin;
        // the plugin emits a `ClaimableIncreased` event per credited account. It reverts on every failure
        // path; the bool is still checked since `setTanIssuancePlugin` can point at another implementation
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
    }

    /// @notice Points this contract at a different issuance plugin
    /// @dev Comparing the reward token also pins the funding rail, since a native plugin reports
    /// the native sentinel and an ERC20 plugin reports a token address
    function setTanIssuancePlugin(ISimplePlugin newPlugin) external onlyOwner {
        if (newPlugin.rewardToken() != tel) {
            revert IncompatiblePlugin();
        }

        emit TanIssuancePluginUpdated(address(tanIssuancePlugin), address(newPlugin));

        tanIssuancePlugin = newPlugin;
    }

    /**
     * @notice Sets carried-over reward history for accounts that accrued TAN rewards under a predecessor
     * @dev Owner-only, and disabled for good by `sealBackfill` or by the first settlement that credits a
     * non-zero amount. Until then every checkpoint on this contract is a seed written here, so a call sets
     * each account's seed to the given value: repeating a chunk is a no-op, and restating an account
     * corrects it. Verify every seed against the predecessor before sealing, since a sealed seed is final.
     *
     * The first call fixes `backfillBlock` to `atBlock` and moves `lastSettlementBlock` to it; every later
     * call must pass the same `atBlock`. `cumulativeRewardsAtBlock` therefore reports zero for any block
     * below `atBlock`, and the carried-over totals at or above it. To keep periods contiguous, `atBlock`
     * should be the predecessor's own `lastSettlementBlock`. Callers must supply `cumulativeAmounts` already
     * denominated in the reward token this contract settles in.
     *
     * @param accounts Accounts to seed, aligned with `cumulativeAmounts`
     * @param cumulativeAmounts Lifetime cumulative reward per account
     * @param atBlock Block the seeded checkpoints are keyed at
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

        uint256 seededAt = backfillBlock;
        if (seededAt == 0) {
            // zero is reserved to mean "not backfilled", and keys must not precede a gap already closed
            if (atBlock == 0 || atBlock < lastSettlementBlock || atBlock > block.number) revert InvalidBlock(atBlock);

            backfillBlock = atBlock;
            lastSettlementBlock = atBlock;
        } else if (atBlock != seededAt) {
            // one key for every chunk, so a mistyped block cannot split the seed across two keys
            revert BackfillBlockMismatch(seededAt, atBlock);
        }

        uint256 len = accounts.length;
        for (uint256 i; i < len; ++i) {
            address account = accounts[i];
            uint256 amount = cumulativeAmounts[i];

            // already holds this seed, which covers a retried chunk
            if (_cumulativeRewards[account].latest() == amount) continue;
            if (account == address(0x0)) revert InvalidAddress(account);

            // an unsealed account's only checkpoint is its seed at `atBlock`, so this pushes a new seed or
            // replaces the existing one in place
            _cumulativeRewards[account].push(SafeCast.toUint32(atBlock), SafeCast.toUint224(amount));

            emit CumulativeRewardsBackfilled(account, amount, atBlock);
        }
    }

    /// @notice Permanently closes the backfill path
    /// @dev One-way. Call once every seed has been verified against its source.
    function sealBackfill() external onlyOwner {
        if (backfillSealed) return;
        backfillSealed = true;

        emit BackfillSealed();
    }

    /// @notice Sends this contract's entire balance of `token` to `recipient`
    /// @dev Provide `address(0x0)`, not the native sentinel, to recover the native gas token. This sweeps
    /// reward funding staged for a settlement as well as stray transfers.
    function rescueTokens(IERC20 token, address recipient) external onlyOwner {
        if (recipient == address(0x0)) revert InvalidAddress(recipient);

        if (address(token) == address(0x0)) {
            uint256 bal = address(this).balance;
            (bool r,) = recipient.call{ value: bal }("");
            if (!r) revert InvalidAddress(recipient);
        } else {
            token.safeTransfer(recipient, token.balanceOf(address(this)));
        }
    }

    /// @notice Ownership is the only path to settlement and to `rescueTokens`, so it cannot be given up
    function renounceOwnership() public view override onlyOwner {
        revert RenounceOwnershipDisabled();
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

    /// @dev Validate that user-supplied block is not in the future, and return it as a uint32.
    function _validateQueryBlock(uint256 queryBlock) internal view returns (uint32) {
        uint48 currentBlock = clock();
        if (queryBlock > currentBlock) revert FutureLookup(queryBlock, currentBlock);
        return SafeCast.toUint32(queryBlock);
    }

    function _cumulativeRewardsAtBlock(address account, uint32 queryBlock) internal view returns (uint256) {
        return _cumulativeRewards[account].upperLookupRecent(queryBlock);
    }
}
