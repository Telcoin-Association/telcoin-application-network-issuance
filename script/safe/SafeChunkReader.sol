// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { Vm } from "forge-std/Vm.sol";
import { TANIssuanceHistory } from "../../src/issuance/TANIssuanceHistory.sol";

/**
 * @notice Reads the Safe parameter chunks the backend emits into calldata arguments.
 *
 * @dev The backend writes these files for the Safe UI, where a transaction's arguments are pasted in
 * positionally. That gives two shapes, one per call being built:
 *
 *   `backfillCumulativeRewards(address[], uint256[], uint256)` takes parallel arrays, so
 *   `buildBackfill.ts` writes them as two columns: `[[account, ...], [amount, ...]]`.
 *
 *   `increaseClaimableByBatch((address,uint256)[], uint256)` takes an array of tuples, so
 *   `safeTxArrayBuilder.ts` writes them as rows: `[[account, amount], ...]`.
 *
 * Amounts are strings in both, because an 18-decimal TEL amount exceeds what a JSON number holds
 * exactly. Foundry cannot bulk-decode either nested shape into a Solidity type, so both are read
 * index by index, and every row is parsed strictly so a malformed file fails rather than being read
 * short.
 *
 * Reading the files the backend already produces, rather than a format invented for these scripts,
 * means a proposal is built from the same bytes a reviewer pastes into the Safe UI.
 */
library SafeChunkReader {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev The backfill chunk size `buildBackfill.ts` emits. 300 new accounts cost about 14.4M gas.
    uint256 internal constant MAX_BACKFILL_CHUNK = 300;

    /// @dev The settlement chunk size `safeTxArrayBuilder.ts` emits. 200 first-time recipients cost
    /// about 19M gas against the live V3 plugin, inside Polygon's 32M per-transaction cap. Enforced as
    /// a ceiling so a file built at the wrong size fails here rather than as an out-of-gas on a
    /// signer's screen.
    uint256 internal constant MAX_SETTLE_CHUNK = 200;

    error ChunkIsEmpty(string path);
    error ChunkTooLarge(string path, uint256 length);
    error ChunkColumnsMismatched(string path, uint256 accounts, uint256 amounts);
    error ChunkRowMalformed(string path, uint256 index, uint256 fields);
    error ChunkDuplicateAccount(string path, address account);

    /// @notice Reads a two-column chunk into the parallel arrays `backfillCumulativeRewards` takes.
    function readColumns(string memory path)
        internal
        view
        returns (address[] memory accounts, uint256[] memory amounts)
    {
        string memory json = vm.readFile(path);

        accounts = vm.parseJsonAddressArray(json, "[0]");
        string[] memory rawAmounts = vm.parseJsonStringArray(json, "[1]");

        if (accounts.length != rawAmounts.length) {
            revert ChunkColumnsMismatched(path, accounts.length, rawAmounts.length);
        }
        if (accounts.length == 0) revert ChunkIsEmpty(path);
        if (accounts.length > MAX_BACKFILL_CHUNK) revert ChunkTooLarge(path, accounts.length);
        _requireUnique(path, accounts);

        amounts = new uint256[](rawAmounts.length);
        for (uint256 i; i < rawAmounts.length; ++i) {
            amounts[i] = vm.parseUint(rawAmounts[i]);
        }
    }

    /// @notice Reads a row-per-recipient chunk into the struct array `increaseClaimableByBatch` takes.
    function readRewards(string memory path) internal view returns (TANIssuanceHistory.IssuanceReward[] memory rewards) {
        string memory json = vm.readFile(path);

        uint256 count = _countRows(json);
        if (count == 0) revert ChunkIsEmpty(path);
        if (count > MAX_SETTLE_CHUNK) revert ChunkTooLarge(path, count);

        rewards = new TANIssuanceHistory.IssuanceReward[](count);
        address[] memory accounts = new address[](count);
        for (uint256 i; i < count; ++i) {
            string[] memory row;
            try vm.parseJsonStringArray(json, _index(i)) returns (string[] memory parsed) {
                row = parsed;
            } catch {
                // the row exists but is not an array of strings
                revert ChunkRowMalformed(path, i, 0);
            }
            if (row.length != 2) revert ChunkRowMalformed(path, i, row.length);

            rewards[i] = TANIssuanceHistory.IssuanceReward({
                account: vm.parseAddress(row[0]),
                amount: vm.parseUint(row[1])
            });
            accounts[i] = rewards[i].account;
        }
        _requireUnique(path, accounts);
    }

    /// @notice Sums the amounts on a reward chunk, which is what the settlement has to be funded with.
    function totalOf(TANIssuanceHistory.IssuanceReward[] memory rewards) internal pure returns (uint256 total) {
        for (uint256 i; i < rewards.length; ++i) {
            total += rewards[i].amount;
        }
    }

    /// @notice Sums a column of amounts.
    function totalOf(uint256[] memory amounts) internal pure returns (uint256 total) {
        for (uint256 i; i < amounts.length; ++i) {
            total += amounts[i];
        }
    }

    /// @dev A root-level JSON array has no length accessor, so rows are counted by probing for each
    /// index. Probing for existence rather than parsing means a malformed row is still counted, and is
    /// then rejected when parsed, instead of silently ending the chunk early.
    function _countRows(string memory json) private view returns (uint256 count) {
        while (vm.keyExistsJson(json, _index(count))) {
            ++count;
        }
    }

    /// @dev Both emitters aggregate per account, so a repeated account means a hand-edited or
    /// mis-merged file. Chunks are at most a few hundred rows, so a quadratic scan is cheap.
    function _requireUnique(string memory path, address[] memory accounts) private pure {
        for (uint256 i; i < accounts.length; ++i) {
            for (uint256 j = i + 1; j < accounts.length; ++j) {
                if (accounts[i] == accounts[j]) revert ChunkDuplicateAccount(path, accounts[i]);
            }
        }
    }

    function _index(uint256 i) private pure returns (string memory) {
        return string.concat("[", vm.toString(i), "]");
    }
}
