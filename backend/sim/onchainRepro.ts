/**
 * On-chain reproduction harness for the "fee-inflation" report (period 44).
 *
 * Goal: independently test the report's claims using the REAL production code
 * path against REAL Polygon archive state, then compare three computations at
 * the exact blocks the report cites:
 *
 *   (1) BUGGY     - the production getFeeGrowthInsideOffchain + findInitializedTickUnder
 *                   (copied verbatim from backend/calculators/TELxRewardsCalculator.ts)
 *   (2) CANONICAL - StateView.getFeeGrowthInside (the on-chain view function)
 *   (3) FIXED     - the report's proposed clamp-once-at-start approach
 *
 * Run: npx ts-node backend/sim/onchainRepro.ts
 *
 * NOTE: the functions in the "VERBATIM" block below are copied byte-for-byte
 * from TELxRewardsCalculator.ts so this harness exercises the exact logic that
 * runs in production. Diff them against the source to confirm fidelity.
 */
import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { polygon } from "viem/chains";
import * as dotenv from "dotenv";
dotenv.config();

const RPC = process.env.POLYGON_RPC_URL;
if (!RPC) throw new Error("POLYGON_RPC_URL not set");

const client = createPublicClient({
  chain: polygon,
  transport: http(RPC),
}) as PublicClient;

// --- polygon-ETH-TEL pool config (from TELxRewardsCalculator.ts) ---
const POOL_ID =
  "0x25412ca33f9a2069f0520708da3f70a7843374dd46dc1c7e62f6d5002f5f9fa7" as const;
const STATE_VIEW = "0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a" as Address;
const POSITION_MANAGER = "0x1Ec2eBf4F37E7363FDfe3551602425af0B3ceef9" as Address;
const TICK_SPACING = 60;
// currency0 = WETH, currency1 = TEL (denominator). credited "TEL" figure = token1Fees.

const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 id) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) external view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
  "function getFeeGrowthGlobals(bytes32 poolId) external view returns (uint256 feeGrowthGlobal0, uint256 feeGrowthGlobal1)",
  "function getTickBitmap(bytes32 poolId, int16 wordPosition) external view returns (uint256)",
  "function getTickInfo(bytes32 poolId, int24 tick) external view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128)",
]);
const POSITION_MANAGER_ABI = parseAbi([
  "function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity)",
]);

// ===========================================================================
// VERBATIM from backend/calculators/TELxRewardsCalculator.ts (the buggy path)
// ===========================================================================
function calculateFees(
  liquidity: bigint,
  feeGrowthInside0End: bigint,
  feeGrowthInside1End: bigint,
  feeGrowthInside0Start: bigint,
  feeGrowthInside1Start: bigint,
): { token0Fees: bigint; token1Fees: bigint } {
  const Q128 = 2n ** 128n;
  // underflow protection: return 0 if current is less than last. this also ignores massive fee growth gained by JIT liquidity actions
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
  client: PublicClient,
  poolId: `0x${string}`,
  stateView: Address,
  tickLower: number,
  tickUpper: number,
  tickSpacing: number,
  blockNumber: bigint,
): Promise<{ feeGrowthInside0X128: bigint; feeGrowthInside1X128: bigint }> {
  const [, currentTick] = await client.readContract({
    address: stateView,
    abi: STATE_VIEW_ABI,
    functionName: "getSlot0",
    args: [poolId],
    blockNumber,
  });
  const [feeGrowthGlobal0X128, feeGrowthGlobal1X128] =
    await client.readContract({
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: "getFeeGrowthGlobals",
      args: [poolId],
      blockNumber,
    });

  // find nearest initialized ticks by searching DOWNWARD for both
  const safeTickLower = await findInitializedTickUnder(
    client,
    poolId,
    stateView,
    tickLower,
    tickSpacing,
    blockNumber,
  );
  const safeTickUpper = await findInitializedTickUnder(
    client,
    poolId,
    stateView,
    tickUpper,
    tickSpacing,
    blockNumber,
  );

  if (
    safeTickLower === null ||
    safeTickUpper === null ||
    safeTickLower >= safeTickUpper
  ) {
    return { feeGrowthInside0X128: 0n, feeGrowthInside1X128: 0n };
  }

  // replicate getFeeGrowthInside on-chain logic
  const [lowerTickInfoResult, upperTickInfoResult] = await Promise.all([
    client.readContract({
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: "getTickInfo",
      args: [poolId, safeTickLower],
      blockNumber,
    }),
    client.readContract({
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: "getTickInfo",
      args: [poolId, safeTickUpper],
      blockNumber,
    }),
  ]);

  const lowerTickInfo = parseTickInfo(lowerTickInfoResult);
  const upperTickInfo = parseTickInfo(upperTickInfoResult);

  let feeGrowthBelow0X128: bigint;
  let feeGrowthBelow1X128: bigint;
  if (currentTick >= tickLower) {
    feeGrowthBelow0X128 = lowerTickInfo.feeGrowthOutside0X128;
    feeGrowthBelow1X128 = lowerTickInfo.feeGrowthOutside1X128;
  } else {
    feeGrowthBelow0X128 =
      feeGrowthGlobal0X128 - lowerTickInfo.feeGrowthOutside0X128;
    feeGrowthBelow1X128 =
      feeGrowthGlobal1X128 - lowerTickInfo.feeGrowthOutside1X128;
  }

  let feeGrowthAbove0X128: bigint;
  let feeGrowthAbove1X128: bigint;
  if (currentTick < tickUpper) {
    feeGrowthAbove0X128 = upperTickInfo.feeGrowthOutside0X128;
    feeGrowthAbove1X128 = upperTickInfo.feeGrowthOutside1X128;
  } else {
    feeGrowthAbove0X128 =
      feeGrowthGlobal0X128 - upperTickInfo.feeGrowthOutside0X128;
    feeGrowthAbove1X128 =
      feeGrowthGlobal1X128 - upperTickInfo.feeGrowthOutside1X128;
  }

  const feeGrowthInside0X128 =
    feeGrowthGlobal0X128 - feeGrowthBelow0X128 - feeGrowthAbove0X128;
  const feeGrowthInside1X128 =
    feeGrowthGlobal1X128 - feeGrowthBelow1X128 - feeGrowthAbove1X128;

  return { feeGrowthInside0X128, feeGrowthInside1X128 };
}

function parseTickInfo(tickInfo: readonly [bigint, bigint, bigint, bigint]): {
  feeGrowthOutside0X128: bigint;
  feeGrowthOutside1X128: bigint;
} {
  return {
    feeGrowthOutside0X128: tickInfo[2],
    feeGrowthOutside1X128: tickInfo[3],
  };
}

async function findInitializedTickUnder(
  client: PublicClient,
  poolId: `0x${string}`,
  stateView: Address,
  startTick: number,
  tickSpacing: number,
  blockNumber: bigint,
  searchLimit: number = 2560,
): Promise<number | null> {
  const startWord = tickToWord(startTick, tickSpacing);

  let startCompressed = Math.floor(startTick / tickSpacing);
  if (startTick < 0 && startTick % tickSpacing !== 0) {
    startCompressed -= 1;
  }
  const startBitPos = startCompressed & 255;

  for (let wordOffset = 0; wordOffset < searchLimit; wordOffset++) {
    const currentWord = startWord - wordOffset;

    const bitmap = await getTickBitmap(
      client,
      poolId,
      stateView,
      currentWord,
      blockNumber,
    );

    if (bitmap !== 0n) {
      const startBit = wordOffset === 0 ? startBitPos : 255;

      for (let i = startBit; i >= 0; i--) {
        const bit = 1n;
        const initialized = (bitmap & (bit << BigInt(i))) !== 0n;

        if (initialized) {
          const tickIndex = (currentWord * 256 + i) * tickSpacing;
          return tickIndex;
        }
      }
    }
  }

  return null;
}

function tickToWord(tick: number, tickSpacing: number): number {
  let compressed = Math.floor(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) {
    compressed -= 1;
  }
  return compressed >> 8;
}

async function getTickBitmap(
  client: PublicClient,
  poolId: `0x${string}`,
  stateView: Address,
  wordPosition: number,
  blockNumber: bigint,
): Promise<bigint> {
  if (wordPosition < -32768 || wordPosition > 32767) {
    throw new Error("Word position out of int16 range");
  }

  return client.readContract({
    address: stateView,
    abi: STATE_VIEW_ABI,
    functionName: "getTickBitmap",
    args: [poolId, wordPosition],
    blockNumber: blockNumber,
  });
}
// ===========================================================================
// END VERBATIM
// ===========================================================================

// --- (2) CANONICAL: the on-chain view function ---
async function getFeeGrowthInsideCanonical(
  tickLower: number,
  tickUpper: number,
  blockNumber: bigint,
): Promise<{ feeGrowthInside0X128: bigint; feeGrowthInside1X128: bigint }> {
  const [feeGrowthInside0X128, feeGrowthInside1X128] =
    await client.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: "getFeeGrowthInside",
      args: [POOL_ID, tickLower, tickUpper],
      blockNumber,
    });
  return { feeGrowthInside0X128, feeGrowthInside1X128 };
}

// --- (3) FIXED: report's proposed clamp-once-at-start approach ---
async function tickIsInitialized(
  tick: number,
  blockNumber: bigint,
): Promise<boolean> {
  const [liquidityGross, liquidityNet] = await client.readContract({
    address: STATE_VIEW,
    abi: STATE_VIEW_ABI,
    functionName: "getTickInfo",
    args: [POOL_ID, tick],
    blockNumber,
  });
  return liquidityGross !== 0n || liquidityNet !== 0n;
}

async function findInitializedTickForward(
  tickLower: number,
  tickUpper: number,
  tickSpacing: number,
  blockNumber: bigint,
): Promise<number | null> {
  for (let t = tickLower; t <= tickUpper; t += tickSpacing) {
    if (await tickIsInitialized(t, blockNumber)) return t;
  }
  return null;
}

async function findInitializedTickBackward(
  tickLower: number,
  tickUpper: number,
  tickSpacing: number,
  blockNumber: bigint,
): Promise<number | null> {
  for (let t = tickUpper; t >= tickLower; t -= tickSpacing) {
    if (await tickIsInitialized(t, blockNumber)) return t;
  }
  return null;
}

async function clampTicksToInitialized(
  tickLower: number,
  tickUpper: number,
  tickSpacing: number,
  startBlock: bigint,
): Promise<[number | null, number | null]> {
  const clLower = await findInitializedTickForward(
    tickLower,
    tickUpper,
    tickSpacing,
    startBlock,
  );
  const clUpper = await findInitializedTickBackward(
    tickLower,
    tickUpper,
    tickSpacing,
    startBlock,
  );
  if (clLower === null || clUpper === null || clLower > clUpper) {
    return [null, null];
  }
  return [clLower, clUpper];
}

// reconstruct using EXPLICIT, pre-clamped bounds; verify both still initialized
async function getFeeGrowthInsideOffchainAtBounds(
  clLower: number,
  clUpper: number,
  blockNumber: bigint,
): Promise<{ feeGrowthInside0X128: bigint; feeGrowthInside1X128: bigint }> {
  // hardening: if either clamped tick de-initialized by this block, earn nothing
  if (
    !(await tickIsInitialized(clLower, blockNumber)) ||
    !(await tickIsInitialized(clUpper, blockNumber))
  ) {
    return { feeGrowthInside0X128: 0n, feeGrowthInside1X128: 0n };
  }

  const [, currentTick] = await client.readContract({
    address: STATE_VIEW,
    abi: STATE_VIEW_ABI,
    functionName: "getSlot0",
    args: [POOL_ID],
    blockNumber,
  });
  const [g0, g1] = await client.readContract({
    address: STATE_VIEW,
    abi: STATE_VIEW_ABI,
    functionName: "getFeeGrowthGlobals",
    args: [POOL_ID],
    blockNumber,
  });
  const [lower, upper] = await Promise.all([
    client.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: "getTickInfo",
      args: [POOL_ID, clLower],
      blockNumber,
    }),
    client.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: "getTickInfo",
      args: [POOL_ID, clUpper],
      blockNumber,
    }),
  ]);
  const lo = parseTickInfo(lower);
  const up = parseTickInfo(upper);
  const below0 = currentTick >= clLower ? lo.feeGrowthOutside0X128 : g0 - lo.feeGrowthOutside0X128;
  const below1 = currentTick >= clLower ? lo.feeGrowthOutside1X128 : g1 - lo.feeGrowthOutside1X128;
  const above0 = currentTick < clUpper ? up.feeGrowthOutside0X128 : g0 - up.feeGrowthOutside0X128;
  const above1 = currentTick < clUpper ? up.feeGrowthOutside1X128 : g1 - up.feeGrowthOutside1X128;
  return {
    feeGrowthInside0X128: g0 - below0 - above0,
    feeGrowthInside1X128: g1 - below1 - above1,
  };
}

// ---------------- driver ----------------
const Q128 = 2n ** 128n;
const fmt = (x: bigint) => {
  const a = x < 0n ? -x : x;
  return `${x.toString()} (~${Number(a).toExponential(3)})`;
};

async function tickStatus(tick: number, block: bigint) {
  const [lg, ln, fo0, fo1] = await client.readContract({
    address: STATE_VIEW,
    abi: STATE_VIEW_ABI,
    functionName: "getTickInfo",
    args: [POOL_ID, tick],
    blockNumber: block,
  });
  return { initialized: lg !== 0n || ln !== 0n, liquidityGross: lg, liquidityNet: ln, fo0, fo1 };
}

async function reproPosition(
  tokenId: bigint,
  tickLower: number,
  tickUpper: number,
  startBlock: bigint,
  endBlock: bigint,
) {
  console.log(`\n${"=".repeat(78)}`);
  console.log(`TOKEN ${tokenId}  range [${tickLower}, ${tickUpper}]  spacing ${TICK_SPACING}`);
  console.log(`sub-period start block ${startBlock}  ->  end block ${endBlock}`);
  console.log("=".repeat(78));

  // liquidity for the sub-period (constant; read at start block)
  let liquidity = 0n;
  try {
    liquidity = await client.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: "getPositionLiquidity",
      args: [tokenId],
      blockNumber: startBlock,
    });
  } catch (e: any) {
    console.log(`  (getPositionLiquidity reverted: ${e.shortMessage ?? e.message}; credited-TEL calc will be skipped)`);
  }
  console.log(`position liquidity @start: ${liquidity}`);

  for (const [label, block] of [["START", startBlock], ["END", endBlock]] as const) {
    const [, tick] = await client.readContract({
      address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [POOL_ID], blockNumber: block,
    });
    const loS = await tickStatus(tickLower, block);
    const upS = await tickStatus(tickUpper, block);
    const inRange = tick >= tickLower && tick < tickUpper;
    console.log(`\n[${label} @${block}] currentTick=${tick}  position ${inRange ? "IN range" : "OUT of range"}`);
    console.log(`   tickLower ${tickLower} initialized=${loS.initialized} (liqGross=${loS.liquidityGross})`);
    console.log(`   tickUpper ${tickUpper} initialized=${upS.initialized} (liqGross=${upS.liquidityGross})`);
    const snapLo = await findInitializedTickUnder(client, POOL_ID, STATE_VIEW, tickLower, TICK_SPACING, block);
    const snapUp = await findInitializedTickUnder(client, POOL_ID, STATE_VIEW, tickUpper, TICK_SPACING, block);
    console.log(`   findInitializedTickUnder: ${tickLower} -> ${snapLo}${snapLo!==tickLower?"  *** SNAPPED ***":""},  ${tickUpper} -> ${snapUp}${snapUp!==tickUpper?"  *** SNAPPED ***":""}`);
  }

  // (1) BUGGY
  const [bugStart, bugEnd] = await Promise.all([
    getFeeGrowthInsideOffchain(client, POOL_ID, STATE_VIEW, tickLower, tickUpper, TICK_SPACING, startBlock),
    getFeeGrowthInsideOffchain(client, POOL_ID, STATE_VIEW, tickLower, tickUpper, TICK_SPACING, endBlock),
  ]);
  // (2) CANONICAL
  const [canStart, canEnd] = await Promise.all([
    getFeeGrowthInsideCanonical(tickLower, tickUpper, startBlock),
    getFeeGrowthInsideCanonical(tickLower, tickUpper, endBlock),
  ]);
  // (3) FIXED: clamp ONCE at start, reuse bounds at both endpoints
  const [clLower, clUpper] = await clampTicksToInitialized(tickLower, tickUpper, TICK_SPACING, startBlock);
  let fixStart = { feeGrowthInside0X128: 0n, feeGrowthInside1X128: 0n };
  let fixEnd = { feeGrowthInside0X128: 0n, feeGrowthInside1X128: 0n };
  if (clLower !== null && clUpper !== null) {
    fixStart = await getFeeGrowthInsideOffchainAtBounds(clLower, clUpper, startBlock);
    fixEnd = await getFeeGrowthInsideOffchainAtBounds(clLower, clUpper, endBlock);
  }
  console.log(`\nproposed-fix clamp @start: [${clLower}, ${clUpper}]`);

  const credited = (
    end: { feeGrowthInside0X128: bigint; feeGrowthInside1X128: bigint },
    start: { feeGrowthInside0X128: bigint; feeGrowthInside1X128: bigint },
  ) => calculateFees(liquidity, end.feeGrowthInside0X128, end.feeGrowthInside1X128, start.feeGrowthInside0X128, start.feeGrowthInside1X128);

  const cBug = credited(bugEnd, bugStart);
  const cCan = credited(canEnd, canStart);
  const cFix = credited(fixEnd, fixStart);

  console.log(`\n--- feeGrowthInside1 (TEL side) ---`);
  console.log(`  BUGGY     start=${fmt(bugStart.feeGrowthInside1X128)}\n            end  =${fmt(bugEnd.feeGrowthInside1X128)}`);
  console.log(`  CANONICAL start=${fmt(canStart.feeGrowthInside1X128)}\n            end  =${fmt(canEnd.feeGrowthInside1X128)}`);
  console.log(`  FIXED     start=${fmt(fixStart.feeGrowthInside1X128)}\n            end  =${fmt(fixEnd.feeGrowthInside1X128)}`);

  console.log(`\n--- credited token1Fees = delta1 * liquidity / 2^128  (raw integer) ---`);
  console.log(`  BUGGY     token1Fees = ${cBug.token1Fees}`);
  console.log(`  CANONICAL token1Fees = ${cCan.token1Fees}`);
  console.log(`  FIXED     token1Fees = ${cFix.token1Fees}`);
  console.log(`  (report claims calculator credited token 110585 = 65,099,934)`);
}

async function main() {
  console.log("Polygon head:", await client.getBlockNumber());
  // token 110585: the report's fully-specified worked example (Section 7.3)
  await reproPosition(110585n, -233880, -233580, 88434042n, 88479276n);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
