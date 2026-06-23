/**
 * Period-44 re-run harness (Polygon ETH/TEL).
 *
 * Drives the REAL production code over the real period-44 block range, BOTH WAYS:
 *   - BUGGY: getFeeGrowthInsideOffchain (legacy, recomputes bounds each endpoint)
 *   - FIXED: clampTicksToInitialized + getFeeGrowthInsideOffchainAtBounds (the fix)
 *
 * Position discovery + liquidity timelines come from the production
 * updatePositions(), so the sub-period structure is exactly what the calculator
 * would see. RPC reads are cached to backend/rpc_cache so the run is repeatable.
 *
 * Run: npx ts-node backend/sim/rerunPeriod44.ts
 *
 * LIMITATION (stated honestly): a fully faithful period-44 run is impossible
 * here because the calculator resumes from the period-43 checkpoint, which does
 * not exist (we only have through period 33), and there is no Base RPC. This
 * harness therefore starts from an EMPTY position set and discovers positions
 * from period-44 events. That captures every position that was created or
 * modified during the period - which includes all the narrow-range "phantom"
 * farmers - but NOT long-lived passive positions that emitted no event in the
 * window. Those are understated EQUALLY in both runs, so the buggy-vs-fixed
 * comparison and the phantom collapse remain valid; only the absolute genuine-LP
 * total is a lower bound.
 */
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { polygon } from "viem/chains";
import * as dotenv from "dotenv";
import {
  updatePositions,
  getFeeGrowthInsideOffchain,
  clampTicksToInitialized,
  getFeeGrowthInsideOffchainAtBounds,
  calculateFees,
  NETWORKS,
  type PositionState,
} from "../calculators/TELxRewardsCalculator";
import { cachedReadContract, cachedGetLogs, ensureDataDirectory, CACHE_DIR } from "../helpers";
import { ChainId } from "../config";
dotenv.config();

const RPC = process.env.POLYGON_RPC_URL;
if (!RPC) throw new Error("POLYGON_RPC_URL not set");

// polygon-ETH-TEL
const POOL_ID = "0x25412ca33f9a2069f0520708da3f70a7843374dd46dc1c7e62f6d5002f5f9fa7" as const;
const TICK_SPACING = 60;
const { stateView, positionRegistry, positionManager } = NETWORKS[ChainId.Polygon];

// period-44 Polygon range (from the report; verified to be real mined blocks)
const START_BLOCK = 88229743n;
const END_BLOCK = 88632941n;
const LOG_CHUNK = 50000n;

ensureDataDirectory(CACHE_DIR);
const realClient = createPublicClient({ chain: polygon, transport: http(RPC) }) as PublicClient;

// caching + chunked-getLogs proxy so the heavy archive reads run once
async function cachedGetLogsChunked(params: any): Promise<any[]> {
  if (params.fromBlock === undefined || params.toBlock === undefined) {
    return cachedGetLogs(realClient, params);
  }
  const out: any[] = [];
  for (let from = BigInt(params.fromBlock); from <= BigInt(params.toBlock); from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > BigInt(params.toBlock) ? BigInt(params.toBlock) : from + LOG_CHUNK - 1n;
    const chunk = await cachedGetLogs(realClient, { ...params, fromBlock: from, toBlock: to });
    out.push(...chunk);
  }
  return out;
}
let gapHits = 0;
let subRevertHits = 0;
async function resilientRead(p: any): Promise<any> {
  let bn: bigint | undefined = p.blockNumber;
  for (let i = 0; i < 8; i++) {
    try {
      return await cachedReadContract(realClient, bn === undefined ? p : { ...p, blockNumber: bn });
    } catch (e: any) {
      const msg = String(e?.message || e);
      // burned/unknown token: isTokenSubscribed reverts (zero-address state). not subscribed.
      if (p.functionName === "isTokenSubscribed" && /is not found|revert/i.test(msg)) {
        subRevertHits++;
        return false;
      }
      // Alchemy archive-state gap at this exact block: step back to nearest available block
      if (/is not found/i.test(msg) && bn !== undefined) {
        bn = bn - 1n;
        gapHits++;
        continue;
      }
      throw e;
    }
  }
  if (p.functionName === "isTokenSubscribed") return false;
  throw new Error(`read failed after gap retries: ${p.functionName}`);
}
const client = new Proxy(realClient, {
  get(target, prop, receiver) {
    if (prop === "readContract") return (p: any) => resilientRead(p);
    if (prop === "getLogs") return (p: any) => cachedGetLogsChunked(p);
    const v = Reflect.get(target, prop, receiver);
    return typeof v === "function" ? v.bind(target) : v;
  },
}) as PublicClient;

interface PerPos {
  tokenId: bigint;
  tickLower: number;
  tickUpper: number;
  buggy1: bigint; // token1 (TEL) fees, summed over sub-periods
  fixed1: bigint;
  buggy0: bigint; // token0 (WETH) fees
  fixed0: bigint;
  subscribedBuggy1: bigint; // pot-relevant (subscribed sub-periods only)
  subscribedFixed1: bigint;
  hadPhantom: boolean;
}

async function feesForPosition(tokenId: bigint, position: PositionState): Promise<PerPos> {
  const r: PerPos = {
    tokenId, tickLower: position.tickLower, tickUpper: position.tickUpper,
    buggy1: 0n, fixed1: 0n, buggy0: 0n, fixed0: 0n,
    subscribedBuggy1: 0n, subscribedFixed1: 0n, hadPhantom: false,
  };
  for (let i = 1; i < position.liquidityModifications.length; i++) {
    const prev = position.liquidityModifications[i - 1];
    const curr = position.liquidityModifications[i];
    const L = prev.newLiquidityAmount;
    if (L === 0n || prev.blockNumber === curr.blockNumber) continue;

    // BUGGY path (legacy getFeeGrowthInsideOffchain at each endpoint independently)
    const [bStart, bEnd] = await Promise.all([
      getFeeGrowthInsideOffchain(client, POOL_ID, stateView, position.tickLower, position.tickUpper, TICK_SPACING, prev.blockNumber),
      getFeeGrowthInsideOffchain(client, POOL_ID, stateView, position.tickLower, position.tickUpper, TICK_SPACING, curr.blockNumber),
    ]);
    const cb = calculateFees(L, bEnd.feeGrowthInside0X128, bEnd.feeGrowthInside1X128, bStart.feeGrowthInside0X128, bStart.feeGrowthInside1X128);

    // FIXED path (clamp once at start, reuse bounds at both endpoints)
    let fStart = { feeGrowthInside0X128: 0n, feeGrowthInside1X128: 0n };
    let fEnd = { feeGrowthInside0X128: 0n, feeGrowthInside1X128: 0n };
    const [clL, clU] = await clampTicksToInitialized(client, POOL_ID, stateView, position.tickLower, position.tickUpper, TICK_SPACING, prev.blockNumber);
    if (clL !== null && clU !== null && clL < clU) {
      [fStart, fEnd] = await Promise.all([
        getFeeGrowthInsideOffchainAtBounds(client, POOL_ID, stateView, clL, clU, prev.blockNumber),
        getFeeGrowthInsideOffchainAtBounds(client, POOL_ID, stateView, clL, clU, curr.blockNumber),
      ]);
    }
    const cf = calculateFees(L, fEnd.feeGrowthInside0X128, fEnd.feeGrowthInside1X128, fStart.feeGrowthInside0X128, fStart.feeGrowthInside1X128);

    r.buggy0 += cb.token0Fees; r.buggy1 += cb.token1Fees;
    r.fixed0 += cf.token0Fees; r.fixed1 += cf.token1Fees;
    if (prev.isSubscribed) { r.subscribedBuggy1 += cb.token1Fees; r.subscribedFixed1 += cf.token1Fees; }
    // flag a phantom sub-period: buggy credits >> fixed by a large margin
    if (cb.token1Fees > cf.token1Fees + 1_000_000n) r.hadPhantom = true;
  }
  return r;
}

const tel = (raw: bigint) => (Number(raw) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }); // TEL has 2 decimals

async function main() {
  console.log(`Period-44 Polygon re-run: blocks ${START_BLOCK} -> ${END_BLOCK}`);
  console.log(`stateView=${stateView}\nDiscovering positions from on-chain events (cached)...`);

  const positions = await updatePositions(
    POOL_ID, START_BLOCK, END_BLOCK, client, positionRegistry as Address, positionManager as Address, new Map(),
  );
  console.log(`Discovered ${positions.size} positions with in-period events. Computing fees both ways...\n`);

  const results: PerPos[] = [];
  let n = 0;
  for (const [tokenId, position] of positions.entries()) {
    results.push(await feesForPosition(tokenId, position));
    n++;
    if (n % 10 === 0) process.stdout.write(`  processed ${n}/${positions.size}\r`);
  }

  results.sort((a, b) => (b.buggy1 > a.buggy1 ? 1 : b.buggy1 < a.buggy1 ? -1 : 0));

  const totalBuggy = results.reduce((s, r) => s + r.subscribedBuggy1, 0n);
  const totalFixed = results.reduce((s, r) => s + r.subscribedFixed1, 0n);
  const phantomCount = results.filter((r) => r.hadPhantom).length;

  console.log(`\n${"=".repeat(96)}`);
  console.log(`TOP POSITIONS by buggy TEL-side fees (subscribed pot-relevant in [] )`);
  console.log("=".repeat(96));
  console.log(`tokenId      range                    BUGGY token1 (TEL)        FIXED token1 (TEL)     phantom?`);
  for (const r of results.slice(0, 25)) {
    console.log(
      `${r.tokenId.toString().padEnd(12)} [${r.tickLower},${r.tickUpper}]`.padEnd(40) +
      `${tel(r.buggy1).padStart(22)}   ${tel(r.fixed1).padStart(22)}   ${r.hadPhantom ? "YES" : ""}`,
    );
  }

  console.log(`\n${"=".repeat(96)}`);
  console.log(`REPORT-NAMED POSITIONS`);
  console.log("=".repeat(96));
  for (const id of [110585n, 110646n, 109092n, 110776n]) {
    const r = results.find((x) => x.tokenId === id);
    if (r) {
      console.log(`token ${id}  [${r.tickLower},${r.tickUpper}]  BUGGY token1=${tel(r.buggy1)} TEL   FIXED token1=${tel(r.fixed1)} TEL`);
    } else {
      console.log(`token ${id}  -- not discovered in period-44 event window (may be pre-period / different sub-period)`);
    }
  }

  console.log(`\n${"=".repeat(96)}`);
  console.log(`POOL-LEVEL (subscribed, TEL side only; token0/WETH side excluded for brevity)`);
  console.log("=".repeat(96));
  console.log(`  positions with a phantom sub-period: ${phantomCount} / ${results.length}`);
  console.log(`  BUGGY  total credited (TEL): ${tel(totalBuggy)}`);
  console.log(`  FIXED  total credited (TEL): ${tel(totalFixed)}`);
  if (totalFixed > 0n) {
    console.log(`  inflation factor (buggy/fixed): ${(Number(totalBuggy) / Number(totalFixed)).toFixed(1)}x`);
  }
  console.log(`  => report claims Polygon: real 55,697 TEL vs credited 996,874 TEL (17.9x)`);
  console.log(`\n  [diagnostics] archive-gap block substitutions: ${gapHits} | isTokenSubscribed reverts treated as false: ${subRevertHits}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
