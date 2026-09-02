// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeERC20, IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Checkpoints } from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "../../src/interfaces/ISimplePlugin.sol";

/// @title Mock contracts for TANIssuanceHistory integration testing. Do NOT use any in production

/// @notice This contract is deployed onchain for testing as no testing AmirX existed
contract MockAmirX is Ownable {
    struct DefiSwap {
        // Address for fee deposit
        address defiSafe;
        // Address of the swap aggregator or router
        address aggregator;
        // Plugin for handling referral fees
        ISimplePlugin plugin;
        // Token collected as fees
        IERC20 feeToken;
        // Address to receive referral fees
        address referrer;
        // Amount of referral fee
        uint256 referralFee;
        // Data for wallet interaction, if any
        bytes walletData;
        // Data for performing the swap, if any
        bytes swapData;
    }

    event Transfer(address from, address to, uint256 value);

    IERC20 public immutable tel;

    address public immutable defiAggIntermediary;

    constructor(IERC20 tel_, address owner_, address defiAggIntermediary_) Ownable(owner_) {
        tel = tel_;
        defiAggIntermediary = defiAggIntermediary_;
    }

    /// @param '' Unused address param included to match canonical AmirX::defiSwap selector
    function defiSwap(address, DefiSwap memory defi) external payable onlyOwner {
        /// @notice the `DefiSwap.referralFee` actually refers to a separate referral program than this one
        /// but it is used here for simplicity
        tel.transferFrom(defiAggIntermediary, address(this), defi.referralFee);
    }

    fallback() external { }
}

/// @notice This contract did not need to be deployed for testing as one already exists
contract MockTel is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) { }

    /// @notice Unprotected for simplicity
    function mint(address to, uint256 value) public {
        _mint(to, value);
    }
}

/// @notice This contract did not need to be deployed for testing as one already exists
/// @dev Mirrors the parts of the V3 `StakingModule` that reward tooling reads: sTEL is an
/// `ERC20Votes` token, so per-account stake history is exposed as vote checkpoints keyed by block
/// number. `Checkpoints.Trace208` is the same structure `ERC20VotesUpgradeable` uses, so
/// `numCheckpoints` / `checkpoints` / `getPastVotes` behave as they do onchain.
contract MockStakingModule {
    using Checkpoints for Checkpoints.Trace208;

    error FutureLookup(uint256 queriedBlock, uint256 currentBlock);
    error InsufficientStake(uint256 requested, uint256 available);

    event DelegateVotesChanged(address indexed delegate, uint256 previousVotes, uint256 newVotes);

    mapping(address => Checkpoints.Trace208) private _votes;

    function stake(uint256 amount) external {
        _moveVotes(msg.sender, _votes[msg.sender].latest() + amount);
    }

    function unstake(uint256 amount) external {
        uint256 current = _votes[msg.sender].latest();
        if (amount > current) revert InsufficientStake(amount, current);

        _moveVotes(msg.sender, current - amount);
    }

    function numCheckpoints(address account) external view returns (uint32) {
        return SafeCast.toUint32(_votes[account].length());
    }

    function checkpoints(address account, uint32 pos) external view returns (Checkpoints.Checkpoint208 memory) {
        return _votes[account].at(pos);
    }

    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256) {
        // matches `Votes.getPastVotes`, which only answers for finalized blocks
        if (blockNumber >= block.number) revert FutureLookup(blockNumber, block.number);

        return _votes[account].upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    function balanceOf(address account) external view returns (uint256) {
        return _votes[account].latest();
    }

    function _moveVotes(address account, uint256 newVotes) private {
        uint256 previousVotes = _votes[account].latest();
        _votes[account].push(SafeCast.toUint48(block.number), SafeCast.toUint208(newVotes));

        emit DelegateVotesChanged(account, previousVotes, newVotes);
    }
}

/// @notice  This contract did not need to be deployed for testing as one already exists
/// @dev Reproduces the V3 `SimplePlugin` funding semantics that `TANIssuanceHistory` relies on,
/// including the single pull of `totalAmount` and every revert the batch path can raise.
contract MockPlugin is ISimplePlugin {
    using SafeERC20 for IERC20;

    error Deactivated();
    error BatchLengthMismatch(uint256 accountsLength, uint256 amountsLength);
    error EmptyBatch();
    error BatchTotalMismatch(uint256 declaredTotal, uint256 summedAmounts);
    error ZeroAddress();
    error MsgValueMismatch(uint256 expected, uint256 actual);
    error UnexpectedMsgValue();

    event ClaimableIncreased(address indexed account, uint256 amount);

    address public constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    bool public deactivated;
    address public immutable rewardToken;
    uint256 public totalClaimable;
    mapping(address => uint256) public claimable;

    constructor(IERC20 tel_) {
        rewardToken = address(tel_);
    }

    /// @dev A plugin paying the chain's native asset is funded by `msg.value` rather than a pull.
    function isNative() public view returns (bool) {
        return rewardToken == NATIVE_TOKEN;
    }

    function setDeactivated(bool newVal) external {
        deactivated = newVal;
    }

    function increaseClaimableBy(address account, uint256 amount) external payable override returns (bool) {
        if (deactivated) revert Deactivated();
        if (amount == 0) return false;
        if (account == address(0x0)) revert ZeroAddress();

        claimable[account] += amount;
        totalClaimable += amount;
        _receiveFunding(amount);

        emit ClaimableIncreased(account, amount);
        return true;
    }

    function increaseClaimableByBatch(
        address[] calldata accounts,
        uint256[] calldata amounts,
        uint256 totalAmount
    )
        external
        payable
        override
        returns (bool)
    {
        if (deactivated) revert Deactivated();

        uint256 len = accounts.length;
        if (len != amounts.length) revert BatchLengthMismatch(len, amounts.length);
        if (len == 0) revert EmptyBatch();

        uint256 summed;
        for (uint256 i; i < len; ++i) {
            uint256 amount = amounts[i];
            if (amount == 0) continue;

            address account = accounts[i];
            if (account == address(0x0)) revert ZeroAddress();

            claimable[account] += amount;
            summed += amount;

            emit ClaimableIncreased(account, amount);
        }

        if (summed != totalAmount) revert BatchTotalMismatch(totalAmount, summed);
        totalClaimable += totalAmount;

        _receiveFunding(totalAmount);

        return true;
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }

    /// @dev Native funding arrives with the call; ERC20 funding is pulled from the caller.
    function _receiveFunding(uint256 amount) private {
        if (isNative()) {
            if (msg.value != amount) revert MsgValueMismatch(amount, msg.value);
        } else {
            if (msg.value != 0) revert UnexpectedMsgValue();
            if (amount > 0) {
                IERC20(rewardToken).safeTransferFrom(msg.sender, address(this), amount);
            }
        }
    }
}
