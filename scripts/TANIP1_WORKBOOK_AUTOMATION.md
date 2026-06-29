# Weekly Rewards Pipeline — Operator Runbook

Operational detail for the automated weekly rewards pipeline. For the high-level
goals, architecture, and security model, read `REWARDS_PIPELINE.md` at the repo
root first; this file is the hands-on reference for running and maintaining it.

> The automation calculates rewards and opens a pull request. It never moves
> funds and never writes to any chain. Settlement is a separate, manually-signed
> multisig transaction.

---

## What runs each week

`.github/workflows/weekly_rewards.yml`, Thursday 12:00 UTC (a full day after the
Wednesday 00:00 UTC epoch boundary, so the end block is past reorg-safe depth on
both chains). It can also be dispatched manually.

```
checkout + install + build
  TANIP-1:  resolveBlockRange → app.js (calculator) → build_workbook.py
            → roll template forward → safeTxArrayBuilder --tan
  TELx:     resolveTelxRun → TELxRewardsCalculator (per pool)
            → telxHumanReadable → safeTxArrayBuilder --telx
  open one PR with all artifacts
```

Both programs derive their full block range automatically (see "Block ranges"
below). There is no per-period manual input.

---

## Block ranges (the sequential invariant)

A period starts on the block **immediately after** the previous period's last
block, and ends at the **most recent Wednesday 00:00 UTC** boundary. Time only
bounds the end; the start always comes from prior state.

- **TANIP-1** (`backend/resolveBlockRange.ts`): start = on-chain
  `TANIssuanceHistory.lastSettlementBlock + 1`; end = block at the most recent
  Wednesday boundary on Polygon. Fails if the end is not reorg-safe or not past
  the start.
- **TELx** (`backend/calculators/TELxRewardsCalculator.ts`,
  `buildPeriodConfig`): start = previous checkpoint `blockRange.endBlock + 1`;
  end = curated `periodStarts[]` boundary when one exists (historical periods
  recompute identically), otherwise the most recent Wednesday boundary on the
  pool's chain. Fails if start ≠ curated start (when curated) or if end ≤ start
  (period not closed yet).

`resolveTelxRun.ts` selects the next TELx period (max checkpoint period + 1) and
reports `READY=true` once all three pools have the previous period's checkpoint.

---

## Workbook structure (`build_workbook.py`)

The builder appends one period into `reports/TANIP1_Rewards_Distribution_PeriodN.xlsx`,
matching the committed reference workbook exactly. All sheets have their header in
row 1 and data from row 2.

| Sheet | Columns |
|---|---|
| Period Totals | Period, Staker Count, $TEL Rewards, Total Fees, Staker Fees, Referee Fees |
| Raw Data | Period, Address, $TEL Rewards, Uncapped, Missed, Staker Fees, Referee Fees, Total Fees |
| Raw Data - Rebate | …as Raw Data, plus a Stake Cap column (populated every period) |
| Cumulative | Address, $TEL Rewards, Total Fees, Staker Fees, Referee Fees (per-address running totals, sorted desc by rewards) |
| Pivot Table | Address, then one $TEL Rewards column per period (addresses sorted ascending) |

**Field mapping.** All JSON values are TEL × 100 — divide by 100 before writing.

| JSON field | Workbook column |
|---|---|
| `reward` / 100 | $TEL Rewards |
| `metadata.uncappedAmount` / 100 | Uncapped $TEL Reward |
| `uncappedAmount − reward` / 100 | Missed $TEL Reward |
| `metadata.stakeCapAmount` / 100 | Stake Cap (Rebate sheet) |
| `metadata.fees` / 100 | Staker Fees |
| `metadata.refereeFees` / 100 | Referee Fees |
| `fees + refereeFees` / 100 | Total Fees |

**Idempotent.** If the period is already in Period Totals, the builder exits
without changing anything (no duplicate rows, no double-counting in Cumulative).

### Verification gates (run after every save; abort on any failure)

1. Source JSON is byte-for-byte unchanged during the build (MD5).
2. Raw Data and Raw Data - Rebate have the right row count and matching
   `$TEL Rewards` for the period.
3. Period Totals has the correct five metrics and no prior period was dropped.
4. Cumulative and the Pivot Table contain every wallet, and each pivot cell
   equals the wallet's `$TEL Rewards`.

A workbook that fails any gate is not committed.

---

## One-Time Setup (after merge)

**1. Workflow permissions**
Settings → Actions → General → Workflow permissions → **Read and write
permissions**, and enable **Allow GitHub Actions to create and approve pull
requests** (the pipeline opens a PR rather than pushing to the default branch).
Keep branch protection requiring human approval before merge.

**2. Repository secrets** — Settings → Secrets and variables → Actions

| Secret | Used by | Purpose |
|---|---|---|
| `POLYGON_RPC_URL` | TANIP calc, TELx Polygon pools, block-range resolver, reports | Polygon archive RPC |
| `BASE_RPC_URL` | TELx Base pool calc + report | Base archive RPC |
| `MAINNET_RPC_URL` | block-range validation helpers | Ethereum mainnet RPC (config requires the var) |

Use **archive** endpoints — the calculators read historical state/logs across the
full period block range. Secrets are referenced only by name via
`${{ secrets.* }}`; no URLs or keys are committed. The built-in `GITHUB_TOKEN`
covers PR creation.

**3. Deploy RewardsNotifier** (one-time, Polygon)

`src/issuance/RewardsNotifier.sol` emits a public `RewardsSettled` event each
time rewards settle, so the community can subscribe without decoding the Safe's
internal multisig call.

```bash
forge script script/DeployRewardsNotifier.s.sol \
  --rpc-url $POLYGON_RPC_URL --broadcast
```

The constructor grants `DEFAULT_ADMIN_ROLE` and `NOTIFIER_ROLE` to the TAO Safe
(read from `deployments/deployments.json`). After deployment:
1. The script writes the deployed address into `deployments/deployments.json`
   under `RewardsNotifier`.
2. Confirm the TAO Safe holds `NOTIFIER_ROLE`.

`safeTxArrayBuilder --tan` then emits `safe_param_period_N_tan_notify.json`. Add
it as the **final** transaction in the Safe settlement batch — after
`increaseClaimableByBatch` — so the event fires only on successful settlement.

---

## Running manually

```bash
pip install openpyxl requests
python scripts/build_workbook.py \
  --period 38 \
  --template reports/TANIP1_Rewards_Distribution_template.xlsx \
  --output-dir reports
```

Omit `--period` to auto-detect the latest period in `rewards/`.

The calculators (run before the workbook builder in CI) need the RPC secrets
exported locally:

```bash
export POLYGON_RPC_URL=... BASE_RPC_URL=... MAINNET_RPC_URL=...
yarn build
node dist/resolveBlockRange.js                       # TANIP: sequential range + period
node dist/app.js polygon=START:END --period=38       # TANIP staker calculator
node dist/resolveTelxRun.js                           # TELx: target period + readiness
node dist/calculators/TELxRewardsCalculator.js <poolId>:<period>   # per pool
node dist/telxHumanReadable.js                        # TELx human-readable xlsx
```

---

## Settlement batch (manual, TANIP-1)

After the PR is reviewed and merged, operators build and sign this Safe batch:

1. `TEL.approve(TANIssuanceHistory, total)`
2. `TANIssuanceHistory.increaseClaimableByBatch(rewards[], endBlock)` — sets
   `lastSettlementBlock = endBlock`, which next week's resolver reads.
3. `RewardsNotifier.notifyRewardsSettled(period, endBlock, total)` — emits the
   public event.

Parameters come from `backend/temp/safe_param_period_N_tan_*.json`. Merging
approved the numbers; the money moves only when signers execute this batch.
