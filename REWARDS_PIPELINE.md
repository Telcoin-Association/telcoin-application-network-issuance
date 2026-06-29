# Weekly Rewards Pipeline — Reviewer Guide

This document explains the automated weekly rewards pipeline introduced in this
PR. It is written for the engineers reviewing the change: it states what the
automation is for, walks through exactly how it works step by step, and is
explicit about the security model — in particular, the boundary between what the
automation does on its own and what still requires human signatures.

> **Read this first:** the automation **calculates and formats** rewards and
> **opens a pull request** for review. It **never moves funds and never writes to
> any chain.** Settlement remains a manually-reviewed, manually-executed
> multisig transaction. Merging the PR approves the *numbers*; it does not
> distribute anything.

---

## 1. Goals

Today the weekly process is manual and sequential:

1. An operator looks up the block where the last epoch ended.
2. They type that block into the calculator script to produce the rewards JSON.
3. They run the human-readable script to turn the JSON into an Excel workbook.
4. They review the workbook; once satisfied, the rewards are settled on chain
   through the council Safe.

This PR automates steps 1–3 so the only remaining human actions are **reviewing
a pull request** and **signing the settlement transaction**. Concretely, the
goals are:

- **G1 — Derive block ranges from prior on-chain/output state, never the clock
  or hand-entry.** Each epoch must begin on the block immediately after the
  previous epoch ended. No gaps, no overlaps, regardless of when the job runs.
- **G2 — Run both reward programs** every week: TANIP-1 staker rewards (Polygon)
  and TELx liquidity rewards (Base + Polygon, 3 pools).
- **G3 — Produce the existing review artifacts** unchanged in shape: the TANIP-1
  distribution workbook and the TELx human-readable reports.
- **G4 — Present everything as a pull request** for the council/devs to review,
  rather than pushing to a branch that anything downstream trusts.
- **G5 — Keep the multisig as the only money gate.** The automation prepares the
  exact Safe transaction parameters; humans review and execute them.
- **G6 — Give the community an on-chain signal** when a period actually settles,
  without anyone having to parse the Safe's internal multisig call.

## 2. What this PR explicitly does NOT do

This boundary is the core of the security model, so it is stated before anything
else:

- It does **not** sign, submit, or execute any on-chain transaction.
- It does **not** have access to any Safe, private key, or signer.
- It does **not** push to a protected branch or auto-merge anything.
- It does **not** transfer, approve, or custody any TEL.

The automation's entire authority is: read public chain data, run the existing
calculators, write files, and open a PR. Everything with financial consequence
stays behind the council multisig.

---

## 3. The sequential block-range invariant (the heart of correctness)

Both programs share one rule: **a period starts on the block immediately after
the previous period's last block, and ends at the most recent Wednesday 00:00
UTC epoch boundary.** Time only ever bounds the *end*; it never decides the
*start*. The start always comes from prior state.

### TANIP-1 (Polygon)

- **Start:** read `lastSettlementBlock` from the on-chain `TANIssuanceHistory`
  contract (`0xe533911f00f1c3b58bb8d821131c9b6e2452fc27`). When an epoch settles,
  `increaseClaimableByBatch` sets `lastSettlementBlock = endBlock`. So the next
  epoch's start is exactly `lastSettlementBlock + 1` — contiguous by
  construction, taken from the chain, not a stored file or the clock.
- **End:** the block at the most recent Wednesday 00:00 UTC boundary, found by
  binary-searching block timestamps on Polygon.
- **Guards:** the end must be reorg-safe (deeper than the configured reorg depth)
  and strictly greater than the start, or the job fails loudly rather than
  emitting a bad range.

Implemented in `backend/resolveBlockRange.ts`.

### TELx (Base + Polygon, 3 pools)

- **Start:** read the previous period's checkpoint file
  (`backend/checkpoints/<pool>-<N-1>.json`), take its `blockRange.endBlock`, add
  1. Same invariant as TANIP, sourced from the prior run's own output.
- **End:** if a curated boundary exists in `periodStarts[]` (historical periods),
  use it — this guarantees past periods recompute to byte-identical ranges.
  Otherwise (the new period) derive the end from the most recent Wednesday 00:00
  UTC boundary on that pool's chain, exactly like TANIP.
- **Guards:** a contiguity check (derived start must match the curated start when
  one exists) and an end-must-exceed-start check (refuses to run a period that
  has not closed yet).

Implemented in `backend/calculators/TELxRewardsCalculator.ts`
(`buildPeriodConfig` / `previousPeriodEndBlock`) and
`backend/resolveTelxRun.ts`.

> **Why this matters:** the previous manual failure mode was typing the wrong
> start block, producing a gap or overlap between periods. Deriving the start
> from prior state makes that class of error impossible. We verified the derived
> TELx start for period 46 reproduces the curated `periodStarts` value exactly
> for all three pools (see §6).

---

## 4. Step-by-step: the weekly pipeline

Defined in `.github/workflows/weekly_rewards.yml`. Runs Thursday 12:00 UTC (a
full day after the Wednesday boundary, so both chains are comfortably
reorg-safe) and can also be triggered manually.

### Setup
1. Check out the repo (full history, so prior checkpoints/JSON are available).
2. Install Node + Python deps; compile TypeScript.

### TANIP-1 (Polygon)
3. **Resolve block range** (`resolveBlockRange.ts`) → emits
   `polygon=<start>:<end> --period=N`, derived per §3.
4. **Run the staker calculator** (`app.js`) with that range →
   `rewards/staker_rewards_period_N.json`.
5. **Build the workbook** (`scripts/build_workbook.py`) → appends the period to
   `reports/TANIP1_Rewards_Distribution_PeriodN.xlsx`, then runs four
   verification gates (§6) and aborts on any failure.
6. **Roll the template forward** so the cumulative base carries into next week.
7. **Build Safe parameters** (`safeTxArrayBuilder.ts --tan`) → the
   `increaseClaimableByBatch` argument chunks plus a `notifyRewardsSettled`
   parameter file (§7).

### TELx (Base + Polygon, 3 pools)
8. **Resolve the run** (`resolveTelxRun.ts`) → next period + readiness. Ready as
   soon as all three pools have the previous period's checkpoint.
9. **Run the calculator per pool** → `backend/checkpoints/<pool>-N.json`.
10. **Generate human-readable reports** (`telxHumanReadable.ts`) → per-pool
    `.xlsx`.
11. **Build Safe parameters** (`safeTxArrayBuilder.ts --telx`) → the
    `addRewards` argument chunks per pool.

### Review
12. **Open one pull request** (`peter-evans/create-pull-request`) carrying the
    rewards JSON, workbooks, and checkpoints. The PR body documents the block
    ranges and the exact Safe batch order. **This is where humans take over.**

---

## 5. Settlement (manual, unchanged in spirit)

After the PR is reviewed and merged:

1. Operators open the council Safe and build the settlement batch.
2. For TANIP-1 the batch is, in order:
   1. `TEL.approve(TANIssuanceHistory, total)`
   2. `TANIssuanceHistory.increaseClaimableByBatch(rewards[], endBlock)` — this
      sets `lastSettlementBlock = endBlock`, which next week's resolver reads.
   3. `RewardsNotifier.notifyRewardsSettled(period, endBlock, total)` — emits the
      public `RewardsSettled` event (§7).
3. Signers review the parameters (which match the merged PR) and execute.

The numbers were approved at merge; the money moves only when signers sign.

---

## 6. Verification and testing

### Workbook verification gates (`build_workbook.py`)
Every build reopens the saved file and asserts, aborting the job on any failure:
1. The source JSON is byte-for-byte unchanged during the build (MD5).
2. Raw Data and Raw Data - Rebate have the right row count and matching
   `$TEL Rewards` for the period.
3. Period Totals has the correct five metrics and no prior period was dropped.
4. Cumulative and the Pivot Table contain every wallet, and each pivot cell
   equals the wallet's `$TEL Rewards`.

### What was actually run for this PR
The pipeline was smoke-tested in a sandbox (the calculators that need archive
RPC were exercised only where no network was required):

- **Workbook builder, end to end** against the real committed period-37 data:
  - clean append of a new period — all 4 gates pass;
  - **idempotent** re-run — detects the period is already present and makes no
    changes (no double-counting in Cumulative, no duplicate rows);
  - a **mixed period** with new and dropped wallets — new wallets slot into the
    Pivot Table in sorted order with zeros in prior columns; all gates pass.
  - This surfaced and fixed a real bug: the builder had been written for a
    different workbook layout than the one in the repo. It now matches the
    committed reference structure exactly.
- **TELx resolver** (`resolveTelxRun.ts`): correctly identifies period 46 across
  all three pools and reports `READY=true` — the manual `periodStarts` append is
  no longer required.
- **Start-block derivation:** the derived period-46 start (`prev checkpoint
  endBlock + 1`) equals the curated `periodStarts` value for all three pools
  (`47734926`, `89036136`, `89036136`) — proving the automation reproduces what
  an operator would have entered by hand.
- **Epoch-boundary math:** `mostRecentEpochBoundary` lands on Wednesday 00:00 UTC
  for every tested input.
- **Type-check:** all pipeline files pass `tsc --noEmit`. (Two pre-existing,
  unrelated type errors in `DeveloperIncentivesCalculator` are present on
  `master` and untouched here.)

---

## 7. Security model (paramount)

**1. No keys, no Safe, no on-chain writes.** The automation's maximum authority
is: read public chain data, run scripts, write files, open a PR. It holds no
signer and cannot move funds. This is the single most important property — re-
read §2.

**2. Merging ≠ paying.** The PR is a review surface. Even a merged PR does not
distribute anything; settlement is a separate multisig transaction that signers
build and execute. The council Safe remains the only money gate (G5).

**3. Least-privilege workflow permissions.** The job needs only `contents: write`
and `pull-requests: write` to open the PR. It does not run on protected branches
and does not auto-merge. Reviewers should confirm branch protection requires
human approval before merge.

**4. Secrets are referenced by name only.** The workflow consumes
`POLYGON_RPC_URL`, `BASE_RPC_URL`, and `MAINNET_RPC_URL` via
`${{ secrets.* }}`. No endpoint URLs or keys are committed. These should be
**archive** endpoints (the calculators read historical state/logs across the
period). RPC URLs are read-only data sources — they cannot authorize a transfer.

**5. Deterministic, reproducible inputs.** Because ranges are derived from chain
state and prior output (not the clock), a reviewer can independently recompute
any period and get the same range. Historical TELx periods recompute to
byte-identical boundaries because curated `periodStarts` values are preferred
when present.

**6. Fail loud, never guess.** Every resolver and the workbook builder throw on
contradiction (range gap/overlap, end ≤ start, not reorg-safe, JSON mutated
mid-build, dropped period) rather than emitting a plausible-but-wrong artifact.

**7. The notifier is observability, not control.** `RewardsNotifier`
(`src/issuance/RewardsNotifier.sol`) is a stateless, fund-less contract whose
only effect is emitting `RewardsSettled(period, endBlock, totalRewards,
settler)`. It uses `AccessControl` (`NOTIFIER_ROLE`) so the TAO Safe — and only
authorized callers — can emit it, added as the final call in the settlement
batch so the event fires only on a successful settlement. It cannot move funds
and gates nothing; it exists so the community can subscribe to a clean event
instead of trying to decode the Safe's internal multisig transaction (G6).

**8. Supply chain.** Node dependencies install from the lockfile; the pinned
`peter-evans/create-pull-request` action is the only third-party action and is
used solely to open the PR with the built artifacts.

---

## 8. How to review this PR

Suggested checklist:

- [ ] **Block-range logic** (`resolveBlockRange.ts`, `buildPeriodConfig` /
      `previousPeriodEndBlock`): confirm start is always `prev end + 1` and that
      the guards (reorg-safe, end > start, contiguity) are correct.
- [ ] **No on-chain writes / no secrets in code:** confirm nothing signs or
      submits a transaction and that secrets appear only as `${{ secrets.* }}`.
- [ ] **Workflow permissions** are minimal and branch protection still requires
      human merge.
- [ ] **Workbook builder** matches the structure your team expects (Raw Data,
      Raw Data - Rebate, Period Totals, Cumulative, Pivot Table) and the four
      gates are meaningful to you.
- [ ] **Safe parameters** (`safeTxArrayBuilder.ts`) produce the exact arguments
      your settlement process expects, including the `notifyRewardsSettled` step.
- [ ] **RewardsNotifier** access control and the settlement batch order make
      sense for the TAO Safe.
- [ ] **Does this process make sense for your operations?** The whole point of
      the PR is to get this judgment from you before anything is wired up.

---

## 9. One-time setup (after merge)

See `scripts/TANIP1_WORKBOOK_AUTOMATION.md` for the detailed runbook. In short:

1. **Workflow permissions:** enable read/write and "Allow GitHub Actions to
   create and approve pull requests."
2. **Repository secrets:** add `POLYGON_RPC_URL`, `BASE_RPC_URL`,
   `MAINNET_RPC_URL` (archive endpoints).
3. **Deploy `RewardsNotifier`** on Polygon with the TAO Safe as admin, record its
   address in `deployments/deployments.json`, and grant `NOTIFIER_ROLE` to the
   Safe.

No per-period manual input is required after setup: both programs derive their
full block range automatically each week.

---

## 10. Files in this PR

| Area | File | Purpose |
|---|---|---|
| TANIP range | `backend/resolveBlockRange.ts` | Derive sequential Polygon block range + period from chain state |
| TELx range | `backend/resolveTelxRun.ts` | Pick next TELx period + readiness from checkpoints |
| TELx calc | `backend/calculators/TELxRewardsCalculator.ts` | Auto-derive start (prior checkpoint) and end (epoch boundary) block |
| Shared | `backend/helpers.ts` | `mostRecentEpochBoundary` shared by both programs |
| Workbook | `scripts/build_workbook.py` | Build the TANIP-1 distribution workbook with 4 verification gates |
| Safe params | `backend/safeTxArrayBuilder.ts` | Emit Safe call parameters incl. `notifyRewardsSettled` |
| Notifier | `src/issuance/RewardsNotifier.sol` | Emit the public `RewardsSettled` event on settlement |
| Deploy | `script/DeployRewardsNotifier.s.sol` | One-time notifier deployment |
| Workflow | `.github/workflows/weekly_rewards.yml` | The weekly pipeline that opens the review PR |
| Runbook | `scripts/TANIP1_WORKBOOK_AUTOMATION.md` | Operator runbook + setup detail |
