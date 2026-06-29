import * as dotenv from "dotenv";
dotenv.config();

import { existsSync, readdirSync, appendFileSync } from "fs";
import {
  POOLS,
  TELX_BASE_PATH,
} from "./calculators/TELxRewardsCalculator";

/**
 * @notice Resolves which TELx period to run next with zero human input.
 *
 * @dev Both block range boundaries are now fully automatic:
 *      - Start: derived inside the calculator from the previous period's
 *        checkpoint endBlock + 1 (see buildPeriodConfig / previousPeriodEndBlock).
 *      - End: derived from the most recent Wednesday 00:00 UTC epoch boundary
 *        queried on-chain (see buildPeriodConfig / mostRecentEpochBoundary +
 *        getBlockByTimestamp). No manual periodStarts entry is required.
 *
 *      Target period = max(latest checkpoint period across all pools) + 1.
 *      TELX_READY=true as long as all pools have a checkpoint for target - 1.
 *
 * Usage:
 *   yarn ts-node backend/resolveTelxRun.ts
 *
 * Emits (stdout, and GITHUB_OUTPUT when set):
 *   TELX_PERIOD=<n>
 *   TELX_READY=true|false
 *   TELX_RUNS=<poolId>:<n> <poolId>:<n> ...   (space-separated; empty if not ready)
 */

function latestCheckpointPeriod(poolName: string): number {
  if (!existsSync(TELX_BASE_PATH)) {
    throw new Error(`Checkpoint directory not found: ${TELX_BASE_PATH}`);
  }
  // Match canonical checkpoints only (ignore *.rerun.json and *.xlsx).
  const re = new RegExp(`^${poolName}-(\\d+)\\.json$`);
  const periods = readdirSync(TELX_BASE_PATH)
    .map((f) => f.match(re))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]));
  if (periods.length === 0) {
    throw new Error(`No checkpoints found for pool ${poolName}`);
  }
  return Math.max(...periods);
}

function emit(key: string, value: string): void {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function main(): void {
  // All pools advance together; the next period is one past the furthest pool.
  const latestPerPool = POOLS.map((p) => latestCheckpointPeriod(p.name));
  const target = Math.max(...latestPerPool) + 1;

  console.log("── TELx run resolution ──");
  console.log(`  target period : ${target}`);

  const blockers: string[] = [];
  const runs: string[] = [];

  for (const pool of POOLS) {
    const prevPeriod = latestCheckpointPeriod(pool.name);

    if (prevPeriod !== target - 1) {
      blockers.push(
        `${pool.name}: latest checkpoint is period ${prevPeriod}, expected ${target - 1}`,
      );
    } else {
      runs.push(`${pool.poolId}:${target}`);
    }
    console.log(
      `  ${pool.name.padEnd(20)} prev=${prevPeriod}`,
    );
  }

  // End block is now derived from the epoch boundary on-chain — no manual
  // periodStarts entry required. The only blocker is a missing prior checkpoint.
  const ready = blockers.length === 0;
  console.log("─────────────────────────");
  if (!ready) {
    console.log("NOT READY:");
    for (const b of blockers) console.log(`  - ${b}`);
  }

  emit("TELX_PERIOD", String(target));
  emit("TELX_READY", String(ready));
  emit("TELX_RUNS", ready ? runs.join(" ") : "");
}

main();
