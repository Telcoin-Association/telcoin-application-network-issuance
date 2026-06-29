import * as dotenv from "dotenv";
dotenv.config();

import { existsSync, readdirSync, appendFileSync } from "fs";
import { ChainId, config } from "./config";
import {
  getBlockByTimestamp,
  getLastSettlementBlockAndLatestBlock,
} from "./helpers";

/**
 * @notice Resolves the block range and period number for the next epoch run
 *         without any human input.
 *
 * @dev The TANIP-1 epoch boundary is a wall-clock instant (Wednesday 00:00 UTC).
 *      The authoritative starting point is on-chain: `TANIssuanceHistory`
 *      stores `lastSettlementBlock`, so the next epoch must start at
 *      `lastSettlementBlock + 1`. The end of the epoch is the block at the most
 *      recent Wednesday-00:00-UTC boundary, which is always far deeper than the
 *      reorg-safe depth, so `validateStartAndEndBlocks` will accept it.
 *
 *      This script intentionally derives everything from chain state plus the
 *      calendar — it never reads a stored "last block" file, which is the class
 *      of bug that previously caused contiguity gaps between periods.
 *
 * Usage:
 *   yarn ts-node backend/resolveBlockRange.ts
 *   yarn ts-node backend/resolveBlockRange.ts --network polygon
 *
 * Emits, on stdout:
 *   - a human-readable summary
 *   - `ARGS=polygon=<start>:<end> --period=<n>`   (calculator arg string)
 *   - `PERIOD=<n>`
 * When `GITHUB_OUTPUT` is set (GitHub Actions), the same key=value pairs are
 * appended there so later steps can consume them.
 */

const REWARDS_DIR = "./rewards";

function nextPeriodNumber(): number {
  if (!existsSync(REWARDS_DIR)) {
    throw new Error(`Rewards directory not found: ${REWARDS_DIR}`);
  }
  const periods = readdirSync(REWARDS_DIR)
    .map((f) => f.match(/^staker_rewards_period_(\d+)\.json$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]));

  if (periods.length === 0) {
    throw new Error(`No staker_rewards_period_*.json files in ${REWARDS_DIR}`);
  }
  return Math.max(...periods) + 1;
}

/**
 * Most recent epoch boundary at or before `now`. Epoch boundaries fall on
 * Wednesday 00:00 UTC (Wednesday === getUTCDay() 3), matching the published
 * distribution cadence.
 */
function mostRecentEpochBoundary(now: Date): bigint {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0),
  );
  // Walk back to the most recent Wednesday (UTC day 3).
  const daysSinceWednesday = (d.getUTCDay() - 3 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceWednesday);
  return BigInt(Math.floor(d.getTime() / 1000));
}

function parseNetworkArg(args: string[]): "polygon" {
  const idx = args.indexOf("--network");
  if (idx === -1) return "polygon";
  const value = args[idx + 1];
  if (value !== "polygon") {
    // TANIP-1 only runs on Polygon today; mainnet is configured but not live.
    throw new Error(`Unsupported --network value: '${value}' (only 'polygon')`);
  }
  return value;
}

function emit(key: string, value: string): void {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

async function main(): Promise<void> {
  const network = parseNetworkArg(process.argv.slice(2));
  const chainId = ChainId.Polygon;

  const period = nextPeriodNumber();

  const [lastSettlementBlock, latestBlock] =
    await getLastSettlementBlockAndLatestBlock(chainId);

  // SEQUENTIAL INVARIANT: the start block is taken from chain state, never the
  // clock. `increaseClaimableByBatch` sets `lastSettlementBlock = endBlock` when
  // an epoch settles, so `lastSettlementBlock + 1` is exactly the block after the
  // previous epoch's last block — contiguous, with no gaps or overlap, no matter
  // when this run fires. Time (below) only bounds how far the current window
  // extends; it never determines where it starts.
  const startBlock = lastSettlementBlock + 1n;

  const boundaryTimestamp = mostRecentEpochBoundary(new Date());
  const endBlock = await getBlockByTimestamp(chainId, boundaryTimestamp);

  // Guardrails — fail loudly rather than producing a bad range.
  const reorgSafeDepth = config.reorgSafeDepth[chainId];
  if (endBlock > latestBlock - reorgSafeDepth) {
    throw new Error(
      `Resolved endBlock ${endBlock} is not reorg-safe ` +
        `(latest ${latestBlock} - depth ${reorgSafeDepth}). ` +
        `Has a full epoch elapsed since the last settlement?`,
    );
  }
  if (endBlock <= startBlock) {
    throw new Error(
      `Resolved endBlock ${endBlock} <= startBlock ${startBlock}. ` +
        `No new blocks to settle since lastSettlementBlock ` +
        `${lastSettlementBlock}; the epoch may not have closed yet.`,
    );
  }

  console.log("── TANIP-1 epoch range resolution ──");
  console.log(`  network                 : ${network}`);
  console.log(`  next period             : ${period}`);
  console.log(`  lastSettlementBlock     : ${lastSettlementBlock}`);
  console.log(`  startBlock (settle + 1) : ${startBlock}`);
  console.log(`  epoch boundary (UTC)    : ${new Date(Number(boundaryTimestamp) * 1000).toISOString()}`);
  console.log(`  endBlock (at boundary)  : ${endBlock}`);
  console.log(`  latestBlock             : ${latestBlock}`);
  console.log(`  reorg-safe depth        : ${reorgSafeDepth}`);
  console.log("─────────────────────────────────────");

  emit("ARGS", `${network}=${startBlock}:${endBlock} --period=${period}`);
  emit("PERIOD", String(period));
  emit("START_BLOCK", String(startBlock));
  emit("END_BLOCK", String(endBlock));
}

main().catch((error) => {
  console.error("Failed to resolve block range:", error);
  process.exit(1);
});
