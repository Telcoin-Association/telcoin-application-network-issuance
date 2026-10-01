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
 * index by index.
 *
 * Reading the files the backend already produces, rather than a format invented for these scripts,
 * means a proposal is built from the same bytes a reviewer pastes into the Safe UI.
 */
library SafeChunkReader {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev The chunk size both emitters use. Enforced as a ceiling so a file built at the wrong size
    /// fails here rather than as an out-of-gas on a signer's screen.
    uint256 internal constant MAX_CHUNK = 300;

    error ChunkIsEmpty(string path);
    error ChunkTooLarge(string path, uint256 length);
    error ChunkColumnsMismatched(string path, uint256 accounts, uint256 amounts);
    error ChunkRowMalformed(string path, uint256 index, uint256 fields);

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
        if (accounts.length > MAX_CHUNK) revert ChunkTooLarge(path, accounts.length);

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
        if (count > MAX_CHUNK) revert ChunkTooLarge(path, count);

        rewards = new TANIssuanceHistory.IssuanceReward[](count);
        for (uint256 i; i < count; ++i) {
            string[] memory row = vm.parseJsonStringArray(json, _index(i));
            if (row.length != 2) revert ChunkRowMalformed(path, i, row.length);

            rewards[i] = TANIssuanceHistory.IssuanceReward({
                account: vm.parseAddress(row[0]),
                amount: vm.parseUint(row[1])
            });
        }
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

    /// @dev A root-level JSON array has no length accessor, and reading past its end reverts, so the
    /// row count is found by walking until a read fails. Bounded by `MAX_CHUNK + 1` so a malformed
    /// file cannot spin.
    function _countRows(string memory json) private view returns (uint256 count) {
        while (count <= MAX_CHUNK) {
            try vm.parseJsonStringArray(json, _index(count)) returns (string[] memory) {
                ++count;
            } catch {
                return count;
            }
        }
    }

    function _index(uint256 i) private pure returns (string memory) {
        return string.concat("[", vm.toString(i), "]");
    }
}
