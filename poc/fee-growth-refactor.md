## Problem Statement
Polygon period 8 rewards were dramatically inflated for specific wallets because `TELxRewardsCalculator` clamped only the lower tick when recomputing fee growth. As a result, short-lived positions captured the entire pool’s accumulated fees, pushing WETH accrual into triple digits and skewing TEL payouts. We needed to restore the on-chain behaviour, stop negative wrap-around artefacts, and document the regression so reviewers can follow every change.

## High-Level Summary
- Replaced the asymmetric clamp with a symmetric search plus a “direct contract call first” strategy, and adjusted per-subperiod sampling to avoid post-liquidity spikes.
- Hardened fee-growth arithmetic (uint256 wrap-around) and exported the helpers so tests could cover edge cases.
- Regenerated Polygon period 8 artefacts (JSON/XLSX) to reflect the corrected calculations and updated developer tests/config to include Base chain metadata.
- Captured a diff of the redistribution: the overpaid wallet drops by ~36.75 WETH / 348 k TEL, while previously underpaid LPs recover their share.

## Detailed Breakdown

### Calculator Logic (`backend/calculators/TELxRewardsCalculator.ts`)
- **Line 489**: Subperiods now use `[start, end)` semantics. When a modify event fires at `t2`, we sample `t2-1` for the end snapshot. This prevents us from attributing fees accrued after liquidity is pulled to the flash position.
- **Lines 661–705**: `getFeeGrowthInsideOffchain` first calls `StateView.getFeeGrowthInside`. Only if that fails do we fall back to bitmap scanning. This mirrors on-chain execution and avoids recomputing the entire range when the contract already returns a safe value.
- **Lines 705–766**: Introduced `calculateFeeGrowthInside`, wrapping modular subtraction with `2^256`. Both upper and lower searches are exported (`findInitializedTickAbove`, `findInitializedTickUnder`) so unit tests can simulate the viem client.
- **Lines 766–868**: Implemented symmetric scanning for initialized ticks both above and below. This removes the collapsing range that originally caused the issue.
- **Line 557**: `calculateFees` now uses modular subtraction to handle wrap-around properly, eliminating the zeroing that occurred when fee growth reset.

**Why:** These changes ensure fee-growth deltas match on-chain behaviour across all sub-periods, and they expose the building blocks for direct unit tests, guaranteeing we can reproduce edge cases (short-lived liquidity, wrap-around, uninitialized ticks).

### Tests (`backend/test/TELxRewardsCalculator.test.ts`)
- Added coverage for upper tick search (same-word, cross-word, negative ticks, search limit).
- Added wrap-around assertions for `calculateFeeGrowthInside` and `calculateFees`.

**Why:** Without automated coverage, any future refactor could reintroduce the clamp or modulo bugs. The test file now exercises every helper in isolation using mocked `PublicClient` responses.

### Regenerated Artefacts
- **`backend/checkpoints/polygon-ETH-TEL-8.json`** and **`.xlsx`**: reran the calculator; the file now shows total WETH fees of `0.404639` instead of `37.16`. The wallet `0x2fe6f7…c364b7` falls to `0.1844` WETH / `295,216.35` TEL, while `0xD98b…A6b7` rises by `+258,570.28` TEL. All other LP allocations follow the corrected proportions.
- Captured diffs (for PR body) demonstrating the redistribution so reviewers can verify no other pool changed.

### Configuration & Supporting Tests
- **`backend/config.ts`**: Added Base’s TEL token metadata (`0x09bE...aDB1`, 2 decimals) so utilities no longer throw when tests include Base.
- **`backend/test/DeveloperIncentivesCalculator.test.ts`**: Extended start/end block maps to include Base, matching the config update.

**Why:** The developer incentives test failed once Base chain support was enabled globally. These changes keep the suite green and reduce friction for future multi-chain work.

### Documentation
- While the original PoC write-up (`poc/fee-growth-clamp.md`) captured the bug, this refactor note explains the concrete code paths, the before/after numbers, and the reason for each touching file. It should be linked in the PR description so reviewers can scan the regression context quickly.

### Helper Scripts
- **`poc/scripts/compareFeeGrowthClamped.js`**: Mirrors the corrected clamp logic, accepts a checkpoint token ID, and prints fee-growth deltas for both original and clamped tick ranges. We rely on it to reproduce the regression on demand and to verify that the symmetric search returns the same values as on-chain calls.
- **`poc/scripts/generatePeriod8.mjs`**: Automates rebuilding Polygon period 8 by spawning the production CLI and snapshotting the outputs with timestamps. This protects the new checkpoint from accidental overwrites and supplies reviewers with reproducible artefacts.
- **`poc/scripts/getLastSettlementBlock.cjs` / `getLastSettlementBlock.js`**: Lightweight wrappers around the `StateView` contract to fetch `lastSettlementBlock` for each network. We used them to confirm the period boundaries before rerunning Polygon period 8 with the updated calculator.
