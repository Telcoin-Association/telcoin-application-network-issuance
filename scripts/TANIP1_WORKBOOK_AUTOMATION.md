# TANIP1 Workbook Automation — Agent Runbook

> **Producing a workbook is not success. Passing every VERIFY gate is success.**
> The manual process produced plenty of wrong workbooks. These gates exist because
> a previous agent (and human) made each of these mistakes at least once.

---

## The Ten Things That Broke (and Must Never Break Again)

Each item is a real failure. The step and VERIFY gate that prevents it are noted.

| # | What broke | Where it's caught |
|---|---|---|
| 1 | Block ranges had a gap — periods 30/31/32 were missing or mislabeled | VERIFY 0 |
| 2 | Unique-wallet count drifted: script reported 1,132 but workbook had 1,086 | VERIFY 2 |
| 3 | Appending a new period changed formulas in prior rows, breaking percentages | VERIFY 3 |
| 4 | Per-wallet rows did not sum to the aggregate row on Period Totals | VERIFY 4 |
| 5 | Cumulative sheet wrote addresses into column A instead of column B | VERIFY 5 |
| 6 | Charts vanished, had stale data ranges, empty titles, or the wrong count | VERIFY 6 |
| 7 | Wallet Search sheet header row was overwritten during an append | VERIFY 7 |
| 8 | Writing the summary sheet wiped periods P35–P37 from Period Totals | VERIFY 8 |
| 9 | Agent committed without a full reopen-and-audit of the saved file | VERIFY 9 |
| 10 | State file stored only startBlock; next run's contiguity check failed | Step 10 / state schema |

---

## Execution Order

**Do not follow the step numbers top-to-bottom.** Raw Data must exist before
wallet counts can be recomputed. The correct order is:

```
0 (contiguity) → 1 (fetch JSON) → 3 (write Raw Data) → 4 (write Raw Data - Rebate)
  → 2 (recompute wallet counts, now that Raw Data is populated)
  → 5 (Cumulative) → 6 (charts) → 7 (Wallet Search)
  → 8 (summary / Period Totals) → VERIFY 9 (full audit)
  → 10 (commit + state file)
```

---

## JSON → Workbook Field Mapping

All raw JSON values are **TEL × 100**. Divide every field by 100 before writing.

| JSON field | ÷ 100 | Workbook column |
|---|---|---|
| `reward` | yes | `$TEL Rewards` |
| `metadata.uncappedAmount` | yes | `Uncapped $TEL Reward` |
| `uncappedAmount − reward` | yes | `Missed $TEL Reward` |
| `metadata.stakeCapAmount` | yes | `Stake Cap` (Rebate sheet only) |
| `metadata.fees` | yes | `Staker Fees` |
| `metadata.refereeFees` | yes | `Referee Fees` |
| `fees + refereeFees` | yes | `Total Fees` |

Verification baseline (Period 34):
- JSON reward sum `17,306,162` ÷ 100 = **173,061.62 TEL**
- JSON fees sum `45,020,286` ÷ 100 = **450,202.86 TEL**

---

## Step 0 — Validate Block-Range Contiguity

Before touching the workbook, verify the period sequence is complete.

```python
# Load the state file written by the previous run
state = json.load(open(".tanip1_state.json"))
prev_end = state["endBlock"]          # block where last period ended
prev_period = state["lastPeriod"]

# Load the new period JSON
data = json.load(open(f"rewards/staker_rewards_period_{new_period}.json"))
new_start = int(data["blockRanges"][0]["startBlock"])

assert new_period == prev_period + 1, \
    f"Period gap: expected {prev_period + 1}, got {new_period}"
assert new_start == prev_end + 1, \
    f"Block gap between period {prev_period} and {new_period}: " \
    f"prev endBlock={prev_end}, new startBlock={new_start}"
```

**VERIFY 0:** Both assertions must pass. If either fails, stop — do not write
anything to the workbook. The period sequence or block ranges are wrong.

---

## Step 1 — Fetch and Parse JSON

```python
incentives = data["stakerIncentives"]
rows = parse_incentives(data)   # applies ÷100, see mapping table above
assert len(rows) > 0, "Empty incentives list — wrong period or corrupted JSON"
```

Record `len(rows)` as `new_wallet_count` for use in VERIFY 2 and VERIFY 5.

---

## Step 3 — Append to Raw Data Sheet

Append one row per wallet. Column order must match the existing header exactly —
read the header from row 1 before writing; do not hardcode column positions.

```python
ws = wb["Raw Data"]
existing_header = [c.value for c in ws[1]]
# expected: ["Period", "Address", "$TEL Rewards", "Uncapped $TEL Reward",
#            "Missed $TEL Reward", "Staker Fees", "Referee Fees", "Total Fees"]
assert existing_header[0] == "Period" and existing_header[1] == "Address", \
    f"Raw Data header mismatch: {existing_header}"

last_row_before = ws.max_row
for r in rows:
    ws.append([new_period, r["Address"], r["$TEL Rewards"], ...])
last_row_after = ws.max_row
```

**VERIFY 3:** Spot-check that a formula in any prior row (rows 2 through
`last_row_before`) is unchanged after the append. Read cell `C2` before and
after — its value must be identical. If it changed, a formula reference shifted
and the workbook is corrupt.

---

## Step 4 — Append to Raw Data - Rebate Sheet

Same discipline as Step 3. Read the header first; include `Stake Cap` column
(this sheet has one extra column vs Raw Data).

Expected header: `["Period", "Address", "$TEL Rewards", "Uncapped $TEL Reward",
"Missed $TEL Reward", "Stake Cap", "Staker Fees", "Referee Fees", "Total Fees"]`

**VERIFY 4:** After appending, sum the `$TEL Rewards` column for
`new_period` rows only, and compare to `total_rewards` from Step 1.
Tolerance: ±0.01 TEL (floating-point rounding only).

```python
period_rows = [r for r in ws.iter_rows(min_row=2, values_only=True)
               if r[0] == new_period]
assert abs(sum(r[2] for r in period_rows) - total_rewards) < 0.01, \
    "Raw Data - Rebate rewards sum does not match JSON total"
```

---

## Step 2 — Recompute Wallet Counts (runs AFTER Steps 3 and 4)

Count unique addresses that appear in Raw Data for `new_period`. This must be
done by reading the sheet that was just written, not by counting `rows` from
Step 1 (they can differ if deduplication or filtering occurred).

```python
ws_raw = wb["Raw Data"]
period_addresses = {
    row[1] for row in ws_raw.iter_rows(min_row=2, values_only=True)
    if row[0] == new_period and row[1] is not None
}
actual_count = len(period_addresses)
```

**VERIFY 2:** `actual_count` must equal `new_wallet_count` from Step 1.

```python
assert actual_count == new_wallet_count, \
    f"Wallet count mismatch: JSON had {new_wallet_count} entries, " \
    f"Raw Data sheet has {actual_count} unique addresses for period {new_period}"
```

If this fails, the append in Step 3 dropped or duplicated rows. Do not proceed.

---

## Step 5 — Rebuild Cumulative Sheet

Delete and recreate the Cumulative sheet from scratch (all periods, not just new).

```python
if "Cumulative" in wb.sheetnames:
    del wb["Cumulative"]
ws_cum = wb.create_sheet("Cumulative")
ws_cum.append(["Address", "$TEL Rewards", "Total Fees", "Staker Fees", "Referee Fees"])
# ... write grouped/summed data
```

**VERIFY 5 — Two assertions:**

1. Addresses must land in column B (index 1), not column A (index 0):
```python
sample = list(ws_cum.iter_rows(min_row=2, max_row=2, values_only=True))[0]
assert sample[0] == "Address" or isinstance(sample[1], str), \
    "Cumulative: address appears to be in wrong column"
# More directly:
for row in ws_cum.iter_rows(min_row=2, values_only=True):
    assert row[1] is not None and str(row[1]).startswith("0x"), \
        f"Cumulative col B is not an address: {row}"
    break
```

2. The number of rows added for `new_period` wallets: the set of addresses
   in Cumulative that were not present after the previous period must equal
   `new_wallet_count` if all new-period addresses are first-timers, or be a
   subset if some are returning. Either way, `len(cumulative_rows) >= prev_cumulative_rows`.

---

## Step 6 — Rebuild Charts

Read the existing chart count before deleting anything. After rebuilding,
the count must match.

```python
ws_chart = wb["Charts"]   # adjust sheet name to match actual workbook
chart_count_before = len(ws_chart._charts)

# ... delete stale charts, rebuild from current data ranges ...

chart_count_after = len(ws_chart._charts)
```

**VERIFY 6 — Four assertions:**

```python
assert chart_count_after == chart_count_before, \
    f"Chart count changed: was {chart_count_before}, now {chart_count_after}"

for chart in ws_chart._charts:
    assert chart.title, "Chart has no title — label it"
    # Verify data range ends at the current last row, not a stale row
    # (exact check depends on openpyxl chart reference format)

# No openpyxl calculation cache should remain
wb.calculation.calcMode = "auto"   # force recalc on open; do not leave as "manual"
```

---

## Step 7 — Update Wallet Search Sheet

This sheet has a header row that must never be overwritten. Read it first.

```python
ws_search = wb["Wallet Search"]
original_header = [c.value for c in ws_search[1]]
assert original_header[0] is not None, "Wallet Search header is empty — stop"

# ... make updates below row 1 only ...
```

**VERIFY 7:** Re-read the header after updates:

```python
new_header = [c.value for c in ws_search[1]]
assert new_header == original_header, \
    f"Wallet Search header was modified: {new_header}"

# Spot-check a known wallet (use a wallet that has appeared in every period)
known_address = "0x..."   # fill in a stable reference address
found = any(
    row[1] == known_address
    for row in ws_search.iter_rows(min_row=2, values_only=True)
)
assert found, f"Known wallet {known_address} missing from Wallet Search"
```

---

## Step 8 — Write Summary / Period Totals

**This is the step that previously wiped P35–P37.** The summary write must
append to Period Totals, never replace it. Read the current row count first.

```python
ws_totals = wb["Period Totals"]
rows_before = ws_totals.max_row   # includes header
periods_before = {
    row[0] for row in ws_totals.iter_rows(min_row=2, values_only=True)
    if row[0] is not None
}

# ... append exactly one new row for new_period ...

ws_totals.append([new_period, staker_count, total_rewards, total_fees,
                  total_staker_fees, total_referee_fees])
```

**VERIFY 8 — Data-loss guard.** After the append, re-read Period Totals and
assert that every period that existed before still exists:

```python
periods_after = {
    row[0] for row in ws_totals.iter_rows(min_row=2, values_only=True)
    if row[0] is not None
}
assert periods_before.issubset(periods_after), \
    f"Period Totals data loss: missing periods {periods_before - periods_after}"
assert new_period in periods_after, \
    f"New period {new_period} was not written to Period Totals"
assert ws_totals.max_row == rows_before + 1, \
    f"Expected exactly one new row; row count changed by " \
    f"{ws_totals.max_row - rows_before}"
```

---

## VERIFY 9 — Full Reopen Audit (before commit)

Save the workbook, then **reopen the saved file** and audit every sheet.
Do not skip this. In-memory state can differ from what openpyxl actually wrote.

```python
wb.save(output_path)
wb2 = load_workbook(output_path)

# Period Totals: all prior periods present, new period row correct
# Raw Data: last row is for new_period, row count increased by new_wallet_count
# Raw Data - Rebate: same
# Cumulative: no blank address cells in col B, row count >= prior count
# Charts: chart count unchanged, no empty titles
# Wallet Search: header row intact

for sheet_name in ["Period Totals", "Raw Data", "Raw Data - Rebate",
                   "Cumulative", "Wallet Search"]:
    assert sheet_name in wb2.sheetnames, f"Sheet missing after save: {sheet_name}"

ws2 = wb2["Period Totals"]
final_periods = {r[0] for r in ws2.iter_rows(min_row=2, values_only=True) if r[0]}
assert new_period in final_periods, "new period missing after reopen"
assert periods_before.issubset(final_periods), "prior periods missing after reopen"

print("VERIFY 9 passed — safe to commit")
```

If any assertion in VERIFY 9 fails: **do not commit, do not advance the state
file.** Fix the issue and re-run from the failing step.

---

## Step 10 — Commit and Update State File

Only run this after VERIFY 9 passes.

Write the state file **after** a successful save but **before** the git commit,
so the commit includes the updated state:

```json
{
  "lastPeriod": 37,
  "startBlock": "87485874",
  "endBlock": "87831473",
  "updatedAt": "2026-06-26T20:00:00Z"
}
```

The `endBlock` is required. The next run's VERIFY 0 reads it to check
block-range contiguity. If `endBlock` is missing, the next agent cannot
validate the chain is unbroken.

```python
state = {
    "lastPeriod": new_period,
    "startBlock": data["blockRanges"][0]["startBlock"],
    "endBlock": data["blockRanges"][-1]["endBlock"],
    "updatedAt": datetime.utcnow().isoformat() + "Z",
}
json.dump(state, open(".tanip1_state.json", "w"), indent=2)

# Then commit:
# git add reports/ .tanip1_state.json
# git commit -m "Auto: TANIP1 workbook updated for Period {new_period} [skip ci]"
# git push
```

---

## Replay Test (Acceptance Criterion)

Before declaring the automation "done":

1. Check out the repo at the state after Period 36 was committed.
2. Run the full job for Period 37.
3. Diff the output against the known-good `TANIP1_Rewards_Distribution_Period37.xlsx`.

All VERIFY gates must pass **and** the diff must be empty (or limited to
timestamp/metadata fields that are expected to differ). A workbook that passes
the gates but differs from the known-good file means a gate is missing.

---

## Cron Schedule

| Cron | UTC | Why |
|---|---|---|
| `0 12 * * 4` | Thursday 12:00 UTC | A full day after the Wed 00:00 UTC epoch boundary, so the end block is comfortably past the reorg-safe depth on both Polygon and Base. |

Fires weekly. The workbook builder is idempotent: if the period is already in
Period Totals it exits cleanly. TELx is gated on readiness (`resolveTelxRun.js`)
and is skipped with a warning if the period's end boundary has not been appended.

---

## One-Time Setup (after merge)

**1. Workflow permissions**
Settings → Actions → General → Workflow permissions → **Read and write permissions**,
and enable **Allow GitHub Actions to create and approve pull requests** (the
pipeline opens a PR rather than pushing to the default branch).

**2. Repository secrets** — Settings → Secrets and variables → Actions → New repository secret

| Secret | Used by | Purpose |
|---|---|---|
| `POLYGON_RPC_URL` | TANIP staker calc, TELx Polygon pools, block-range resolver, reports | Polygon archive RPC endpoint |
| `BASE_RPC_URL` | TELx Base pool calc + report | Base archive RPC endpoint |
| `MAINNET_RPC_URL` | block-range validation helpers | Ethereum mainnet RPC (TANIP not live on mainnet, but the config requires the var) |

Use **archive** endpoints — the calculators read historical state and logs across
the full period block range, which pruned nodes cannot serve. The built-in
`GITHUB_TOKEN` covers the PR creation; no additional token is required.

> These secrets are referenced only by name in `.github/workflows/weekly_rewards.yml`
> (`${{ secrets.* }}`). No endpoint URLs or keys are committed to the repo.

---

## Running Manually

```bash
pip install openpyxl requests

python scripts/build_workbook.py \
  --period 38 \
  --template reports/TANIP1_Rewards_Distribution_template.xlsx \
  --output-dir reports
```

Omit `--period` to auto-detect the latest period in `rewards/`.

The calculators (run before the workbook builder in CI) need the RPC secrets
above exported locally to run by hand:

```bash
export POLYGON_RPC_URL=... BASE_RPC_URL=... MAINNET_RPC_URL=...
yarn build
node dist/resolveBlockRange.js                       # TANIP: prints sequential range + period
node dist/app.js polygon=START:END --period=38       # TANIP staker calculator
node dist/resolveTelxRun.js                           # TELx: prints target period + readiness
node dist/calculators/TELxRewardsCalculator.js <poolId>:<period>   # per pool
node dist/telxHumanReadable.js                        # TELx human-readable xlsx
```
