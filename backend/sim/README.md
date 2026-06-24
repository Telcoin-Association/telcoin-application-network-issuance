# TELx fee-growth de-initialization fix - validation scripts

These scripts validate the fix in `backend/calculators/TELxRewardsCalculator.ts`
for the period-44 fee-inflation defect.

## The defect (now fixed)

`getFeeGrowthInsideOffchain` rebuilt a position's fee growth by re-locating its
initialized boundary ticks **independently at each sub-period endpoint**. When a
narrow position's boundary ticks de-initialize after the price leaves its range,
`findInitializedTickUnder` snaps to unrelated ticks and reconstructs a phantom
`feeGrowthInside` (~9e31). The underflow guard in `calculateFees`
(`end >= start ? delta : 0`) then credits that phantom as real fees.

## The fix

`clampTicksToInitialized` computes the initialized tick bounds **once, at the
sub-period start block** (where the position's ticks are still initialized), and
`getFeeGrowthInsideOffchainAtBounds` reuses those exact bounds at both endpoints.
If either clamped tick has de-initialized by the query block, the sub-period
earns nothing. Genuine positions are unaffected.

## Scripts

All read the RPC URL from `POLYGON_RPC_URL` (`.env`); none contain secrets.

- `onchainRepro.ts` - reproduces the report's worked example (token 110585)
  against real Polygon archive state using the production code path. Compares the
  buggy reconstruction, the canonical `StateView.getFeeGrowthInside`, and the fix.
  Result: buggy credits exactly 65,099,934 (raw); canonical and fix return 0.
  Run: `npx ts-node backend/sim/onchainRepro.ts`

- `offlineMechanism.ts` - deterministic, no-network reproduction with an
  in-memory tick-state mock. Reproduces the same phantom offline and demonstrates
  the guard's bi-directional failure (over-credit when the phantom lands on the
  end, silent zeroing when it lands on the start).
  Run: `npx ts-node backend/sim/offlineMechanism.ts`

- `rerunPeriod44.ts` - drives the production `updatePositions` + fee-credit loop
  over the real period-44 Polygon range, both ways, and reports per-position and
  pool-level credited fees. Caches RPC reads to `backend/rpc_cache` (gitignored).
  NOTE: this harness starts from an empty position set rather than the period-43
  checkpoint, so it captures every event-active (phantom) position but understates
  silent pre-period passive positions. It is a convenience reproduction; the
  authoritative re-run is the calculator CLI below.
  Run: `npx ts-node backend/sim/rerunPeriod44.ts`

## Authoritative re-run

On `master` the full period-44 config and checkpoint chain exist, so the fix can
be validated end-to-end by resuming from the period-43 checkpoint and comparing
the regenerated period-44 output against the committed (buggy) `*-44.json`:

```
yarn ts-node backend/calculators/TELxRewardsCalculator.ts 0x25412ca33f9a2069f0520708da3f70a7843374dd46dc1c7e62f6d5002f5f9fa7:44
```
