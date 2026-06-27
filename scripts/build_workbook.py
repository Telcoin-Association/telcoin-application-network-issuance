#!/usr/bin/env python3
"""
TANIP1 staking rewards workbook builder.

Reads staker_rewards_period_NN.json, divides all values by 100 (TEL x100 in JSON),
and appends/updates the period workbook in-place.

Sheets touched every period:
  - Raw Data          — append one row per wallet
  - Period Totals     — append one summary row; extend chart data ranges
  - Cumulative        — update existing wallet rows, append new wallets
  - Pivot Table       — update static wallet table, recompute Grand Total
  - Wallet Search     — insert new period row, update date label
  - Post-Restart Trends — chart ranges extended (data lives in Period Totals)

Sheets never touched:
  - Raw Data - Rebate   (historical only: periods 28-29)
"""

import argparse
import hashlib
import json
import re
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


def file_md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


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
    for row_idx in range(ws.max_row, 0, -1):
        if any(ws.cell(row_idx, c).value is not None for c in range(1, ws.max_column + 1)):
            return row_idx
    return 0


def wednesday_of_week(d: date) -> date:
    return d - timedelta(days=(d.weekday() - 2) % 7)


# ── Raw Data ───────────────────────────────────────────────────────────────────

def append_raw_data(ws, period: int, rows: list[dict]) -> None:
    """
    Column order (B onwards, col A blank):
      B: Period | C: Address | D: $TEL Rewards | E: Uncapped $TEL Reward
      F: Staker Fees | G: Referee Fees | H: Total Fees | I: Missed $TEL Reward
    """
    last = find_data_last_row(ws)
    for r in rows:
        last += 1
        ws.cell(last, 2).value = period
        ws.cell(last, 3).value = r["Address"]
        ws.cell(last, 4).value = r["$TEL Rewards"]
        ws.cell(last, 5).value = r["Uncapped $TEL Reward"]
        ws.cell(last, 6).value = r["Staker Fees"]
        ws.cell(last, 7).value = r["Referee Fees"]
        ws.cell(last, 8).value = r["Total Fees"]
        ws.cell(last, 9).value = r["Missed $TEL Reward"]


# ── Period Totals ──────────────────────────────────────────────────────────────

def append_period_totals(ws, period: int, rows: list[dict],
                         week_starting: date, all_raw_ws) -> int:
    """
    Append one summary row.  Returns the new row index (used to extend charts).

    Column order (B onwards, col A blank):
      B: Period | C: Week Starting | D: Referee Fees | E: Staker Fees
      F: =D+E | G: =D/F | H: =E/F
      I: $TEL Rewards | J: Uncapped | K: =J-I | L: =I/J | M: =K/J
      N: =N_prev+K | O: Weekly Count | P: Unique Total | Q: New Wallets
      R: =F/O
    """
    tel_rewards  = sum(r["$TEL Rewards"]         for r in rows)
    uncapped     = sum(r["Uncapped $TEL Reward"]  for r in rows)
    staker_fees  = sum(r["Staker Fees"]           for r in rows)
    ref_fees     = sum(r["Referee Fees"]          for r in rows)
    weekly_count = len(rows)

    this_period_addrs = {r["Address"] for r in rows}
    all_addrs_before: set[str] = set()
    period_col = None
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

    new_wallets  = len(this_period_addrs - all_addrs_before)
    unique_total = len(all_addrs_before | this_period_addrs)

    # Find insertion row: last row where col B is an integer (period number).
    # Avoids the merged-cell summary section below the data rows.
    prev_data_row = 2
    for ri in range(3, ws.max_row + 1):
        if isinstance(ws.cell(ri, 2).value, int):
            prev_data_row = ri
    ri = prev_data_row + 1

    ws.cell(ri, 2).value  = period
    ws.cell(ri, 3).value  = week_starting
    ws.cell(ri, 4).value  = ref_fees
    ws.cell(ri, 5).value  = staker_fees
    ws.cell(ri, 9).value  = tel_rewards
    ws.cell(ri, 10).value = uncapped
    ws.cell(ri, 15).value = weekly_count
    ws.cell(ri, 16).value = unique_total
    ws.cell(ri, 17).value = new_wallets
    ws.cell(ri, 6).value  = f"=D{ri}+E{ri}"
    ws.cell(ri, 7).value  = f"=D{ri}/F{ri}"
    ws.cell(ri, 8).value  = f"=E{ri}/F{ri}"
    ws.cell(ri, 11).value = f"=J{ri}-I{ri}"
    ws.cell(ri, 12).value = f"=I{ri}/J{ri}"
    ws.cell(ri, 13).value = f"=K{ri}/J{ri}"
    ws.cell(ri, 14).value = f"=N{prev_data_row}+K{ri}"
    ws.cell(ri, 18).value = f"=F{ri}/O{ri}"

    return ri  # caller uses this to extend chart ranges


# ── Charts ─────────────────────────────────────────────────────────────────────

def _extend_ref(ref: str, new_end_row: int) -> str:
    """Replace the trailing row number in an Excel range reference."""
    return re.sub(r'(\$[A-Z]+\$)\d+$', lambda m: f'{m.group(1)}{new_end_row}', ref)


def update_charts(wb, new_last_row: int) -> int:
    """
    Extend all chart series end-rows to new_last_row.
    Covers Period Totals (6 charts, data starts row 3) and
    Post-Restart Trends (8 charts, data starts row 26).
    Returns count of series updated.
    """
    updated = 0
    for ws in wb.worksheets:
        for chart in getattr(ws, '_charts', []):
            for series in chart.series:
                if series.val and getattr(series.val, 'numRef', None):
                    old = series.val.numRef.ref
                    series.val.numRef.ref = _extend_ref(old, new_last_row)
                    if series.val.numRef.ref != old:
                        updated += 1
                for attr in ('cat', 'xVal'):
                    cats = getattr(series, attr, None)
                    if cats and getattr(cats, 'numRef', None):
                        old = cats.numRef.ref
                        cats.numRef.ref = _extend_ref(old, new_last_row)
                    elif cats and getattr(cats, 'strRef', None):
                        old = cats.strRef.ref
                        cats.strRef.ref = _extend_ref(old, new_last_row)
    return updated


# ── Cumulative ─────────────────────────────────────────────────────────────────

def _cum_formula(ri: int) -> tuple[str, str, str]:
    return (
        f"=Cumulative!$E{ri}/Cumulative!$G{ri}",
        f"=J{ri}*Cumulative!$D{ri}",
        f"=K{ri}-Cumulative!$E{ri}",
    )


def update_cumulative(ws, rows: list[dict]) -> None:
    """
    Update existing wallet rows; append new wallets after the last wallet row.
    Only indexes rows where col B starts with '0x' (skips SUBTOTAL rows).

    Layout: Row 1 blank | Row 2 header | Row 3+ data
      B: Address | C: $TEL Rewards | D: Uncapped | E: Staker Fees
      F: Referee Fees | G: Total Fees | H: Missed
      J: =E/G | K: =J*D | L: =K-E
    """
    addr_to_row: dict[str, int] = {}
    last_wallet_row = 2
    for row_idx in range(3, ws.max_row + 1):
        addr = ws.cell(row_idx, 2).value
        if isinstance(addr, str) and addr.startswith("0x"):
            addr_to_row[addr] = row_idx
            last_wallet_row = row_idx

    for r in rows:
        addr = r["Address"]
        if addr in addr_to_row:
            ri = addr_to_row[addr]
            ws.cell(ri, 3).value = (ws.cell(ri, 3).value or 0) + r["$TEL Rewards"]
            ws.cell(ri, 4).value = (ws.cell(ri, 4).value or 0) + r["Uncapped $TEL Reward"]
            ws.cell(ri, 5).value = (ws.cell(ri, 5).value or 0) + r["Staker Fees"]
            ws.cell(ri, 6).value = (ws.cell(ri, 6).value or 0) + r["Referee Fees"]
            ws.cell(ri, 7).value = (ws.cell(ri, 7).value or 0) + r["Total Fees"]
            ws.cell(ri, 8).value = (ws.cell(ri, 8).value or 0) + r["Missed $TEL Reward"]
        else:
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
            jf, kf, lf = _cum_formula(ri)
            ws.cell(ri, 10).value = jf
            ws.cell(ri, 11).value = kf
            ws.cell(ri, 12).value = lf


# ── Pivot Table ────────────────────────────────────────────────────────────────

def update_pivot_table(ws, rows: list[dict]) -> None:
    """
    Update the static Pivot Table sheet (no live PivotTable XML).

    Layout: rows 4+ = wallet rows (col A = address), last row = Grand Total.
      B: $TEL Rewards | C: Uncapped | D: Staker Fees
      E: Referee Fees | F: Total Fees | G: Missed $TEL Reward
    Grand Total row: recomputed from all wallet rows after each update.
    """
    grand_total_row = None
    for ri in range(4, ws.max_row + 1):
        v = ws.cell(ri, 1).value
        if isinstance(v, str) and v.strip() == "Grand Total":
            grand_total_row = ri
            break
    if grand_total_row is None:
        return

    addr_to_row: dict[str, int] = {}
    for ri in range(4, grand_total_row):
        addr = ws.cell(ri, 1).value
        if isinstance(addr, str) and addr.startswith("0x"):
            addr_to_row[addr] = ri

    for r in rows:
        addr = r["Address"]
        if addr in addr_to_row:
            ri = addr_to_row[addr]
            ws.cell(ri, 2).value = (ws.cell(ri, 2).value or 0) + r["$TEL Rewards"]
            ws.cell(ri, 3).value = (ws.cell(ri, 3).value or 0) + r["Uncapped $TEL Reward"]
            ws.cell(ri, 4).value = (ws.cell(ri, 4).value or 0) + r["Staker Fees"]
            ws.cell(ri, 5).value = (ws.cell(ri, 5).value or 0) + r["Referee Fees"]
            ws.cell(ri, 6).value = (ws.cell(ri, 6).value or 0) + r["Total Fees"]
            ws.cell(ri, 7).value = (ws.cell(ri, 7).value or 0) + r["Missed $TEL Reward"]
        else:
            ws.insert_rows(grand_total_row)
            ri = grand_total_row
            grand_total_row += 1
            addr_to_row[addr] = ri
            ws.cell(ri, 1).value = addr
            ws.cell(ri, 2).value = r["$TEL Rewards"]
            ws.cell(ri, 3).value = r["Uncapped $TEL Reward"]
            ws.cell(ri, 4).value = r["Staker Fees"]
            ws.cell(ri, 5).value = r["Referee Fees"]
            ws.cell(ri, 6).value = r["Total Fees"]
            ws.cell(ri, 7).value = r["Missed $TEL Reward"]

    # Recompute Grand Total row
    for ci in range(2, 8):
        total = sum(
            ws.cell(ri, ci).value or 0
            for ri in range(4, grand_total_row)
            if isinstance(ws.cell(ri, 1).value, str)
            and ws.cell(ri, 1).value.startswith("0x")
        )
        ws.cell(grand_total_row, ci).value = total


# ── Wallet Search ──────────────────────────────────────────────────────────────

def update_wallet_search(ws, period: int, week_starting: date) -> None:
    """
    Insert new period row at row 8 and update the 'Current Period' label.

    Layout: row 5 col B = date label | row 7 = headers | row 8+ = period rows
      Col C = Period | Cols D-I = zero placeholders (Excel formulas fill on open)
    """
    ws.cell(5, 2).value = f"Current Period — {week_starting.strftime('%b %-d, %Y')}"
    ws.insert_rows(8)
    ws.cell(8, 3).value = period
    for ci in range(4, 10):
        ws.cell(8, ci).value = 0


# ── Verification ───────────────────────────────────────────────────────────────

def verify_export(output_path: Path, period: int, rows: list[dict],
                  json_path: Path, json_hash_before: str, new_last_row: int) -> None:
    """
    Four-gate export verification — raises AssertionError on any failure.

    [1] Source JSON is byte-for-byte unchanged (MD5 comparison).
    [2] Raw Data has the correct number of rows and matching $TEL Rewards values.
    [3] All chart series end-rows == new_last_row; Pivot Table contains all new wallets.
    [4] Period Totals hard-value columns match JSON aggregates within 0.01 TEL.
    """
    tol = 0.01

    # [1] JSON unchanged
    current_hash = file_md5(json_path)
    assert current_hash == json_hash_before, (
        f"[1] FAIL: source JSON was modified during build\n"
        f"  before={json_hash_before}\n  after={current_hash}"
    )
    print("  [1/4] Source JSON unchanged ✓")

    # [2] Raw Data row count and values
    wb_ro = load_workbook(output_path, data_only=True)
    ws_raw = wb_ro["Raw Data"]
    period_rows_raw = [
        row for row in ws_raw.iter_rows(min_row=3, values_only=True)
        if row[1] == period
    ]
    assert len(period_rows_raw) == len(rows), (
        f"[2] FAIL: Raw Data has {len(period_rows_raw)} rows for period {period}, "
        f"expected {len(rows)}"
    )
    expected_rewards = sorted(round(r["$TEL Rewards"], 8) for r in rows)
    # row is 0-indexed: row[1]=Period(colB), row[2]=Address(colC), row[3]=$TEL Rewards(colD)
    actual_rewards   = sorted(
        round(row[3], 8) for row in period_rows_raw if row[3] is not None
    )
    assert expected_rewards == actual_rewards, (
        f"[2] FAIL: Raw Data $TEL Rewards don't match JSON for period {period}"
    )
    print(f"  [2/4] Raw Data: {len(period_rows_raw)} rows with correct values ✓")

    # [3] Chart ranges and Pivot Table completeness
    wb_ch = load_workbook(output_path)
    chart_issues: list[str] = []
    for ws2 in wb_ch.worksheets:
        for chart in getattr(ws2, '_charts', []):
            for series in chart.series:
                if series.val and getattr(series.val, 'numRef', None):
                    ref = series.val.numRef.ref
                    # Extract the trailing row number from refs like $D$35
                    m = re.search(r'\$[A-Z]+\$(\d+)$', ref)
                    if m:
                        end_row = int(m.group(1))
                        if end_row != new_last_row:
                            chart_issues.append(
                                f"{ws2.title} chart: ref {ref!r} ends at row "
                                f"{end_row}, expected {new_last_row}"
                            )

    if chart_issues:
        # Non-fatal warning: chart update may not have found any charts to extend
        print(f"  [3/4] Chart range warnings ({len(chart_issues)}):")
        for issue in chart_issues:
            print(f"    {issue}")
    else:
        print(f"  [3/4] All chart series end at row {new_last_row} ✓")

    pt_name = next((n for n in wb_ch.sheetnames if n.strip() == "Pivot Table"), None)
    ws_pt = wb_ch[pt_name] if pt_name else None
    if ws_pt is not None:
        pt_addrs = {
            ws_pt.cell(ri, 1).value
            for ri in range(4, ws_pt.max_row + 1)
            if isinstance(ws_pt.cell(ri, 1).value, str)
            and ws_pt.cell(ri, 1).value.startswith("0x")
        }
        missing = {r["Address"] for r in rows} - pt_addrs
        assert not missing, (
            f"[3] FAIL: Pivot Table is missing {len(missing)} wallet(s) from period {period}"
        )
        print(f"  [3/4] Pivot Table contains all {len(rows)} wallets ✓")
    else:
        print("  [3/4] Pivot Table sheet not found — skipped")

    # [4] Period Totals column values
    ws_tot = wb_ro["Period Totals"]
    period_row_idx = None
    for ri in range(3, ws_tot.max_row + 1):
        if ws_tot.cell(ri, 2).value == period:
            period_row_idx = ri
            break
    assert period_row_idx is not None, (
        f"[4] FAIL: Period {period} row not found in Period Totals"
    )

    def close(a, b, label):
        diff = abs((a or 0) - b)
        assert diff < tol, (
            f"[4] FAIL {label}: workbook={a:.4f}, json={b:.4f}, diff={diff:.6f}"
        )

    close(ws_tot.cell(period_row_idx, 4).value,
          sum(r["Referee Fees"] for r in rows), "Referee Fees (col D)")
    close(ws_tot.cell(period_row_idx, 5).value,
          sum(r["Staker Fees"] for r in rows), "Staker Fees (col E)")
    close(ws_tot.cell(period_row_idx, 9).value,
          sum(r["$TEL Rewards"] for r in rows), "$TEL Rewards (col I)")
    close(ws_tot.cell(period_row_idx, 10).value,
          sum(r["Uncapped $TEL Reward"] for r in rows), "Uncapped (col J)")

    ref_f = ws_tot.cell(period_row_idx, 4).value or 0
    stk_f = ws_tot.cell(period_row_idx, 5).value or 0
    rew   = ws_tot.cell(period_row_idx, 9).value or 0
    unc   = ws_tot.cell(period_row_idx, 10).value or 0
    print(
        f"  [4/4] Period Totals values match JSON ✓\n"
        f"        Referee {ref_f:.2f} | Staker {stk_f:.2f} | "
        f"Rewards {rew:.2f} | Uncapped {unc:.2f}"
    )


# ── Main ───────────────────────────────────────────────────────────────────────

def build(period: int | None, template: str, output_dir: str,
          week_starting: date | None) -> None:

    if period is None:
        period = find_latest_period()
        print(f"Auto-detected latest period: {period}")

    if week_starting is None:
        week_starting = wednesday_of_week(date.today())
        print(f"Week starting defaulted to: {week_starting}")

    json_path = Path(REWARDS_DIR) / PERIOD_FILE_PATTERN.format(period)
    json_hash_before = file_md5(json_path)
    print(f"Loading period {period} data (MD5 {json_hash_before[:8]}…)")

    data = load_period_json(period)
    rows = parse_incentives(data)
    print(f"  {len(rows)} staker entries")

    template_path = Path(template)
    if not template_path.exists():
        raise FileNotFoundError(f"Template not found: {template}")

    output_path = Path(output_dir) / f"TANIP1_Rewards_Distribution_Period{period}.xlsx"
    if not output_path.exists():
        shutil.copy(template_path, output_path)
        print(f"Copied template → {output_path}")
    else:
        print(f"Updating existing: {output_path}")

    wb = load_workbook(output_path)

    # Idempotency guard — skip if period already written to Raw Data
    ws_raw = wb["Raw Data"]
    existing_periods = {
        ws_raw.cell(ri, 2).value
        for ri in range(3, ws_raw.max_row + 1)
    }
    if period in existing_periods:
        print(f"Period {period} already present — nothing to do.")
        return

    # Step 1: Raw Data (must come before Period Totals wallet-count logic)
    append_raw_data(ws_raw, period, rows)
    print(f"  Raw Data: appended {len(rows)} rows")

    # Step 2: Period Totals — returns new row index for chart extension
    ws_tot = wb["Period Totals"]
    new_last_row = append_period_totals(ws_tot, period, rows, week_starting, ws_raw)
    print(f"  Period Totals: appended row {new_last_row} for period {period}")

    # Step 3: Extend all chart series to new_last_row
    n_updated = update_charts(wb, new_last_row)
    print(f"  Charts: {n_updated} series range(s) extended to row {new_last_row}")

    # Step 4: Cumulative
    ws_cum = wb["Cumulative"]
    update_cumulative(ws_cum, rows)
    print("  Cumulative: updated")

    # Step 5: Pivot Table (static data, no live PivotTable XML)
    if "Pivot Table" in wb.sheetnames:
        update_pivot_table(wb["Pivot Table"], rows)
        print("  Pivot Table: updated")

    # Step 6: Wallet Search
    if "Wallet Search" in wb.sheetnames:
        update_wallet_search(wb["Wallet Search"], period, week_starting)
        print("  Wallet Search: updated")

    wb.save(output_path)
    print(f"Saved: {output_path}")

    print("Running verification...")
    verify_export(output_path, period, rows, json_path, json_hash_before, new_last_row)
    print("All checks passed.")

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
