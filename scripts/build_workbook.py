#!/usr/bin/env python3
"""
TANIP1 staking rewards workbook builder.

Fetches the latest staker_rewards_period_NN.json from the rewards/ directory,
converts raw values (TEL × 100) to TEL amounts, and appends/rebuilds all
sheets in the workbook template.
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

import pandas as pd
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

REWARDS_DIR = "rewards"
PERIOD_FILE_PATTERN = "staker_rewards_period_{}.json"
PERIOD_TMP = "/tmp/tanip1_period.txt"
DIVISOR = 100  # all raw JSON values are TEL × 100


def find_latest_period() -> int:
    files = list(Path(REWARDS_DIR).glob("staker_rewards_period_*.json"))
    if not files:
        raise FileNotFoundError(f"No period files found in {REWARDS_DIR}/")
    numbers = []
    for f in files:
        stem = f.stem  # staker_rewards_period_NN
        try:
            numbers.append(int(stem.split("_")[-1]))
        except ValueError:
            pass
    return max(numbers)


def load_period(period: int) -> dict:
    path = Path(REWARDS_DIR) / PERIOD_FILE_PATTERN.format(period)
    with open(path) as fh:
        return json.load(fh)


def parse_incentives(data: dict) -> list[dict]:
    rows = []
    for entry in data.get("stakerIncentives", []):
        meta = entry.get("metadata", {})
        reward = int(entry.get("reward", 0)) / DIVISOR
        uncapped = int(meta.get("uncappedAmount", 0)) / DIVISOR
        stake_cap = int(meta.get("stakeCapAmount", 0)) / DIVISOR
        fees = int(meta.get("fees", 0)) / DIVISOR
        referee_fees = int(meta.get("refereeFees", 0)) / DIVISOR
        rows.append({
            "Address": entry["address"],
            "$TEL Rewards": reward,
            "Uncapped $TEL Reward": uncapped,
            "Missed $TEL Reward": uncapped - reward,
            "Stake Cap": stake_cap,
            "Staker Fees": fees,
            "Referee Fees": referee_fees,
            "Total Fees": fees + referee_fees,
        })
    return rows


def period_already_in_sheet(ws, period: int) -> bool:
    for row in ws.iter_rows(min_row=2, values_only=True):
        if row and str(row[0]) == str(period):
            return True
    return False


def append_period_totals(ws, period: int, rows: list[dict]) -> None:
    if period_already_in_sheet(ws, period):
        print(f"Period {period} already present in Period Totals — skipping.")
        return
    total_rewards = sum(r["$TEL Rewards"] for r in rows)
    total_fees = sum(r["Total Fees"] for r in rows)
    total_referee = sum(r["Referee Fees"] for r in rows)
    total_staker_fees = sum(r["Staker Fees"] for r in rows)
    staker_count = len(rows)
    ws.append([
        period,
        staker_count,
        total_rewards,
        total_fees,
        total_staker_fees,
        total_referee,
    ])


def append_raw_data(ws, period: int, rows: list[dict]) -> None:
    for r in rows:
        ws.append([
            period,
            r["Address"],
            r["$TEL Rewards"],
            r["Uncapped $TEL Reward"],
            r["Missed $TEL Reward"],
            r["Staker Fees"],
            r["Referee Fees"],
            r["Total Fees"],
        ])


def append_raw_data_rebate(ws, period: int, rows: list[dict]) -> None:
    for r in rows:
        ws.append([
            period,
            r["Address"],
            r["$TEL Rewards"],
            r["Uncapped $TEL Reward"],
            r["Missed $TEL Reward"],
            r["Stake Cap"],
            r["Staker Fees"],
            r["Referee Fees"],
            r["Total Fees"],
        ])


def rebuild_cumulative(wb, raw_sheet_name: str = "Raw Data") -> None:
    if raw_sheet_name not in wb.sheetnames:
        return
    ws_raw = wb[raw_sheet_name]
    data = list(ws_raw.iter_rows(min_row=2, values_only=True))
    if not data:
        return
    df = pd.DataFrame(data, columns=[
        "Period", "Address", "$TEL Rewards", "Uncapped $TEL Reward",
        "Missed $TEL Reward", "Staker Fees", "Referee Fees", "Total Fees",
    ])
    df = df.dropna(subset=["Address"])
    cumulative = (
        df.groupby("Address")[["$TEL Rewards", "Total Fees", "Staker Fees", "Referee Fees"]]
        .sum()
        .reset_index()
        .sort_values("$TEL Rewards", ascending=False)
    )

    sheet_name = "Cumulative"
    if sheet_name in wb.sheetnames:
        del wb[sheet_name]
    ws_cum = wb.create_sheet(sheet_name)
    ws_cum.append(["Address", "$TEL Rewards", "Total Fees", "Staker Fees", "Referee Fees"])
    for _, row in cumulative.iterrows():
        ws_cum.append(list(row))


def rebuild_pivot(wb, raw_sheet_name: str = "Raw Data") -> None:
    if raw_sheet_name not in wb.sheetnames:
        return
    ws_raw = wb[raw_sheet_name]
    data = list(ws_raw.iter_rows(min_row=2, values_only=True))
    if not data:
        return
    df = pd.DataFrame(data, columns=[
        "Period", "Address", "$TEL Rewards", "Uncapped $TEL Reward",
        "Missed $TEL Reward", "Staker Fees", "Referee Fees", "Total Fees",
    ])
    df = df.dropna(subset=["Address"])
    pivot = df.pivot_table(
        index="Address",
        columns="Period",
        values="$TEL Rewards",
        aggfunc="sum",
        fill_value=0,
    ).reset_index()

    sheet_name = "Pivot Table"
    if sheet_name in wb.sheetnames:
        del wb[sheet_name]
    ws_piv = wb.create_sheet(sheet_name)
    ws_piv.append(list(pivot.columns.astype(str)))
    for _, row in pivot.iterrows():
        ws_piv.append(list(row))


def build(period: int | None, template: str, output_dir: str) -> None:
    if period is None:
        period = find_latest_period()
        print(f"Auto-detected latest period: {period}")

    print(f"Loading period {period} data...")
    data = load_period(period)
    rows = parse_incentives(data)
    print(f"  {len(rows)} staker entries found.")

    template_path = Path(template)
    if not template_path.exists():
        raise FileNotFoundError(f"Template not found: {template}")

    output_path = Path(output_dir) / f"TANIP1_Rewards_Distribution_Period{period}.xlsx"
    if not output_path.exists():
        shutil.copy(template_path, output_path)
        print(f"Copied template → {output_path}")
    else:
        print(f"Updating existing file: {output_path}")

    wb = load_workbook(output_path)

    sheet_map = {s.lower(): s for s in wb.sheetnames}

    period_totals_name = sheet_map.get("period totals", "Period Totals")
    if period_totals_name in wb.sheetnames:
        append_period_totals(wb[period_totals_name], period, rows)

    raw_name = sheet_map.get("raw data", "Raw Data")
    if raw_name in wb.sheetnames:
        append_raw_data(wb[raw_name], period, rows)

    rebate_name = sheet_map.get("raw data - rebate", "Raw Data - Rebate")
    if rebate_name in wb.sheetnames:
        append_raw_data_rebate(wb[rebate_name], period, rows)

    rebuild_cumulative(wb, raw_name)
    rebuild_pivot(wb, raw_name)

    wb.save(output_path)
    print(f"Saved: {output_path}")

    Path(PERIOD_TMP).write_text(str(period))
    print(f"Period number written to {PERIOD_TMP}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build TANIP1 rewards workbook")
    parser.add_argument("--period", type=str, default=None,
                        help="Period number (leave blank to auto-detect)")
    parser.add_argument("--template", required=True,
                        help="Path to template .xlsx file")
    parser.add_argument("--output-dir", default="reports",
                        help="Directory to write output workbook")
    args = parser.parse_args()

    period = None
    if args.period and args.period.strip():
        period = int(args.period.strip())

    Path(args.output_dir).mkdir(parents=True, exist_ok=True)
    build(period, args.template, args.output_dir)


if __name__ == "__main__":
    main()
