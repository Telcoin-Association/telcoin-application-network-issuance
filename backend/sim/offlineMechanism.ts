/**
 * Offline, deterministic reproduction of the fee-inflation mechanism.
 *
 * No network required. A tiny in-memory "StateView" mock serves the same
 * shape the production code reads (slot0 / globals / tickBitmap / tickInfo),
 * and the VERBATIM production functions run against it. This:
 *
 *   - reproduces the exact 65,099,934 phantom credit offline (Scenario A), and
 *   - demonstrates the GUARD's bi-directional failure (Scenario B): the same
 *     phantom value over-credits when it lands on the period END, and zeroes a
 *     real reward when it lands on the period START.
 *
 * Run: npx ts-node backend/sim/offlineMechanism.ts
 */

const TICK_SPACING = 60;
const Q128 = 2n ** 128n;
const TWO256 = 2n ** 256n;
const POOL = "0xpool" as `0x${string}`;
const SV = "0xsv" as `0x${string}`;

// --- in-memory chain state, keyed by block ---
interface TickInfo {
  liquidityGross: bigint;
  liquidityNet: bigint;
  fo0: bigint;
  fo1: bigint;
}
interface Snapshot {
  currentTick: number;
  global0: bigint;
  global1: bigint;
  ticks: Map<number, TickInfo>; // ONLY initialized ticks present
}
const SNAPSHOTS = new Map<bigint, Snapshot>();

// build per-word bitmaps from the set of initialized ticks, using the EXACT
// bit math the production findInitializedTickUnder/tickToWord rely on.
function wordAndBit(tick: number): [number, number] {
  let compressed = Math.floor(tick / TICK_SPACING);
  if (tick < 0 && tick % TICK_SPACING !== 0) compressed -= 1;
  return [compressed >> 8, compressed & 255];
}
function bitmapForWord(snap: Snapshot, word: number): bigint {
  let bm = 0n;
  for (const t of snap.ticks.keys()) {
    const [w, b] = wordAndBit(t);
    if (w === word) bm |= 1n << BigInt(b);
  }
  return bm;
}

// minimal mock matching viem's client.readContract surface used by the code
const mockClient: any = {
  async readContract(p: any) {
    const snap = SNAPSHOTS.get(p.blockNumber as bigint)!;
    switch (p.functionName) {
      case "getSlot0":
        return [0n, snap.currentTick, 0, 0];
      case "getFeeGrowthGlobals":
        return [snap.global0, snap.global1];
      case "getTickBitmap":
        return bitmapForWord(snap, Number(p.args[1]));
      case "getTickInfo": {
        const ti = snap.ticks.get(Number(p.args[1]));
        return ti
          ? [ti.liquidityGross, ti.liquidityNet, ti.fo0, ti.fo1]
          : [0n, 0n, 0n, 0n];
      }
      default:
        throw new Error("unexpected call " + p.functionName);
    }
  },
};

// ===========================================================================
// VERBATIM from backend/calculators/TELxRewardsCalculator.ts
// ===========================================================================
function calculateFees(
  liquidity: bigint,
  feeGrowthInside0End: bigint,
  feeGrowthInside1End: bigint,
  feeGrowthInside0Start: bigint,
  feeGrowthInside1Start: bigint,
): { token0Fees: bigint; token1Fees: bigint } {
  // underflow protection: return 0 if current is less than last.
  const feeGrowthDelta0 =
    feeGrowthInside0End >= feeGrowthInside0Start
      ? feeGrowthInside0End - feeGrowthInside0Start
      : 0n;
  const feeGrowthDelta1 =
    feeGrowthInside1End >= feeGrowthInside1Start
      ? feeGrowthInside1End - feeGrowthInside1Start
      : 0n;
  return {
    token0Fees: (feeGrowthDelta0 * liquidity) / Q128,
    token1Fees: (feeGrowthDelta1 * liquidity) / Q128,
  };
}

async function getFeeGrowthInsideOffchain(
  client: any,
  poolId: `0x${string}`,
  stateView: any,
  tickLower: number,
  tickUpper: number,
  tickSpacing: number,
  blockNumber: bigint,
): Promise<{ feeGrowthInside0X128: bigint; feeGrowthInside1X128: bigint }> {
  const [, currentTick] = await client.readContract({
    address: stateView, functionName: "getSlot0", args: [poolId], blockNumber,
  });
  const [feeGrowthGlobal0X128, feeGrowthGlobal1X128] = await client.readContract({
    address: stateView, functionName: "getFeeGrowthGlobals", args: [poolId], blockNumber,
  });
  const safeTickLower = await findInitializedTickUnder(client, poolId, stateView, tickLower, tickSpacing, blockNumber);
  const safeTickUpper = await findInitializedTickUnder(client, poolId, stateView, tickUpper, tickSpacing, blockNumber);
  if (safeTickLower === null || safeTickUpper === null || safeTickLower >= safeTickUpper) {
    return { feeGrowthInside0X128: 0n, feeGrowthInside1X128: 0n };
  }
  const [lowerTickInfoResult, upperTickInfoResult] = await Promise.all([
    client.readContract({ address: stateView, functionName: "getTickInfo", args: [poolId, safeTickLower], blockNumber }),
    client.readContract({ address: stateView, functionName: "getTickInfo", args: [poolId, safeTickUpper], blockNumber }),
  ]);
  const lowerTickInfo = parseTickInfo(lowerTickInfoResult);
  const upperTickInfo = parseTickInfo(upperTickInfoResult);
  let feeGrowthBelow0X128: bigint, feeGrowthBelow1X128: bigint;
  if (currentTick >= tickLower) {
    feeGrowthBelow0X128 = lowerTickInfo.feeGrowthOutside0X128;
    feeGrowthBelow1X128 = lowerTickInfo.feeGrowthOutside1X128;
  } else {
    feeGrowthBelow0X128 = feeGrowthGlobal0X128 - lowerTickInfo.feeGrowthOutside0X128;
    feeGrowthBelow1X128 = feeGrowthGlobal1X128 - lowerTickInfo.feeGrowthOutside1X128;
  }
  let feeGrowthAbove0X128: bigint, feeGrowthAbove1X128: bigint;
  if (currentTick < tickUpper) {
    feeGrowthAbove0X128 = upperTickInfo.feeGrowthOutside0X128;
    feeGrowthAbove1X128 = upperTickInfo.feeGrowthOutside1X128;
  } else {
    feeGrowthAbove0X128 = feeGrowthGlobal0X128 - upperTickInfo.feeGrowthOutside0X128;
    feeGrowthAbove1X128 = feeGrowthGlobal1X128 - upperTickInfo.feeGrowthOutside1X128;
  }
  // NB: production does NOT reduce mod 2^256 here; JS bigint keeps the raw
  // signed result. The on-chain run shows the raw value matches production.
  const feeGrowthInside0X128 = feeGrowthGlobal0X128 - feeGrowthBelow0X128 - feeGrowthAbove0X128;
  const feeGrowthInside1X128 = feeGrowthGlobal1X128 - feeGrowthBelow1X128 - feeGrowthAbove1X128;
  return { feeGrowthInside0X128, feeGrowthInside1X128 };
}

function parseTickInfo(tickInfo: readonly [bigint, bigint, bigint, bigint]) {
  return { feeGrowthOutside0X128: tickInfo[2], feeGrowthOutside1X128: tickInfo[3] };
}

async function findInitializedTickUnder(
  client: any, poolId: `0x${string}`, stateView: any, startTick: number,
  tickSpacing: number, blockNumber: bigint, searchLimit: number = 2560,
): Promise<number | null> {
  const startWord = tickToWord(startTick, tickSpacing);
  let startCompressed = Math.floor(startTick / tickSpacing);
  if (startTick < 0 && startTick % tickSpacing !== 0) startCompressed -= 1;
  const startBitPos = startCompressed & 255;
  for (let wordOffset = 0; wordOffset < searchLimit; wordOffset++) {
    const currentWord = startWord - wordOffset;
    const bitmap = await getTickBitmap(client, poolId, stateView, currentWord, blockNumber);
    if (bitmap !== 0n) {
      const startBit = wordOffset === 0 ? startBitPos : 255;
      for (let i = startBit; i >= 0; i--) {
        const initialized = (bitmap & (1n << BigInt(i))) !== 0n;
        if (initialized) return (currentWord * 256 + i) * tickSpacing;
      }
    }
  }
  return null;
}

function tickToWord(tick: number, tickSpacing: number): number {
  let compressed = Math.floor(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) compressed -= 1;
  return compressed >> 8;
}

async function getTickBitmap(client: any, poolId: `0x${string}`, stateView: any, wordPosition: number, blockNumber: bigint): Promise<bigint> {
  if (wordPosition < -32768 || wordPosition > 32767) throw new Error("Word position out of int16 range");
  return client.readContract({ address: stateView, functionName: "getTickBitmap", args: [poolId, wordPosition], blockNumber });
}
// ===========================================================================

// canonical: getFeeGrowthInside computed from the TRUE position ticks (no snap),
// in unsigned mod-2^256 arithmetic, exactly like the Solidity view function.
async function canonical(tickLower: number, tickUpper: number, block: bigint) {
  const snap = SNAPSHOTS.get(block)!;
  const lo = snap.ticks.get(tickLower) ?? { fo0: 0n, fo1: 0n } as any;
  const up = snap.ticks.get(tickUpper) ?? { fo0: 0n, fo1: 0n } as any;
  const G1 = snap.global1;
  const below1 = snap.currentTick >= tickLower ? lo.fo1 : G1 - lo.fo1;
  const above1 = snap.currentTick < tickUpper ? up.fo1 : G1 - up.fo1;
  const inside1 = ((G1 - below1 - above1) % TWO256 + TWO256) % TWO256;
  return { feeGrowthInside1X128: inside1 };
}

const fmt = (x: bigint) => `${x} (~${Number(x < 0n ? -x : x).toExponential(3)})`;

async function scenarioA() {
  console.log("\n" + "=".repeat(78));
  console.log("SCENARIO A (offline) - over-credit, mirrors on-chain token 110585");
  console.log("=".repeat(78));
  const tickLower = -233880, tickUpper = -233580;
  const L = 248377324214831n; // real on-chain liquidity for 110585
  const P = 89188334569806566723323839869630n; // real on-chain phantom feeGrowthInside1

  // START: in range, both boundary ticks initialized; feeGrowthInside == 0
  SNAPSHOTS.set(1n, {
    currentTick: -233720, global0: 0n, global1: 1000n,
    ticks: new Map([
      [tickLower, { liquidityGross: 1n, liquidityNet: 1n, fo0: 0n, fo1: 600n }],
      [tickUpper, { liquidityGross: 1n, liquidityNet: 1n, fo0: 0n, fo1: 400n }],
    ]),
  });
  // END: out of range, boundary ticks DE-INITIALIZED; distant snapped ticks carry the phantom
  SNAPSHOTS.set(2n, {
    currentTick: -233940, global0: 0n, global1: 2000n,
    ticks: new Map([
      [-233940, { liquidityGross: 1n, liquidityNet: 1n, fo0: 0n, fo1: P }], // snap target for lower
      [-233640, { liquidityGross: 1n, liquidityNet: 1n, fo0: 0n, fo1: 0n }], // snap target for upper
    ]),
  });

  const bugStart = await getFeeGrowthInsideOffchain(mockClient, POOL, SV, tickLower, tickUpper, TICK_SPACING, 1n);
  const bugEnd = await getFeeGrowthInsideOffchain(mockClient, POOL, SV, tickLower, tickUpper, TICK_SPACING, 2n);
  const canStart = await canonical(tickLower, tickUpper, 1n);
  const canEnd = await canonical(tickLower, tickUpper, 2n);

  const snapLo = await findInitializedTickUnder(mockClient, POOL, SV, tickLower, TICK_SPACING, 2n);
  const snapUp = await findInitializedTickUnder(mockClient, POOL, SV, tickUpper, TICK_SPACING, 2n);
  console.log(`end-block snap: ${tickLower}->${snapLo}, ${tickUpper}->${snapUp}`);
  console.log(`BUGGY     feeGrowthInside1: start=${bugStart.feeGrowthInside1X128}  end=${fmt(bugEnd.feeGrowthInside1X128)}`);
  console.log(`CANONICAL feeGrowthInside1: start=${canStart.feeGrowthInside1X128}  end=${canEnd.feeGrowthInside1X128}`);
  const cBug = calculateFees(L, 0n, bugEnd.feeGrowthInside1X128, 0n, bugStart.feeGrowthInside1X128);
  const cCan = calculateFees(L, 0n, canEnd.feeGrowthInside1X128, 0n, canStart.feeGrowthInside1X128);
  console.log(`credited token1Fees:  BUGGY=${cBug.token1Fees}   CANONICAL=${cCan.token1Fees}`);
  console.log(`=> reproduces 65,099,934 offline: ${cBug.token1Fees === 65099934n ? "YES" : "NO"}`);
}

function scenarioB() {
  console.log("\n" + "=".repeat(78));
  console.log("SCENARIO B - the guard is BI-DIRECTIONAL (same phantom, both orientations)");
  console.log("=".repeat(78));
  const L = 248377324214831n;
  const P = 89188334569806566723323839869630n; // phantom feeGrowthInside1 the snap can produce
  // a REAL in-range fee-growth delta sized to credit ~50,000 TEL-units (delta1 * L / 2^128)
  const realGrowth = (50000n * Q128) / L;

  // Orientation 1: phantom lands on END -> end >= start -> full phantom credited
  const over = calculateFees(L, 0n, P, 0n, 0n);
  // Orientation 2: phantom lands on START -> end < start -> guard returns 0
  const under = calculateFees(L, 0n, realGrowth, 0n, P);
  // Control: same real growth with a clean start -> correct positive credit
  const correct = calculateFees(L, 0n, realGrowth, 0n, 0n);

  console.log(`phantom-at-END   (start=0,    end=phantom): credited token1Fees = ${over.token1Fees}   <- OVER-credit`);
  console.log(`phantom-at-START (start=phantom, end=real):  credited token1Fees = ${under.token1Fees}        <- UNDER-credit (real fees ZEROED)`);
  console.log(`control          (start=0,    end=real):     credited token1Fees = ${correct.token1Fees}   <- what it SHOULD be`);
  console.log(`=> same guard "${"end >= start ? delta : 0"}" both inflates and silently zeroes, depending on which boundary the snap corrupts.`);
}

async function main() {
  console.log("OFFLINE deterministic mechanism reproduction (no RPC)");
  await scenarioA();
  scenarioB();
  console.log();
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
