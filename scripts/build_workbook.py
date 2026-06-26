#!/usr/bin/env python3
"""
TANIP1 staking rewards workbook builder.

Reads staker_rewards_period_NN.json, divides all values by 100 (TEL x100 in JSON),
and appends/updates the period workbook in-place.

Sheets touched:
  - Raw Data          — append 91 rows for new period
  - Period Totals     — append one summary row with all computed metrics
  - Cumulative        — update existing wallet rows, append brand-new wallets
  - Wallet Search     — insert new period row at top of lookup table, update date label

Sheets never touched:
  - Raw Data - Rebate   (historical only: periods 28-29)
  - Pivot Table         (Excel native PivotTable; openpyxl cannot update it)
  - Post-Restart Trends (chart sheet)
"""

import argparse
import json
import shutil
from datetime import date, timedelta
from pathlib import Path

from openpyxl import load_workbook

REWARDS_DIR = "rewards"
PERIOD_FILE_PATTERN = "staker_rewards_period_{}.json"
PERIOD_TMP = "/tmp/tanip1_period.txt"
DIVISOR = 100


# ── helpers ────────────────────────────────────────────────────────────────────

def find_latest_period() -> int:
    files = list(Path(REWARDS_DIR).glob("staker_rewards_period_*.json"))
    if not files:
        raise FileNotFoundError(f"No period files found in {REWARDS_DIR}/")
    return max(int(f.stem.split("_")[-1]) for f in files)


def load_period_json(period: int) -> dict:
    path = Path(REWARDS_DIR) / PERIOD_FILE_PATTERN.format(period)
    with open(path) as fh:
        return json.load(fh)


def parse_incentives(data: dict) -> list[dict]:
    rows = []
    for entry in data.get("stakerIncentives", []):
        meta = entry.get("metadata", {})
        reward     = int(entry.get("reward", 0))          / DIVISOR
        uncapped   = int(meta.get("uncappedAmount", 0))   / DIVISOR
        stake_cap  = int(meta.get("stakeCapAmount", 0))   / DIVISOR
        fees       = int(meta.get("fees", 0))             / DIVISOR
        ref_fees   = int(meta.get("refereeFees", 0))      / DIVISOR
        rows.append({
            "Address":              entry["address"],
            "$TEL Rewards":         reward,
            "Uncapped $TEL Reward": uncapped,
            "Missed $TEL Reward":   uncapped - reward,
            "Stake Cap":            stake_cap,
            "Staker Fees":          fees,
            "Referee Fees":         ref_fees,
            "Total Fees":           fees + ref_fees,
        })
    return rows


def find_data_last_row(ws) -> int:
    """
    Return the index of the last row that contains data.
    Handles sheets where row 1 is blank and row 2 is the header (data starts row 3),
    as well as simpler layouts.
    """
    for row_idx in range(ws.max_row, 0, -1):
        if any(ws.cell(row_idx, c).value is not None for c in range(1, ws.max_column + 1)):
            return row_idx
    return 0


def wednesday_of_week(d: date) -> date:
    """Return the Wednesday on or before the given date."""
    return d - timedelta(days=(d.weekday() - 2) % 7)


# ── Raw Data ───────────────────────────────────────────────────────────────────

def append_raw_data(ws, period: int, rows: list[dict]) -> None:
    """
    Append one row per wallet to Raw Data.

    Expected layout (matches reference workbook):
      Row 1: blank
      Row 2: header
      Row 3+: data

    Column order (reference):
      B: Period | C: Wallet Address | D: $TEL Rewards | E: Uncapped $TEL Reward
      F: Staker Fees | G: Referee Fees | H: Total Fees | I: Missed $TEL Reward
    All in col B onwards (col A blank).
    """
    last = find_data_last_row(ws)
    for r in rows:
        last += 1
        ws.cell(last, 2).value  = period
        ws.cell(last, 3).value  = r["Address"]
        ws.cell(last, 4).value  = r["$TEL Rewards"]
        ws.cell(last, 5).value  = r["Uncapped $TEL Reward"]
        ws.cell(last, 6).value  = r["Staker Fees"]
        ws.cell(last, 7).value  = r["Referee Fees"]
        ws.cell(last, 8).value  = r["Total Fees"]
        ws.cell(last, 9).value  = r["Missed $TEL Reward"]


# ── Period Totals ──────────────────────────────────────────────────────────────

def append_period_totals(ws, period: int, rows: list[dict],
                         week_starting: date,
                         all_raw_ws) -> None:
    """
    Append one summary row to Period Totals.

    Column order (reference, col B onwards, col A blank):
      B: Period | C: Week Starting | D: Sum of Referee Fees | E: Sum of Staker Fees
      F: Sum of Total Fees | G: % of Referee Fees | H: % of Staker Fees
      I: Sum of $TEL Rewards | J: Sum of Uncapped $TEL Reward
      K: Sum of Unclaimed $TEL Reward | L: % of $TEL Rewards
      M: % of Unclaimed $TEL Reward | N: Cumulative Unclaimed $TEL Reward
      O: Weekly Wallet Count | P: Unique Wallet Count | Q: Period New Wallets
      R: Avg $TEL Fees Per Wallet
    """
    # Aggregates for this period (formula columns are computed by Excel)
    tel_rewards  = sum(r["$TEL Rewards"]         for r in rows)
    uncapped     = sum(r["Uncapped $TEL Reward"]  for r in rows)
    staker_fees  = sum(r["Staker Fees"]           for r in rows)
    ref_fees     = sum(r["Referee Fees"]          for r in rows)
    weekly_count = len(rows)

    # Unique wallet count and new wallets require reading all Raw Data history
    this_period_addrs = {r["Address"] for r in rows}
    all_addrs_before = set()
    period_col = None   # find which column holds Period values
    for row in all_raw_ws.iter_rows(min_row=1, max_row=2, values_only=True):
        for ci, v in enumerate(row, 1):
            if v == "Period":
                period_col = ci
                break
        if period_col:
            break

    addr_col = period_col + 1 if period_col else None
    if period_col and addr_col:
        for row in all_raw_ws.iter_rows(min_row=3, values_only=True):
            p = row[period_col - 1]
            a = row[addr_col - 1]
            if p is not None and p != period and a:
                all_addrs_before.add(a)

    new_wallets   = len(this_period_addrs - all_addrs_before)
    unique_total  = len(all_addrs_before | this_period_addrs)

    # Find last row where col B is an integer (period number) to avoid the
    # summary / merged-cell section below the data rows.
    prev_data_row = 2  # fallback
    for ri in range(3, ws.max_row + 1):
        if isinstance(ws.cell(ri, 2).value, int):
            prev_data_row = ri
    ri = prev_data_row + 1  # new row index

    # Hard-value columns
    ws.cell(ri, 2).value  = period
    ws.cell(ri, 3).value  = week_starting
    ws.cell(ri, 4).value  = ref_fees
    ws.cell(ri, 5).value  = staker_fees
    ws.cell(ri, 9).value  = tel_rewards
    ws.cell(ri, 10).value = uncapped
    ws.cell(ri, 15).value = weekly_count
    ws.cell(ri, 16).value = unique_total
    ws.cell(ri, 17).value = new_wallets
    # Formula columns (match the pattern from existing rows)
    ws.cell(ri, 6).value  = f"=D{ri}+E{ri}"              # Sum of Total Fees
    ws.cell(ri, 7).value  = f"=D{ri}/F{ri}"              # % of Referee Fees
    ws.cell(ri, 8).value  = f"=E{ri}/F{ri}"              # % of Staker Fees
    ws.cell(ri, 11).value = f"=J{ri}-I{ri}"              # Sum of Unclaimed
    ws.cell(ri, 12).value = f"=I{ri}/J{ri}"              # % of $TEL Rewards
    ws.cell(ri, 13).value = f"=K{ri}/J{ri}"              # % of Unclaimed
    ws.cell(ri, 14).value = f"=N{prev_data_row}+K{ri}"   # Cumulative Unclaimed
    ws.cell(ri, 18).value = f"=F{ri}/O{ri}"              # Avg Fees Per Wallet


# ── Cumulative ─────────────────────────────────────────────────────────────────

def _cum_formula(ri: int) -> tuple[str, str, str]:
    """Return the three Excel formula strings for Cumulative cols J, K, L."""
    return (
        f"=Cumulative!$E{ri}/Cumulative!$G{ri}",
        f"=J{ri}*Cumulative!$D{ri}",
        f"=K{ri}-Cumulative!$E{ri}",
    )


def update_cumulative(ws, rows: list[dict]) -> None:
    """
    Update existing wallet rows and append brand-new wallets.

    Layout (reference):
      Row 1: blank | Row 2: header | Row 3+: data
      Col A: blank | Col B: Staker Address | Col C: Sum of $TEL Rewards
      Col D: Sum of Uncapped $TEL Reward | Col E: Sum of Staker Fees
      Col F: Sum of Referee Fees | Col G: Sum of Total Fees
      Col H: Sum of Missed $TEL Reward
      Col I: blank
      Col J: % of Staker Fees vs Total Fees  (formula =E/G)
      Col K: Staker Fees $TEL Rewards         (formula =J*D)
      Col L: Staker Rewards vs Fees           (formula =K-E)

    J, K, L are kept as Excel formulas so Excel recalculates on open.
    Only wallet-address rows (col B starts with '0x') are indexed.
    """
    # Build index of existing rows: address → row_index
    # Only include rows where col B is a real address (starts with '0x')
    addr_to_row = {}
    last_wallet_row = 2  # will track the last real data row for appending
    for row_idx in range(3, ws.max_row + 1):
        addr = ws.cell(row_idx, 2).value
        if isinstance(addr, str) and addr.startswith("0x"):
            addr_to_row[addr] = row_idx
            last_wallet_row = row_idx

    new_period_by_addr = {r["Address"]: r for r in rows}

    for addr, r in new_period_by_addr.items():
        if addr in addr_to_row:
            ri = addr_to_row[addr]
            # Add incremental values; existing formulas in J/K/L auto-recalc on open
            ws.cell(ri, 3).value = (ws.cell(ri, 3).value or 0) + r["$TEL Rewards"]
            ws.cell(ri, 4).value = (ws.cell(ri, 4).value or 0) + r["Uncapped $TEL Reward"]
            ws.cell(ri, 5).value = (ws.cell(ri, 5).value or 0) + r["Staker Fees"]
            ws.cell(ri, 6).value = (ws.cell(ri, 6).value or 0) + r["Referee Fees"]
            ws.cell(ri, 7).value = (ws.cell(ri, 7).value or 0) + r["Total Fees"]
            ws.cell(ri, 8).value = (ws.cell(ri, 8).value or 0) + r["Missed $TEL Reward"]
        else:
            # New wallet — append after last real wallet row
            last_wallet_row += 1
            ri = last_wallet_row
            addr_to_row[addr] = ri
            ws.cell(ri, 2).value = addr
            ws.cell(ri, 3).value = r["$TEL Rewards"]
            ws.cell(ri, 4).value = r["Uncapped $TEL Reward"]
            ws.cell(ri, 5).value = r["Staker Fees"]
            ws.cell(ri, 6).value = r["Referee Fees"]
            ws.cell(ri, 7).value = r["Total Fees"]
            ws.cell(ri, 8).value = r["Missed $TEL Reward"]
            # Write formulas for derived columns
            jf, kf, lf = _cum_formula(ri)
            ws.cell(ri, 10).value = jf
            ws.cell(ri, 11).value = kf
            ws.cell(ri, 12).value = lf


# ── Wallet Search ──────────────────────────────────────────────────────────────

def update_wallet_search(ws, period: int, week_starting: date) -> None:
    """
    Insert a new period row at the top of the lookup table and update the
    'Current Period' label.

    Layout (reference):
      Row 1: title
      Row 2: 'Wallet Address:' label (input cell)
      Row 3: blank
      Row 4: summary metrics (formula-driven)
      Row 5: 'Current Period — <date>' label
      Row 6: blank
      Row 7: column headers for per-period lookup table
      Row 8: current period row (period N)
      Row 9+: prior periods descending
      Last row: 'All-Time Total'
    """
    # Update "Current Period" label in row 5, col B
    ws.cell(5, 2).value = f"Current Period — {week_starting.strftime('%b %-d, %Y')}"

    # Find the 'All-Time Total' row to know where to stop
    total_row = None
    for ri in range(8, ws.max_row + 1):
        if ws.cell(ri, 2).value == "All-Time Total":
            total_row = ri
            break

    # Insert a new row at row 8, shifting everything down
    ws.insert_rows(8)
    # Col B = "Week Of" (left blank for new periods; Excel formula fills it later)
    # Col C = "Period"
    ws.cell(8, 3).value = period
    # Cols D–I (indices 4–9): zero placeholders so Excel recalculates on open
    for ci in range(4, 10):
        ws.cell(8, ci).value = 0


# ── Main ───────────────────────────────────────────────────────────────────────

def build(period: int | None, template: str, output_dir: str,
          week_starting: date | None) -> None:

    if period is None:
        period = find_latest_period()
        print(f"Auto-detected latest period: {period}")

    if week_starting is None:
        week_starting = wednesday_of_week(date.today())
        print(f"Week starting defaulted to: {week_starting}")

    print(f"Loading period {period} data...")
    data = load_period_json(period)
    rows = parse_incentives(data)
    print(f"  {len(rows)} staker entries")

    template_path = Path(template)
    if not template_path.exists():
        raise FileNotFoundError(f"Template not found: {template}")

    output_path = Path(output_dir) / f"TANIP1_Rewards_Distribution_Period{period}.xlsx"
    if not output_path.exists():
        shutil.copy(template_path, output_path)
        print(f"Copied template -> {output_path}")
    else:
        print(f"Updating existing: {output_path}")

    wb = load_workbook(output_path)

    # Guard: idempotency — skip if this period is already in Raw Data
    ws_raw = wb["Raw Data"]
    existing_periods = {
        ws_raw.cell(ri, 2).value
        for ri in range(3, ws_raw.max_row + 1)
    }
    if period in existing_periods:
        print(f"Period {period} already present — nothing to do.")
        return

    # --- Step 3: Raw Data (must come before Period Totals wallet-count logic)
    append_raw_data(ws_raw, period, rows)
    print(f"  Raw Data: appended {len(rows)} rows")

    # --- Step 4: Raw Data - Rebate is NOT updated (historical periods 28-29 only)
    print("  Raw Data - Rebate: skipped (historical only)")

    # --- Step 8: Period Totals (needs Raw Data already written for wallet counts)
    ws_tot = wb["Period Totals"]

    append_period_totals(ws_tot, period, rows, week_starting, ws_raw)
    print("  Period Totals: appended summary row")

    # --- Step 5: Cumulative
    ws_cum = wb["Cumulative"]
    update_cumulative(ws_cum, rows)
    print("  Cumulative: updated")

    # --- Step 7: Wallet Search
    if "Wallet Search" in wb.sheetnames:
        update_wallet_search(wb["Wallet Search"], period, week_starting)
        print("  Wallet Search: updated")

    # --- Save
    wb.save(output_path)
    print(f"Saved: {output_path}")

    Path(PERIOD_TMP).write_text(str(period))


def main() -> None:
    parser = argparse.ArgumentParser(description="Build TANIP1 rewards workbook")
    parser.add_argument("--period", type=str, default=None)
    parser.add_argument("--template", required=True)
    parser.add_argument("--output-dir", default="reports")
    parser.add_argument(
        "--week-starting",
        type=str,
        default=None,
        help="YYYY-MM-DD of the Wednesday this period started (defaults to this week's Wednesday)",
    )
    args = parser.parse_args()

    period = int(args.period.strip()) if args.period and args.period.strip() else None
    ws = date.fromisoformat(args.week_starting) if args.week_starting else None

    Path(args.output_dir).mkdir(parents=True, exist_ok=True)
    build(period, args.template, args.output_dir, ws)


if __name__ == "__main__":
    main()
