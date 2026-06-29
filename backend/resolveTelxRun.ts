import * as dotenv from "dotenv";
dotenv.config();

import { existsSync, readdirSync, appendFileSync } from "fs";
import {
  POOLS,
  PERIODS,
  NETWORKS,
  TELX_BASE_PATH,
  SupportedChainId,
} from "./calculators/TELxRewardsCalculator";

/**
 * @notice Resolves which TELx period to run next, per pool, with no human input
 *         for the start block.
 *
 * @dev The start of a TELx period is derived inside the calculator from the
 *      previous period's checkpoint end block + 1 (see buildPeriodConfig), so
 *      this resolver only has to determine *which* period is next and confirm
 *      the calculator-owned END boundary for it is in place.
 *
 *      Target period = (latest existing checkpoint period) + 1. A period is
 *      "ready" to run when:
 *        - its END boundary exists: NETWORKS[chain].periodStarts[target] is set
 *          (period N's end = periodStarts[N] - 1), and
 *        - PERIODS includes it (so telxHumanReadable will emit its .xlsx).
 *      If a boundary is missing the resolver reports NOT ready and names the
 *      block that still has to be appended — it never invents one.
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
    const net = NETWORKS[pool.network as SupportedChainId];
    const endBoundary = net.periodStarts[target]; // period N end = periodStarts[N] - 1
    const prevPeriod = latestCheckpointPeriod(pool.name);

    if (prevPeriod !== target - 1) {
      blockers.push(
        `${pool.name}: latest checkpoint is period ${prevPeriod}, expected ${target - 1}`,
      );
    }
    if (endBoundary === undefined) {
      blockers.push(
        `${pool.name} (${pool.network}): missing END boundary periodStarts[${target}] — ` +
          `append the period-${target} boundary block to NETWORKS`,
      );
    } else {
      runs.push(`${pool.poolId}:${target}`);
    }
    console.log(
      `  ${pool.name.padEnd(20)} prev=${prevPeriod} endBoundary=` +
        `${endBoundary !== undefined ? endBoundary : "MISSING"}`,
    );
  }

  const periodsIncludesTarget = PERIODS.includes(target);
  if (!periodsIncludesTarget) {
    blockers.push(
      `PERIODS does not include ${target} — bump its length so telxHumanReadable emits the report`,
    );
  }

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
