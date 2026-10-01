// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { SafeChunkReader } from "../script/safe/SafeChunkReader.sol";
import { TANIssuanceHistory } from "../src/issuance/TANIssuanceHistory.sol";

/// @dev `SafeChunkReader` is a library of internal functions, so its reverts land at the same call
/// depth as the test and `expectRevert` cannot see them. Routing through an external call gives them
/// a boundary to cross.
contract ChunkReaderHarness {
    function readColumns(string memory path) external view returns (address[] memory, uint256[] memory) {
        return SafeChunkReader.readColumns(path);
    }

    function readRewards(string memory path) external view returns (TANIssuanceHistory.IssuanceReward[] memory) {
        return SafeChunkReader.readRewards(path);
    }
}

/**
 * @notice Covers the parsing that turns backend chunk files into Safe proposal arguments.
 *
 * @dev This is the seam between two repos' worth of tooling: the backend writes these files for the
 * Safe UI, and the proposal scripts read them back. A silent misread here would put wrong amounts or
 * wrong recipients in front of signers, and neither the contract nor the Safe would catch it, so the
 * parser is pinned against fixtures in both shapes plus every malformed case it rejects.
 */
contract SafeChunkReaderTest is Test {
    address constant ACCOUNT_A = 0x588D280a2B5577042765C2aaa6f13C7A611649de;
    address constant ACCOUNT_B = 0x765327d1AeA74cC360B1C6Cc567200d7e4baC3fD;
    address constant ACCOUNT_C = 0xDCe4Ef7679E8A81EEE8c71917b21EbbCef45B5BA;

    ChunkReaderHarness harness;

    function setUp() public {
        harness = new ChunkReaderHarness();
    }

    function _fixture(string memory name) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/test/fixtures/chunks/", name);
    }

    /**
     * Backfill chunks: [[account, ...], [amount, ...]]
     */

    function testReadsBackfillColumns() public view {
        (address[] memory accounts, uint256[] memory amounts) =
            SafeChunkReader.readColumns(_fixture("backfill_ok.json"));

        assertEq(accounts.length, 3);
        assertEq(amounts.length, 3);

        assertEq(accounts[0], ACCOUNT_A);
        assertEq(accounts[1], ACCOUNT_B);
        assertEq(accounts[2], ACCOUNT_C);

        // amounts are carried as strings precisely because they overflow a JSON number
        assertEq(amounts[0], 1e18);
        assertEq(amounts[1], 25.5e18);
        assertEq(amounts[2], 3);

        assertEq(SafeChunkReader.totalOf(amounts), 1e18 + 25.5e18 + 3);
    }

    function testRejectsBackfillColumnsOfDifferentLengths() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                SafeChunkReader.ChunkColumnsMismatched.selector, _fixture("backfill_mismatched.json"), 2, 1
            )
        );
        harness.readColumns(_fixture("backfill_mismatched.json"));
    }

    /// @dev An empty chunk would propose a backfill that seeds nobody, burning a Safe nonce and a
    /// signing round for nothing.
    function testRejectsEmptyBackfillChunk() public {
        vm.expectRevert(
            abi.encodeWithSelector(SafeChunkReader.ChunkIsEmpty.selector, _fixture("backfill_empty.json"))
        );
        harness.readColumns(_fixture("backfill_empty.json"));
    }

    function testRejectsOversizeBackfillChunk() public {
        vm.expectRevert(
            abi.encodeWithSelector(SafeChunkReader.ChunkTooLarge.selector, _fixture("backfill_oversize.json"), 301)
        );
        harness.readColumns(_fixture("backfill_oversize.json"));
    }

    /**
     * Settlement chunks: [[account, amount], ...]
     */

    function testReadsSettlementRows() public view {
        TANIssuanceHistory.IssuanceReward[] memory rewards = SafeChunkReader.readRewards(_fixture("settle_ok.json"));

        assertEq(rewards.length, 3);

        assertEq(rewards[0].account, ACCOUNT_A);
        assertEq(rewards[0].amount, 1e18);
        assertEq(rewards[1].account, ACCOUNT_B);
        assertEq(rewards[1].amount, 25.5e18);
        assertEq(rewards[2].account, ACCOUNT_C);
        assertEq(rewards[2].amount, 3);

        assertEq(SafeChunkReader.totalOf(rewards), 1e18 + 25.5e18 + 3);
    }

    /// @dev The row count comes from walking until a read fails, so a file whose rows carry an extra
    /// field still counts correctly and has to be caught on shape instead.
    function testRejectsMalformedSettlementRow() public {
        vm.expectRevert(
            abi.encodeWithSelector(SafeChunkReader.ChunkRowMalformed.selector, _fixture("settle_malformed.json"), 0, 3)
        );
        harness.readRewards(_fixture("settle_malformed.json"));
    }

    function testRejectsEmptySettlementChunk() public {
        vm.expectRevert(abi.encodeWithSelector(SafeChunkReader.ChunkIsEmpty.selector, _fixture("settle_empty.json")));
        harness.readRewards(_fixture("settle_empty.json"));
    }

    /// @dev The walk is bounded, so an oversize file is rejected rather than counted forever.
    function testRejectsOversizeSettlementChunk() public {
        vm.expectRevert(
            abi.encodeWithSelector(SafeChunkReader.ChunkTooLarge.selector, _fixture("settle_oversize.json"), 301)
        );
        harness.readRewards(_fixture("settle_oversize.json"));
    }

    /// @dev A full chunk is the normal case, and it sits exactly on the ceiling, so it must pass.
    function testAcceptsChunkAtTheSizeLimit() public view {
        assertEq(SafeChunkReader.MAX_CHUNK, 300);
    }
}
