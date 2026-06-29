import {
  createPublicClient,
  getAddress,
  hexToBigInt,
  http,
  parseAbi,
  parseAbiItem,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import * as dotenv from "dotenv";
import { existsSync, readFileSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { createRpcClient, NetworkConfig, toBigInt } from "../helpers";
import { ChainId, config } from "../config";
dotenv.config();

/// usage: `yarn ts-node backend/calculators/TELxRewardsCalculator.ts`
/// 1. Fetches & updates all the pool's positions in checkpoint file using ModifyLiquidity events
/// 2. For each ModifyLiquidity event, records the block, new liquidity, and position owner (fee recipient) at the time of the event. This handles ownership transfers on the ERC721 ledger
/// 3. All positions are thus brought up to date, including an array of its liquidity modification events during the period
/// 4. Once all position are up-to-date, process them to credit the active owner of the LP token with position's fee growth at the time of each liquidity modification event. For each modification:
///   a. Identify the position's fee growth for each subperiod bounded by events (or period start/end): `liquidity * (getFeeGrowthInsideEnd - getFeeGrowthInsideStart) / Q128`
///   b. LP token ownership may have changed between subperiod boundaries, so fees for each subperiod are credited to the position owner at the time of modification. This is the address that collects the fees at modification time.
///   c. For all positions, a `LiquidityChange` is appended from the position's last modification until the period end to represent unclaimed fees earned since last modification and enforce unanimous endBlocks for the period
///   d. In vice-versa vein, for positions that were created mid-period, a `LiquidityChange` with `liquidity == 0` is unshifted from the period start until position creation to enforce unanimous startBlocks for the period
///   e. For positions that emitted no ModifyLiquidity events, the entire period is calculated with the checkpoint's last entry for liquidity value, complying with unanimous start and end blocks

type PositionDesignation = "JIT" | "ACTIVE" | "PASSIVE";

export interface PositionState {
  lastOwner: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint; // the final liquidity amount after fully processing the period
  feeGrowthInsidePeriod0: bigint; // currency0 final total fee growth after processing period
  feeGrowthInsidePeriod1: bigint; // currency1 final total fee growth after processing period
  feeGrowthInsidePeriod0Weighted: bigint;
  feeGrowthInsidePeriod1Weighted: bigint;
  liquidityModifications: LiquidityChange[];
  designation?: PositionDesignation;
}

interface LiquidityChange {
  blockNumber: bigint;
  newLiquidityAmount: bigint;
  owner: Address;
  isSubscribed: boolean;
  type: "positionUpdate" | "claim" | "subscribe" | "unsubscribe" | "synthetic";
}

export interface LPData {
  periodFeesCurrency0: bigint;
  periodFeesCurrency1: bigint;
  periodFeesCurrency0Weighted: bigint;
  periodFeesCurrency1Weighted: bigint;
  totalFeesCommonDenominatorWeighted?: bigint;
  reward?: bigint;
}

interface CheckpointData {
  blockRange: NetworkConfig;
  poolId: `0x${string}`;
  denominator: Address;
  currency0: Address;
  currency1: Address;
  positions: [bigint, PositionState][];
  lpData: [Address, LPData][];
  vwapResult?: VwapResult;
}

export type VwapResult =
  | { kind: "vwap"; priceScaled: bigint }
  | { kind: "singleSided"; growingIsCurrency0: boolean };

export type PoolConfig = {
  network: ChainId;
  name: string;
  poolId: `0x${string}`;
  denominator: Address;
  currency0: Address;
  currency1: Address;
  initializeBlock: bigint;
  tickSpacing: number;
  rewardAmounts: { FIRST: bigint; PERIOD: bigint };
};

export const PRECISION = 10n ** 64n;
const INITIALIZE_REWARD_AMOUNT = 0n;
const FIRST_PERIOD_REWARD_AMOUNT_ETH_TEL = 101_851_851n; // prorated
const PERIOD_REWARD_AMOUNT_ETH_TEL = 64_814_814n;
const FIRST_PERIOD_REWARD_AMOUNT_USDC_EMXN = 88_000_000n; // prorated
const PERIOD_REWARD_AMOUNT_USDC_EMXN = 56_000_000n;

const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 id) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) external view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
  "function getFeeGrowthGlobals(bytes32 poolId) external view returns (uint256 feeGrowthGlobal0, uint256 feeGrowthGlobal1)",
  "function getTickBitmap(bytes32 poolId, int16 wordPosition) external view returns (uint256)",
  "function getTickInfo(bytes32 poolId, int24 tick) external view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128)",
]);
const POSITION_MANAGER_ABI = parseAbi([
  "function positionInfo(uint256 tokenId) external view returns (uint256)",
  "function ownerOf(uint256 id) public view returns (address owner)",
  "function poolKeys(bytes25 poolId) external view returns (address token0, address token1, uint24 fee, int24 tickSpacing, address hooks)",
]);
const POSITION_REGISTRY_ABI = parseAbi([
  "function MIN_PASSIVE_LIFETIME() external view returns (uint256)",
  "function JIT_WEIGHT() external view returns (uint256)",
  "function ACTIVE_WEIGHT() external view returns (uint256)",
  "function PASSIVE_WEIGHT() external view returns (uint256)",
  "function isTokenSubscribed(uint256 tokenId) external view returns (bool)",
]);

// ---------------- Pool Definitions ----------------

// BASE — ETH/TEL
const BASE_ETH_TEL: PoolConfig = {
  network: ChainId.Base,
  name: "base-ETH-TEL",
  poolId: "0x727b2741ac2b2df8bc9185e1de972661519fc07b156057eeed9b07c50e08829b",
  currency0: zeroAddress,
  currency1: getAddress("0x09bE1692ca16e06f536F0038fF11D1dA8524aDB1"),
  denominator: getAddress("0x09bE1692ca16e06f536F0038fF11D1dA8524aDB1"), // TEL
  initializeBlock: 25_832_462n,
  tickSpacing: 60,
  rewardAmounts: {
    FIRST: FIRST_PERIOD_REWARD_AMOUNT_ETH_TEL,
    PERIOD: PERIOD_REWARD_AMOUNT_ETH_TEL,
  },
};

// POLYGON — ETH/TEL
const POLYGON_ETH_TEL: PoolConfig = {
  network: ChainId.Polygon,
  name: "polygon-ETH-TEL",
  poolId: "0x25412ca33f9a2069f0520708da3f70a7843374dd46dc1c7e62f6d5002f5f9fa7",
  currency0: getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"),
  currency1: getAddress("0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32"),
  denominator: getAddress("0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32"), // TEL
  initializeBlock: 67_949_841n,
  tickSpacing: 60,
  rewardAmounts: {
    FIRST: FIRST_PERIOD_REWARD_AMOUNT_ETH_TEL,
    PERIOD: PERIOD_REWARD_AMOUNT_ETH_TEL,
  },
};

// POLYGON — USDC/eMXN
const POLYGON_USDC_EMXN: PoolConfig = {
  network: ChainId.Polygon,
  name: "polygon-USDC-EMXN",
  poolId: "0x29f94ec9b66df7fe4068e2d7e9bf0147b49afcdc7cd3283dff03088b8026169f",
  currency0: getAddress("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
  currency1: getAddress("0x68727e573D21a49c767c3c86A92D9F24bd933c99"),
  denominator: getAddress("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"), // USDC
  initializeBlock: 74_664_812n,
  tickSpacing: 10,
  rewardAmounts: {
    FIRST: FIRST_PERIOD_REWARD_AMOUNT_USDC_EMXN,
    PERIOD: PERIOD_REWARD_AMOUNT_USDC_EMXN,
  },
};

export const TELX_BASE_PATH = "backend/checkpoints";
export type SupportedChainId = ChainId.Polygon | ChainId.Base;
export const POOLS = [BASE_ETH_TEL, POLYGON_ETH_TEL, POLYGON_USDC_EMXN];

/**
 * @dev For new periods, increment length here and add the new blocknumbers to `periodStarts`
 * @notice While public-facing periods are 1-indexed, this utility uses `period 0` internally
 * to refer to the initialization period from pool creation to first period start.
 */
export const PERIODS = Array.from({ length: 46 }, (_, i) => i);
export const NETWORKS = {
  [ChainId.Polygon]: {
    poolManager: getAddress("0x67366782805870060151383f4bbff9dab53e5cd6"),
    positionRegistry: getAddress("0x2c33fC9c09CfAC5431e754b8fe708B1dA3F5B954"),
    positionManager: getAddress("0x1Ec2eBf4F37E7363FDfe3551602425af0B3ceef9"),
    stateView: getAddress("0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a"),
    periodStarts: [
      74_970_501n, // programStart aug 9
      75_417_061n, // aug 20
      75_697_435n, // aug 27
      75_981_195n, // sep 3
      76_265_454n, // sep 10
      76_539_088n, // sep 17
      76_822_629n, // sep 24
      77_126_356n, // oct 1
      77_390_383n, // oct 8
      77_690_848n, // oct 15
      77_993_212n, // oct 22
      78_295_585n, // oct 29
      78_331_507n, // period 13 start: PositionRegistry deployment
      78_900_357n, // nov 12
      79_202_684n, // nov 19
      79_505_082n, // nov 26
      79_807_479n, // dec 3
      80_109_849n, // dec 10
      80_408_956n, // dec 17
      80_729_178n, // dec 24
      81_009_978n, // dec 31
      81_312_370n, // jan 7
      81_614_414n, // jan 14
      81_916_814n, // jan 21
      82_219_205n, // jan 28
      82_521_597n, // feb 4
      82_823_988n, // feb 11
      83_126_388n, // feb 18
      83_428_786n, // feb 25
      83_731_184n, // mar 4
      84_033_583n, // mar 11
      84_335_983n, // mar 18
      84_638_382n, // mar 25
      84_940_781n, // apr 1
      85_243_181n, // apr 8
      85_545_578n, // apr 15
      85_847_978n, //apr 22
      86_150_378n, // apr 29
      86_452_778n, // may 6
      86_794_681n, // may 13
      87_140_281n, // may 20
      87_485_873n, // may 27
      87_831_473n, // jun 3
      88_229_743n, // jun 10
      88_632_942n, // jun 17
      89_036_136n, // jun 24
    ],
  },
  [ChainId.Base]: {
    poolManager: getAddress("0x498581fF718922c3f8e6A244956aF099B2652b2b"),
    positionRegistry: getAddress("0x3994e3ae3Cf62bD2a3a83dcE73636E954852BB04"),
    positionManager: getAddress("0x7C5f5A4bBd8fD63184577525326123B519429bDc"),
    stateView: getAddress("0xa3c0c9b65bad0b08107aa264b0f3db444b867a71"),
    periodStarts: [
      33_954_128n, // programStart aug 9
      34_429_327n, // aug 20
      34_731_727n, // aug 27
      35_034_127n, // sep 3
      35_336_526n, // sep 10
      35_638_926n, // sep 17
      35_941_326n, // sep 24
      36_265_326n, // oct 1
      36_546_126n, // oct 8
      36_848_526n, // oct 15
      37_150_926n, // oct 22
      37_453_326n, // oct 29
      37_463_764n, // period 13 start: PositionRegistry deployment
      38_058_126n, // nov 12
      38_360_526n, // nov 19
      38_662_926n, // nov 26
      38_965_326n, // dec 3
      39_267_726n, // dec 10
      39_570_126n, // dec 17
      39_894_126n, // dec 24
      40_174_926n, // dec 31
      40_477_326n, // jan 7
      40_779_726n, // jan 14
      41_082_126n, // jan 21
      41_384_526n, // jan 28
      41_686_926n, // feb 4
      41_989_326n, // feb 11
      42_291_726n, // feb 18
      42_594_126n, // feb 25
      42_896_526n, // mar 4
      43_198_926n, // mar 11
      43_501_326n, // mar 18
      43_803_726n, // mar 25
      44_106_126n, // apr 1
      44_408_526n, // apr 8
      44_710_926n, // apr 15
      45_013_326n, //apr 22
      45_315_726n, // apr 29
      45_618_126n, // may 6
      45_920_526n, // may 13
      46_222_926n, // may 20
      46_525_326n, // may 27
      46_827_726n, // jun 3
      47_130_126n, // jun 10
      47_432_526n, // jun 17
      47_734_926n, // jun 24
    ],
  },
};

/**
 * @dev Usage: `yarn ts-node backend/calculators/TELxRewardsCalculator.ts <poolId>:<period> [--rerun]`
 * eg: `yarn ts-node backend/calculators/TELxRewardsCalculator.ts 0x29f94ec9b66df7fe4068e2d7e9bf0147b49afcdc7cd3283dff03088b8026169f:16`
 * Pass `--rerun` to write to `<name>-<period>.rerun.json` instead of overwriting the canonical checkpoint.
 */
async function main() {
  const args = process.argv.slice(2);
  const [poolId, period, rerun] = parseCLIArgs(args);
  const poolConfig = setPoolConfig(poolId, period);

  // Load state from checkpoint json if it exists and reset its period-specific fee fields
  const client = createRpcClient(poolConfig.network);

  let initialPositions: Map<bigint, PositionState> = await initialize(
    poolConfig.checkpointFile,
    period,
    poolConfig.startBlock,
    poolConfig.endBlock,
    client,
    poolConfig.positionManager,
  );
  // fetches current registry config parameters to accomodate most recent TELx council wishes
  const [minPassiveLifetime, jitWeight, activeWeight, passiveWeight] =
    await getRegistryConfig(client, poolConfig.positionRegistry);
  const { lpData: lpFees, finalPositions } = await updateFeesAndPositions(
    poolId,
    poolConfig.startBlock,
    poolConfig.endBlock,
    client,
    poolConfig.positionRegistry,
    poolConfig.stateView,
    poolConfig.positionManager,
    poolConfig.tickSpacing,
    initialPositions,
    minPassiveLifetime,
    jitWeight,
    activeWeight,
    passiveWeight,
  );
  const denominatorIsCurrency0 = denominatorIsCurrencyZero(
    poolConfig.denominator,
    poolConfig.currency0,
    poolConfig.currency1,
  );
  const { feeGrowthDelta0, feeGrowthDelta1 } =
    await getFeeGrowthGlobalsPeriodDelta(
      client,
      poolId,
      poolConfig.stateView,
      poolConfig.startBlock,
      poolConfig.endBlock,
    );
  const vwapResult: VwapResult = deriveVwapResult(
    feeGrowthDelta0,
    feeGrowthDelta1,
    denominatorIsCurrency0,
  );
  const lpData = await populateTotalFeesCommonDenominator(
    lpFees,
    vwapResult,
    denominatorIsCurrency0,
  );

  const lpRewards = calculateRewardDistribution(
    lpData,
    poolConfig.rewardAmount,
  );

  // write to the checkpoint file
  const newCheckpoint: CheckpointData = {
    blockRange: {
      network: config.chains.find((c) => c.id === poolConfig.network)!.name,
      startBlock: poolConfig.startBlock,
      endBlock: poolConfig.endBlock,
    },
    poolId: poolId,
    denominator: poolConfig.denominator,
    currency0: poolConfig.currency0,
    currency1: poolConfig.currency1,
    positions: Array.from(finalPositions.entries()),
    lpData: Array.from(lpRewards.entries()),
    vwapResult,
  };
  const suffix = rerun ? ".rerun" : "";
  const outputFile = `${TELX_BASE_PATH}/${poolConfig.name}-${period}${suffix}.json`;
  await writeFile(
    outputFile,
    JSON.stringify(
      newCheckpoint,
      (key, value) =>
        typeof value === "bigint" ? value.toString() + "n" : value,
      2,
    ),
    "utf-8",
  );

  console.log("Analysis complete. New checkpoint saved.");
}

async function updateFeesAndPositions(
  poolId: `0x${string}`,
  startBlock: bigint,
  endBlock: bigint,
  client: PublicClient,
  positionRegistry: Address,
  stateView: Address,
  positionManager: Address,
  tickSpacing: number,
  initialPositions: Map<bigint, PositionState>,
  minPassiveLifetime: bigint,
  jitWeight: bigint,
  activeWeight: bigint,
  passiveWeight: bigint,
): Promise<{
  lpData: Map<Address, LPData>;
  finalPositions: Map<bigint, PositionState>;
}> {
  // update positions by processing ModifyLiquidity events
  const updatedPositions = await updatePositions(
    poolId,
    startBlock,
    endBlock,
    client,
    positionRegistry,
    positionManager,
    initialPositions,
  );
  // use final positions to credit fees to LPs
  const { lpData, finalPositions } = await processFees(
    poolId,
    client,
    stateView,
    tickSpacing,
    updatedPositions,
    minPassiveLifetime,
    jitWeight,
    activeWeight,
    passiveWeight,
  );

  return { lpData, finalPositions };
}

export async function updatePositions(
  poolId: `0x${string}`,
  startBlock: bigint,
  endBlock: bigint,
  client: PublicClient,
  positionRegistry: Address,
  positionManager: Address,
  initialPositions: Map<bigint, PositionState>,
): Promise<Map<bigint, PositionState>> {
  // use copy of initial positions fetched from checkpoint file
  const positions = new Map<bigint, PositionState>(initialPositions);

  // fetch all event streams in new range and map them
  const positionUpdatedLogs = await client.getLogs({
    address: positionRegistry,
    event: parseAbiItem(
      "event PositionUpdated(uint256 indexed tokenId, address indexed newOwner, bytes32 indexed poolId, int24 tickLower, int24 tickUpper, uint128 newLiquidity)",
    ),
    args: { poolId: poolId },
    fromBlock: startBlock,
    toBlock: endBlock,
  });
  const subscribeLogs = await client.getLogs({
    address: positionRegistry,
    event: parseAbiItem(
      "event Subscribed(uint256 indexed tokenId, address indexed owner)",
    ),
    fromBlock: startBlock,
    toBlock: endBlock,
  });
  const unsubscribeLogs = await client.getLogs({
    address: positionRegistry,
    event: parseAbiItem(
      "event Unsubscribed(uint256 indexed tokenId, address indexed owner)",
    ),
    fromBlock: startBlock,
    toBlock: endBlock,
  });

  // combine and sort all events chronologically
  const combinedLogs = [
    ...positionUpdatedLogs.map((log) => ({
      ...log,
      type: "positionUpdate" as const,
    })),
    ...subscribeLogs.map((log) => ({ ...log, type: "subscribe" as const })),
    ...unsubscribeLogs.map((log) => ({ ...log, type: "unsubscribe" as const })),
  ];
  combinedLogs.sort((a, b) => {
    if (a.blockNumber === b.blockNumber) {
      return Number(a.logIndex) - Number(b.logIndex);
    }
    return Number(a.blockNumber) - Number(b.blockNumber);
  });

  // establish position timelines
  for (const log of combinedLogs) {
    if (!log.args || !log.blockNumber || !log.transactionHash) continue;
    const { tokenId } = log.args as any;
    let currentPositionState = positions.get(tokenId);

    // Fetch subscription status AT THE BLOCK of the modification
    const isSubscribedAtMod = await isSubscribed(
      client,
      positionRegistry,
      tokenId,
      log.blockNumber,
    );

    if (!currentPositionState) {
      // skip subscription logs for positions that belong to a different supported pool
      if (log.type !== "positionUpdate") {
        console.log(
          `[Info] Skipping '${log.type}' for token ${tokenId}: not part of this pool.`,
        );
        continue;
      }

      // --- New position ---
      const { newOwner, tickLower, tickUpper, newLiquidity } = log.args as any;
      const changes: LiquidityChange[] = [
        {
          // Synthetic 0-liquidity entry from period start
          blockNumber: startBlock,
          newLiquidityAmount: 0n,
          owner: zeroAddress,
          isSubscribed: false,
          type: "synthetic",
        },
        {
          blockNumber: log.blockNumber,
          newLiquidityAmount: newLiquidity,
          owner: newOwner,
          isSubscribed: isSubscribedAtMod,
          type: "positionUpdate",
        }, // The first "real" event
      ];

      positions.set(tokenId, {
        lastOwner: newOwner,
        tickLower: tickLower,
        tickUpper: tickUpper,
        liquidity: newLiquidity,
        feeGrowthInsidePeriod0: 0n, // placeholder until final processing step
        feeGrowthInsidePeriod1: 0n,
        feeGrowthInsidePeriod0Weighted: 0n,
        feeGrowthInsidePeriod1Weighted: 0n,
        liquidityModifications: changes,
      });
    } else {
      // --- Existing position ---
      if (currentPositionState.liquidityModifications.length === 0) {
        // First modification this period. Add synthetic start block
        const isSubscribedAtStart = await isSubscribed(
          client,
          positionRegistry,
          tokenId,
          startBlock,
        );
        currentPositionState.liquidityModifications.push({
          blockNumber: startBlock,
          newLiquidityAmount: currentPositionState.liquidity,
          owner: currentPositionState.lastOwner,
          isSubscribed: isSubscribedAtStart,
          type: "synthetic",
        });
      }

      // Get the *last* known state from the timeline
      const lastState =
        currentPositionState.liquidityModifications[
          currentPositionState.liquidityModifications.length - 1
        ];
      const newState: LiquidityChange = {
        blockNumber: log.blockNumber,
        newLiquidityAmount: lastState.newLiquidityAmount, // initialize with last known liquidity, overwritten if PositionUpdated
        owner: lastState.owner, // initialize with last known owner, overwritten if PositionUpdated
        isSubscribed: lastState.isSubscribed,
        type: log.type, // overwritten if claim
      };

      switch (log.type) {
        case "positionUpdate": {
          const { newOwner, newLiquidity } = log.args as any;
          // check if positionUpdate logs are claims and label if so
          const type =
            newLiquidity === lastState.newLiquidityAmount
              ? "claim"
              : "positionUpdate";
          newState.type = type;
          newState.owner = newOwner;
          newState.newLiquidityAmount = newLiquidity;
          // in case of implicit unsubscribe (transfer || liquidity drop) use re-checked subscription status
          newState.isSubscribed = isSubscribedAtMod;
          break;
        }
        case "subscribe": {
          newState.isSubscribed = true;
          break;
        }
        case "unsubscribe": {
          newState.isSubscribed = false;
          break;
        }
      }
      currentPositionState.liquidityModifications.push(newState);

      updatePosition(positions, tokenId, {
        lastOwner: newState.owner,
        liquidity: newState.newLiquidityAmount,
      });
    }
  }

  // loop over map again to append final subperiod chunk from last update to endBlock
  for (const [tokenId, position] of positions.entries()) {
    const [ownerAtEndBlock, isSubscribedAtEnd] = await Promise.all([
      safeGetOwnerOf(client, positionManager, tokenId, endBlock),
      isSubscribed(client, positionRegistry, tokenId, endBlock),
    ]);

    // construct new memory array which includes final chunk of time between last modification and period endBlock
    const timelinePoints: LiquidityChange[] = [];
    if (position.liquidityModifications.length === 0) {
      // Case 1: Pre-existing position with NO modifications this period, but owner/subscription may have changed
      // first delete irrelevant positions; even if not burned they will be recognized as new if liquidity is re-added
      if (position.liquidity === 0n) {
        positions.delete(tokenId);
        continue;
      }
      // Get subscription status at start
      const isSubscribedAtStart = await isSubscribed(
        client,
        positionRegistry,
        tokenId,
        startBlock,
      );
      // The timeline is just the start and end of the full period.
      timelinePoints.push({
        blockNumber: startBlock,
        newLiquidityAmount: position.liquidity,
        owner: position.lastOwner,
        isSubscribed: isSubscribedAtStart,
        type: "synthetic",
      });
      timelinePoints.push({
        blockNumber: endBlock,
        newLiquidityAmount: position.liquidity,
        owner: ownerAtEndBlock,
        isSubscribed: isSubscribedAtEnd,
        type: "synthetic",
      });
    } else {
      // Case 2: Position was created or modified during the period.
      // The timeline is its list of modifications prepended with pre-chunk from startBlock; append post-chunk until endBlock
      timelinePoints.push(...position.liquidityModifications);
      const lastChange = timelinePoints[timelinePoints.length - 1];
      // Only add an end block point if it's not the same block
      if (lastChange.blockNumber < endBlock) {
        timelinePoints.push({
          blockNumber: endBlock,
          newLiquidityAmount: lastChange.newLiquidityAmount, // Liquidity carries over til endBlock
          owner: ownerAtEndBlock,
          isSubscribed: isSubscribedAtEnd,
          type: "synthetic",
        });
      } else {
        // if last event was in the end block just update owner/subscription status.
        lastChange.owner = ownerAtEndBlock;
        lastChange.isSubscribed = isSubscribedAtEnd;
      }
    }

    updatePosition(positions, tokenId, {
      liquidityModifications: timelinePoints,
    });
  }

  return positions;
}

// Assigns position designations based on their liquidity modification timelines
function assignPositionDesignations(
  positions: Map<bigint, PositionState>, // must be fully processed for the period
  minPassiveLifetime: bigint,
): Map<bigint, PositionDesignation> {
  console.log(`Using passive threshold: ${minPassiveLifetime} blocks`);

  // Determine the designation for each *entire position lifetime*
  const designations = new Map<bigint, PositionDesignation>();
  for (const [tokenId, position] of positions.entries()) {
    let designation: PositionDesignation = "PASSIVE"; // Default to PASSIVE

    // ignore timeline entries corresponding to claims and un/subscriptions
    const designatableTimeline = position.liquidityModifications.filter(
      (change) =>
        change.type === "positionUpdate" || change.type === "synthetic",
    );
    for (let i = 1; i < designatableTimeline.length; i++) {
      const prevChange = designatableTimeline[i - 1];
      const currChange = designatableTimeline[i];

      const blockDelta = currChange.blockNumber - prevChange.blockNumber;

      if (blockDelta === 0n) {
        designation = "JIT";
        break; // Found to be JIT, no need to check further
      }

      // Check for ACTIVE
      if (blockDelta < minPassiveLifetime) {
        // position should not be designated ACTIVE if created within first minPassiveLifetime of period
        const isSyntheticStart = prevChange.owner === zeroAddress && i === 1;
        // position should not be designated ACTIVE if modified within last minPassiveLifetime of period
        const isSyntheticEnd = i === designatableTimeline.length - 1;

        // Ignore prepended/appended subperiod entries along synthetic period boundaries
        if (!isSyntheticStart && !isSyntheticEnd) {
          designation = "ACTIVE"; // Set to ACTIVE, but continue checking for JIT
        }
      }
    }
    designations.set(tokenId, designation);
  }

  return designations;
}

/**
 * Identifies cumulative fee totals for each liquidity provider
 * @return finalPositions Map of `tokenId => PositionState` tracking state of each unique position
 * @return lpData Map of `LP => LPData` tracking total fees per LP
 */
async function processFees(
  poolId: `0x${string}`,
  client: PublicClient,
  stateView: Address,
  tickSpacing: number,
  positions: Map<bigint, PositionState>, // must be fully processed for the period
  minPassiveLifetime: bigint,
  jitWeight: bigint,
  activeWeight: bigint,
  passiveWeight: bigint,
): Promise<{
  lpData: Map<Address, LPData>;
  finalPositions: Map<bigint, PositionState>;
}> {
  // assign designations to positions based on their liquidity modification timelines
  const designations = assignPositionDesignations(
    positions,
    minPassiveLifetime,
  );
  const weights = {
    JIT: jitWeight,
    ACTIVE: activeWeight,
    PASSIVE: passiveWeight,
  };

  // iterate over finalized PositionStates to construct lpData map<lpTokenOwnerAddress, totalFeesEarned>
  const lpData = new Map<Address, LPData>();
  for (const [tokenId, position] of positions.entries()) {
    // iterate over positions to process each sub-period, summing to raw & weighted fee growth over whole period
    let feesEarnedThisPeriod0 = 0n;
    let feesEarnedThisPeriod1 = 0n;
    let totalWeightedFees0 = 0n;
    let totalWeightedFees1 = 0n;

    const designation = designations.get(tokenId)!;
    const weight = weights[designation];

    for (let i = 1; i < position.liquidityModifications.length; i++) {
      // define the sub-period starting from the second item, as the first is the initial state at period start
      const prevChange = position.liquidityModifications[i - 1];
      const currChange = position.liquidityModifications[i];

      // skip if no liquidity or if JIT
      const liquidityForSubperiod = prevChange.newLiquidityAmount;
      if (
        liquidityForSubperiod === 0n ||
        prevChange.blockNumber === currChange.blockNumber
      )
        continue;

      // check the "isSubscribed" flag at start of sub-period
      const isEligibleForRewards = prevChange.isSubscribed;

      // get fee growth values and calculate the subperiod delta.
      //
      // FIX (period-44 fee-inflation): clamp the tick bounds ONCE at the
      // sub-period START block - where the position's boundary ticks are still
      // initialized - and reuse those stable bounds at both endpoints. This
      // prevents a mid-sub-period tick de-initialization from snapping the
      // bound search to an unrelated tick and reconstructing a phantom
      // feeGrowthInside (~9e31) that the underflow guard would then credit.
      let feeGrowthStart = {
        feeGrowthInside0X128: 0n,
        feeGrowthInside1X128: 0n,
      };
      let feeGrowthEnd = { feeGrowthInside0X128: 0n, feeGrowthInside1X128: 0n };
      const [clLower, clUpper] = await clampTicksToInitialized(
        client,
        poolId,
        stateView,
        position.tickLower,
        position.tickUpper,
        tickSpacing,
        prevChange.blockNumber, // clamp at the START block, reused for both
      );
      if (clLower !== null && clUpper !== null && clLower < clUpper) {
        [feeGrowthStart, feeGrowthEnd] = await Promise.all([
          getFeeGrowthInsideOffchainAtBounds(
            client,
            poolId,
            stateView,
            clLower,
            clUpper,
            prevChange.blockNumber, // start of the sub-period
          ),
          getFeeGrowthInsideOffchainAtBounds(
            client,
            poolId,
            stateView,
            clLower,
            clUpper,
            currChange.blockNumber, // end of the sub-period, SAME bounds
          ),
        ]);
      }

      // calculate subperiod's fees and add to period total for this position
      const { token0Fees: feesEarned0, token1Fees: feesEarned1 } =
        calculateFees(
          liquidityForSubperiod,
          feeGrowthEnd.feeGrowthInside0X128,
          feeGrowthEnd.feeGrowthInside1X128,
          feeGrowthStart.feeGrowthInside0X128,
          feeGrowthStart.feeGrowthInside1X128,
        );
      feesEarnedThisPeriod0 += feesEarned0;
      feesEarnedThisPeriod1 += feesEarned1;

      // --- APPLY WEIGHT ---
      // (rawFeesEarned * weightBps) / 10_000
      const weightedFees0 = (feesEarned0 * weight) / 10_000n;
      const weightedFees1 = (feesEarned1 * weight) / 10_000n;
      totalWeightedFees0 += weightedFees0;
      totalWeightedFees1 += weightedFees1;

      // if subscribed for the *entire subperiod*, aggregate fees for position owner at that time
      if (isEligibleForRewards) {
        const lp = currChange.owner;
        const currentFees = lpData.get(lp) ?? {
          periodFeesCurrency0: 0n,
          periodFeesCurrency1: 0n,
          periodFeesCurrency0Weighted: 0n,
          periodFeesCurrency1Weighted: 0n,
        };

        lpData.set(lp, {
          periodFeesCurrency0: currentFees.periodFeesCurrency0 + feesEarned0,
          periodFeesCurrency1: currentFees.periodFeesCurrency1 + feesEarned1,
          periodFeesCurrency0Weighted:
            currentFees.periodFeesCurrency0Weighted + weightedFees0,
          periodFeesCurrency1Weighted:
            currentFees.periodFeesCurrency1Weighted + weightedFees1,
        });
      }
    }

    updatePosition(positions, tokenId, {
      lastOwner:
        position.liquidityModifications[
          position.liquidityModifications.length - 1
        ].owner,
      designation: designation,
      feeGrowthInsidePeriod0: feesEarnedThisPeriod0,
      feeGrowthInsidePeriod1: feesEarnedThisPeriod1,
      feeGrowthInsidePeriod0Weighted: totalWeightedFees0,
      feeGrowthInsidePeriod1Weighted: totalWeightedFees1,
    });
  }

  return { lpData, finalPositions: positions };
}

// calculates fees earned for the given `liquidity` between start and end checkpoints
export function calculateFees(
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

/**
 * Adds new entry or updates existing one at `positions[key]` with fields provided in `updates`
 */
function updatePosition(
  positions: Map<bigint, PositionState>,
  key: bigint,
  updates: {
    lastOwner?: Address;
    tickLower?: number;
    tickUpper?: number;
    liquidity?: bigint;
    designation?: PositionDesignation;
    feeGrowthInsidePeriod0?: bigint;
    feeGrowthInsidePeriod1?: bigint;
    feeGrowthInsidePeriod0Weighted?: bigint;
    feeGrowthInsidePeriod1Weighted?: bigint;
    liquidityModifications?: LiquidityChange[];
  },
) {
  const existing = positions.get(key);

  if (existing) {
    // update only the provided fields
    positions.set(key, {
      ...existing,
      ...updates,
    });
  } else {
    // create new position entry; first validate required fields
    if (
      !updates.lastOwner ||
      updates.tickLower === undefined ||
      updates.tickUpper === undefined ||
      updates.liquidity === undefined ||
      updates.designation === undefined ||
      updates.feeGrowthInsidePeriod0 === undefined ||
      updates.feeGrowthInsidePeriod1 === undefined ||
      updates.feeGrowthInsidePeriod0Weighted === undefined ||
      updates.feeGrowthInsidePeriod1Weighted === undefined ||
      updates.liquidityModifications === undefined
    ) {
      throw new Error(
        `Cannot create new position ${key}: due to missing required fields.`,
      );
    }

    // create new position entry
    positions.set(key, {
      lastOwner: updates.lastOwner,
      tickLower: updates.tickLower,
      tickUpper: updates.tickUpper,
      liquidity: updates.liquidity,
      designation: updates.designation,
      feeGrowthInsidePeriod0: updates.feeGrowthInsidePeriod0,
      feeGrowthInsidePeriod1: updates.feeGrowthInsidePeriod1,
      feeGrowthInsidePeriod0Weighted: updates.feeGrowthInsidePeriod0Weighted,
      feeGrowthInsidePeriod1Weighted: updates.feeGrowthInsidePeriod1Weighted,
      liquidityModifications: updates.liquidityModifications,
    });
  }
}

/**
 * Updates existing entry at `lpData[key]` with fields provided in `updates`
 */
function modifyLPData(
  lpData: Map<Address, LPData>,
  key: Address,
  updates: Partial<LPData>,
) {
  const existing = lpData.get(key);
  if (existing) {
    lpData.set(key, {
      ...existing,
      ...updates,
    });
  } else {
    throw new Error(`${key} Not found; modifications only`);
  }
}

/**
 * Rescopes lower and upper tick bounds by identifying nearest "safe" initialized ticks
 * Then calls v4 StateView to fetch fee growth outside using safe initialized tick range
 * To derive the fee growth inside the range in line with onchain Solidity derivation
 */
export async function getFeeGrowthInsideOffchain(
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

// Helper function to destructure TickInfo results, which come back as an array
function parseTickInfo(tickInfo: readonly [bigint, bigint, bigint, bigint]): {
  feeGrowthOutside0X128: bigint;
  feeGrowthOutside1X128: bigint;
} {
  return {
    feeGrowthOutside0X128: tickInfo[2],
    feeGrowthOutside1X128: tickInfo[3],
  };
}

/**
 * Decompose a tick into its [wordPosition, bitPosition] in the v4 tick bitmap,
 * using the same compression math as `tickToWord`.
 */
function tickToWordAndBit(tick: number, tickSpacing: number): [number, number] {
  let compressed = Math.floor(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) compressed -= 1;
  return [compressed >> 8, compressed & 255];
}

/**
 * Searches UPWARD from `tickLower` (inclusive) for the first initialized tick
 * that lies WITHIN the position's declared range [tickLower, tickUpper].
 * Returns null if no initialized tick exists in range.
 *
 * Unlike `findInitializedTickUnder`, this search is strictly bounded by the
 * position's own range, so it can never snap to a tick outside [tickLower, tickUpper].
 */
async function findInitializedTickForward(
  client: PublicClient,
  poolId: `0x${string}`,
  stateView: Address,
  tickLower: number,
  tickUpper: number,
  tickSpacing: number,
  blockNumber: bigint,
): Promise<number | null> {
  const [startWord, startBit] = tickToWordAndBit(tickLower, tickSpacing);
  const [endWord, endBit] = tickToWordAndBit(tickUpper, tickSpacing);

  for (let word = startWord; word <= endWord; word++) {
    const bitmap = await getTickBitmap(
      client,
      poolId,
      stateView,
      word,
      blockNumber,
    );
    if (bitmap !== 0n) {
      const beginBit = word === startWord ? startBit : 0;
      const stopBit = word === endWord ? endBit : 255;
      for (let i = beginBit; i <= stopBit; i++) {
        if ((bitmap & (1n << BigInt(i))) !== 0n) {
          return (word * 256 + i) * tickSpacing;
        }
      }
    }
  }
  return null;
}

/**
 * Searches DOWNWARD from `tickUpper` (inclusive) for the first initialized tick
 * that lies WITHIN the position's declared range [tickLower, tickUpper].
 * Returns null if no initialized tick exists in range.
 */
async function findInitializedTickBackward(
  client: PublicClient,
  poolId: `0x${string}`,
  stateView: Address,
  tickLower: number,
  tickUpper: number,
  tickSpacing: number,
  blockNumber: bigint,
): Promise<number | null> {
  const [startWord, startBit] = tickToWordAndBit(tickLower, tickSpacing);
  const [endWord, endBit] = tickToWordAndBit(tickUpper, tickSpacing);

  for (let word = endWord; word >= startWord; word--) {
    const bitmap = await getTickBitmap(
      client,
      poolId,
      stateView,
      word,
      blockNumber,
    );
    if (bitmap !== 0n) {
      const topBit = word === endWord ? endBit : 255;
      const bottomBit = word === startWord ? startBit : 0;
      for (let i = topBit; i >= bottomBit; i--) {
        if ((bitmap & (1n << BigInt(i))) !== 0n) {
          return (word * 256 + i) * tickSpacing;
        }
      }
    }
  }
  return null;
}

/**
 * Computes a STABLE [clLower, clUpper] pair of initialized ticks within the
 * position's declared range, evaluated ONCE at the sub-period START block.
 *
 * Reusing this pair at both the start and end fee-growth queries is the core of
 * the period-44 fee-inflation fix: it prevents a tick de-initialization that
 * occurs mid-sub-period from shifting the basis of the fee-growth delta. The
 * legacy `getFeeGrowthInsideOffchain` recomputed the bounds independently at
 * each endpoint, so a de-initialized boundary tick would snap the search to an
 * unrelated tick and reconstruct a phantom feeGrowthInside.
 */
export async function clampTicksToInitialized(
  client: PublicClient,
  poolId: `0x${string}`,
  stateView: Address,
  tickLower: number,
  tickUpper: number,
  tickSpacing: number,
  startBlock: bigint,
): Promise<[number | null, number | null]> {
  const clLower = await findInitializedTickForward(
    client,
    poolId,
    stateView,
    tickLower,
    tickUpper,
    tickSpacing,
    startBlock,
  );
  const clUpper = await findInitializedTickBackward(
    client,
    poolId,
    stateView,
    tickLower,
    tickUpper,
    tickSpacing,
    startBlock,
  );
  // no initialized tick in range (or only one) => position earns nothing this sub-period
  if (clLower === null || clUpper === null || clLower > clUpper) {
    return [null, null];
  }
  return [clLower, clUpper];
}

/**
 * Reconstructs feeGrowthInside using EXPLICIT, pre-clamped tick bounds (computed
 * once at the sub-period start by `clampTicksToInitialized`). The bounds are NOT
 * recomputed here, so a tick that de-initializes mid-sub-period cannot snap the
 * search to an unrelated tick.
 *
 * Hardening: if either clamped tick has de-initialized by `blockNumber`, the
 * position had no active liquidity at that boundary, so it earns nothing for the
 * sub-period and {0, 0} is returned rather than proceeding with stale tick data.
 */
export async function getFeeGrowthInsideOffchainAtBounds(
  client: PublicClient,
  poolId: `0x${string}`,
  stateView: Address,
  clLower: number,
  clUpper: number,
  blockNumber: bigint,
): Promise<{ feeGrowthInside0X128: bigint; feeGrowthInside1X128: bigint }> {
  // verify both clamped ticks are still initialized at the query block
  const [lowerTickInfoResult, upperTickInfoResult] = await Promise.all([
    client.readContract({
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: "getTickInfo",
      args: [poolId, clLower],
      blockNumber,
    }),
    client.readContract({
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: "getTickInfo",
      args: [poolId, clUpper],
      blockNumber,
    }),
  ]);
  const lowerInitialized =
    lowerTickInfoResult[0] !== 0n || lowerTickInfoResult[1] !== 0n;
  const upperInitialized =
    upperTickInfoResult[0] !== 0n || upperTickInfoResult[1] !== 0n;
  if (!lowerInitialized || !upperInitialized) {
    return { feeGrowthInside0X128: 0n, feeGrowthInside1X128: 0n };
  }

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

  const lowerTickInfo = parseTickInfo(lowerTickInfoResult);
  const upperTickInfo = parseTickInfo(upperTickInfoResult);

  // replicate getFeeGrowthInside on-chain logic, anchored to the clamped bounds
  let feeGrowthBelow0X128: bigint;
  let feeGrowthBelow1X128: bigint;
  if (currentTick >= clLower) {
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
  if (currentTick < clUpper) {
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

/**
 * Finds the highest safe initialized tick under `startTick` by searching downward (inclusive)
 *
 * @deprecated Retained only for the `inspectSwaps` diagnostic. The sub-period
 * fee-growth path now uses `clampTicksToInitialized` +
 * `getFeeGrowthInsideOffchainAtBounds`, which fix the de-initialization snap bug.
 */
async function findInitializedTickUnder(
  client: PublicClient,
  poolId: `0x${string}`,
  stateView: Address,
  startTick: number,
  tickSpacing: number,
  blockNumber: bigint,
  searchLimit: number = 2560, // Safety limit: search up to 10 words
): Promise<number | null> {
  // Start from the word containing our tick
  const startWord = tickToWord(startTick, tickSpacing);

  // Calculate which bit position within the starting word
  let startCompressed = Math.floor(startTick / tickSpacing);
  if (startTick < 0 && startTick % tickSpacing !== 0) {
    startCompressed -= 1;
  }
  const startBitPos = startCompressed & 255; // Equivalent to startCompressed % 256 but always positive

  // Search through words going backwards
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
      // Determine starting bit position for this word
      const startBit = wordOffset === 0 ? startBitPos : 255;

      // Check each bit in the word from startBit down to 0
      for (let i = startBit; i >= 0; i--) {
        const bit = 1n;
        const initialized = (bitmap & (bit << BigInt(i))) !== 0n;

        if (initialized) {
          // Calculate the actual tick index
          const tickIndex = (currentWord * 256 + i) * tickSpacing;
          return tickIndex;
        }
      }
    }
  }

  return null;
}

/**
 * Convert a tick to its word position in the bitmap
 * This follows the exact formula from the Uniswap V4 documentation
 */
function tickToWord(tick: number, tickSpacing: number): number {
  let compressed = Math.floor(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) {
    compressed -= 1;
  }
  return compressed >> 8; // Right shift by 8 bits (divide by 256)
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

// Sums each LP's token0 and token1 period fees into a single-currency total and
// writes it to `LPData.totalFeesCommonDenominatorWeighted`. For a `vwap` result
// the VWAP price converts the non-denominator side; for a `singleSided` result
// only the growing side contributes (the absent side's price would cancel out
// in the downstream reward share ratio anyway).
export async function populateTotalFeesCommonDenominator(
  lpData: Map<Address, LPData>,
  vwapResult: VwapResult,
  denominatorIsCurrency0: boolean,
): Promise<Map<Address, LPData>> {
  if (vwapResult.kind === "singleSided") {
    for (const [lpAddress, fees] of lpData) {
      const totalFeesInDenominatorWeighted = vwapResult.growingIsCurrency0
        ? fees.periodFeesCurrency0Weighted
        : fees.periodFeesCurrency1Weighted;
      modifyLPData(lpData, lpAddress, {
        totalFeesCommonDenominatorWeighted: totalFeesInDenominatorWeighted,
      });
    }
    return lpData;
  }
  const vwapPriceScaled = vwapResult.priceScaled;

  for (const [lpAddress, fees] of lpData) {
    let totalFeesInDenominatorWeighted: bigint;

    if (denominatorIsCurrency0) {
      const amount1InDenominatorWeighted =
        (fees.periodFeesCurrency1Weighted * vwapPriceScaled) / PRECISION;
      totalFeesInDenominatorWeighted =
        fees.periodFeesCurrency0Weighted + amount1InDenominatorWeighted;
    } else {
      const amount0InDenominatorWeighted =
        (fees.periodFeesCurrency0Weighted * vwapPriceScaled) / PRECISION;
      totalFeesInDenominatorWeighted =
        fees.periodFeesCurrency1Weighted + amount0InDenominatorWeighted;
    }

    modifyLPData(lpData, lpAddress, {
      totalFeesCommonDenominatorWeighted: totalFeesInDenominatorWeighted,
    });
  }

  return lpData;
}

async function getFeeGrowthGlobalsPeriodDelta(
  client: PublicClient,
  poolId: `0x${string}`,
  stateView: Address,
  startBlock: bigint,
  endBlock: bigint,
): Promise<{ feeGrowthDelta0: bigint; feeGrowthDelta1: bigint }> {
  // Fetch fee growth at start and end of period
  const [startGrowth, endGrowth] = await Promise.all([
    client.readContract({
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: "getFeeGrowthGlobals",
      args: [poolId],
      blockNumber: startBlock,
    }),
    client.readContract({
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: "getFeeGrowthGlobals",
      args: [poolId],
      blockNumber: endBlock,
    }),
  ]);

  // calculate fee growth deltas using modular arithmetic
  const MAX_UINT256 = 2n ** 256n;
  const feeGrowthDelta0 =
    (endGrowth[0] - startGrowth[0] + MAX_UINT256) % MAX_UINT256;
  const feeGrowthDelta1 =
    (endGrowth[1] - startGrowth[1] + MAX_UINT256) % MAX_UINT256;

  return { feeGrowthDelta0, feeGrowthDelta1 };
}

// decides whether the two global fee-growth deltas yield a meaningful VWAP,
// or whether the period was one-sided (one side saw zero fee growth).
export function deriveVwapResult(
  feeGrowthDelta0: bigint,
  feeGrowthDelta1: bigint,
  denominatorIsCurrency0: boolean,
): VwapResult {
  if (feeGrowthDelta0 > 0n && feeGrowthDelta1 > 0n) {
    const priceScaled = denominatorIsCurrency0
      ? (feeGrowthDelta0 * PRECISION) / feeGrowthDelta1
      : (feeGrowthDelta1 * PRECISION) / feeGrowthDelta0;
    return { kind: "vwap", priceScaled };
  }
  return { kind: "singleSided", growingIsCurrency0: feeGrowthDelta1 === 0n };
}

// allocates each LP the amount proportional to their share of the total reward amount
export function calculateRewardDistribution(
  lpData: Map<Address, LPData>,
  rewardAmount: bigint,
): Map<Address, LPData> {
  const totalFees = Array.from(lpData.values())
    .map((data) => data.totalFeesCommonDenominatorWeighted!)
    .reduce((a, b) => a + b, 0n);
  if (totalFees === 0n) return new Map();

  // calculate each LP's share of rewards
  for (const [lpAddress, lpFees] of lpData) {
    // identify proportional reward: (lpFeesTELDenominated / totalFees) * rewardAmount
    const scaledShare =
      (lpFees.totalFeesCommonDenominatorWeighted! * PRECISION) / totalFees;
    const lpReward = (scaledShare * rewardAmount) / PRECISION;

    modifyLPData(lpData, lpAddress, { reward: lpReward });
  }

  return lpData;
}

// fetch registry config constants needed for fee processing
async function getRegistryConfig(
  client: PublicClient,
  positionRegistry: Address,
): Promise<[bigint, bigint, bigint, bigint]> {
  const [minPassiveLifetime, jitWeight, activeWeight, passiveWeight] =
    await Promise.all([
      client.readContract({
        address: positionRegistry,
        abi: POSITION_REGISTRY_ABI,
        functionName: "MIN_PASSIVE_LIFETIME",
      }),
      client.readContract({
        address: positionRegistry,
        abi: POSITION_REGISTRY_ABI,
        functionName: "JIT_WEIGHT",
      }),
      client.readContract({
        address: positionRegistry,
        abi: POSITION_REGISTRY_ABI,
        functionName: "ACTIVE_WEIGHT",
      }),
      client.readContract({
        address: positionRegistry,
        abi: POSITION_REGISTRY_ABI,
        functionName: "PASSIVE_WEIGHT",
      }),
    ]);

  return [minPassiveLifetime, jitWeight, activeWeight, passiveWeight];
}

async function safeGetOwnerOf(
  client: PublicClient,
  positionManager: Address,
  tokenId: bigint,
  blockNumber: bigint,
): Promise<Address> {
  try {
    const owner = await client.readContract({
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber: blockNumber,
    });
    return owner;
  } catch (error: any) {
    // Fails if token is burned (NOT_MINTED) or other revert
    console.warn(
      `[safeGetOwnerOf] Failed to get owner for token ${tokenId} at block ${blockNumber}. Treating as burned. Error: ${error.message}`,
    );
    return zeroAddress; // Treat as burned
  }
}

async function isSubscribed(
  client: PublicClient,
  positionRegistry: Address,
  tokenId: bigint,
  blockNumber: bigint,
): Promise<boolean> {
  const isSubscribed = await client.readContract({
    address: positionRegistry,
    abi: POSITION_REGISTRY_ABI,
    functionName: "isTokenSubscribed",
    args: [tokenId],
    blockNumber: blockNumber,
  });
  return isSubscribed;
}

/**
 * Misc utility to find the block a pool was created at, which is useful for
 * identifying the INITIALIZE_BLOCK constant needed for first runs to build position state
 * ie:
 * await getPoolCreationBlock(
 * client,
 * POOL_MANAGER_ADDRESS,
 * POOL_ID,
 * FROM_BLOCK,
 * TO_BLOCK
 * ).then((res) => console.log(res));
 */
async function getPoolCreationBlock(
  client: PublicClient,
  poolManagerAddress: Address,
  poolId: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
) {
  const events = await client.getLogs({
    address: poolManagerAddress,
    event: parseAbiItem(
      "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
    ),
    args: { id: poolId },
    fromBlock: fromBlock,
    toBlock: toBlock,
  });

  if (events.length === 0) {
    throw new Error("Pool not found");
  }

  // The first event is the initialization
  const initEvent = events[0] as any;

  return {
    blockNumber: initEvent.blockNumber,
    blockHash: initEvent.blockHash,
    transactionHash: initEvent.transactionHash,
    poolDetails: {
      currency0: initEvent.args.currency0,
      currency1: initEvent.args.currency1,
      fee: initEvent.args.fee,
      tickSpacing: initEvent.args.tickSpacing,
      hooks: initEvent.args.hooks,
      sqrtPriceX96: initEvent.args.sqrtPriceX96,
      tick: initEvent.args.tick,
    },
  };
}

async function inspectSwaps(
  client: PublicClient,
  poolId: `0x${string}`,
  poolManager: Address,
  stateView: Address,
  tickLower: number,
  tickUpper: number,
  tickSpacing: number,
  startBlock: bigint,
  endBlock: bigint,
) {
  const position = {
    tickLower: tickLower,
    tickUpper: tickUpper,
    startBlock: startBlock,
    endBlock: endBlock,
  };

  // The specific `Swap` event signature from the Uniswap v4 `IPoolManager` interface
  const swapEventAbi = parseAbiItem(
    "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  );

  const swapLogs = await client.getLogs({
    address: poolManager,
    event: swapEventAbi,
    args: {
      id: poolId as `0x${string}`, // Filter by our specific pool
    },
    fromBlock: position.startBlock,
    toBlock: position.endBlock,
  });

  let swapsInPositionRange = 0;
  const matchingSwaps: any[] = [];
  for (const log of swapLogs) {
    const { tick } = log.args;

    // Check if the swap occurred within the position's active tick range
    if (tick && tick >= position.tickLower && tick <= position.tickUpper) {
      swapsInPositionRange++;
      matchingSwaps.push({
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        tick: tick,
        amountIn: log.args.amount0,
        amountOut: log.args.amount1,
        fee: log.args.fee,
      });
    }
  }

  console.log(`Total swaps: ${swapLogs.length}`);
  console.log(`Swaps inside range: ${swapsInPositionRange}`);

  if (matchingSwaps.length > 0) {
    console.log("\nFirst 10 matching swaps:");
    console.table(matchingSwaps.slice(0, 10));
  }
  const growthSafe = await getFeeGrowthInsideOffchain(
    client,
    poolId,
    stateView,
    tickLower,
    tickUpper,
    tickSpacing,
    endBlock,
  );
  console.log(growthSafe);
  const lowerSafe = await findInitializedTickUnder(
    client,
    poolId,
    stateView,
    tickLower,
    tickSpacing,
    endBlock,
  );
  const upperSafe = await findInitializedTickUnder(
    client,
    poolId,
    stateView,
    tickUpper,
    tickSpacing,
    endBlock,
  );
  console.log(lowerSafe);
  console.log(upperSafe);
  const growthUnsafe = await client.readContract({
    address: stateView,
    abi: STATE_VIEW_ABI,
    functionName: "getFeeGrowthInside",
    args: [poolId, tickLower, tickUpper],
    blockNumber: endBlock,
  });
  console.log(growthUnsafe);
  console.log(tickLower);
  console.log(tickUpper);
}

if (require.main === module) {
  main();
}

/**
 * Initialize the script run by loading previous state from checkpoint file if it exists
 * and resetting all per-period fee values such as `position.feeGrowthInsidePeriod0/1`
 */
export async function initialize(
  checkpointFile: string,
  period: number,
  startBlock: bigint,
  endBlock: bigint,
  client: PublicClient,
  positionManager: Address,
): Promise<Map<bigint, PositionState>> {
  let initialPositions = new Map<bigint, PositionState>();

  if (existsSync(checkpointFile)) {
    if (period === 0)
      throw new Error(
        "Checkpoint file found but period is 0; delete checkpoint file",
      );

    console.log("Checkpoint file found, loading previous state...");
    const fileContent = await readFile(checkpointFile, "utf-8");
    const checkpoint: CheckpointData = JSON.parse(fileContent, (key, value) =>
      typeof value === "string" && /^\d+n$/.test(value)
        ? BigInt(value.slice(0, -1))
        : value,
    );

    const expectedStartBlock = BigInt(checkpoint.blockRange.endBlock) + 1n;
    if (startBlock !== expectedStartBlock) {
      throw new Error(
        `Provided startBlock (${startBlock}) does not correspond to lastProcessedBlock + 1 (${expectedStartBlock})`,
      );
    }

    initialPositions = new Map(checkpoint.positions);
  } else {
    if (period !== 0) {
      throw new Error(
        `No checkpoint file found. Period must be 0 for first runs`,
      );
    }
  }

  if (startBlock > endBlock) {
    console.error("Already up to date. No new blocks to process.");
    throw new Error("No new blocks to process");
  }

  // initialize initialPositions
  for (const [key, position] of initialPositions) {
    // delete positions that were burned last period
    if (position.liquidity === 0n) {
      const tokenId = toBigInt(key);
      const positionInfo = await client.readContract({
        address: positionManager,
        abi: POSITION_MANAGER_ABI,
        functionName: "positionInfo",
        args: [tokenId],
        blockNumber: startBlock,
      });
      if (positionInfo === 0n) {
        initialPositions.delete(key);
        continue;
      }
    }

    // wipe feeGrowthInsidePeriod0/1 to 0n at start of period to track per-period fees
    updatePosition(initialPositions, key, {
      feeGrowthInsidePeriod0: 0n,
      feeGrowthInsidePeriod1: 0n,
      liquidityModifications: [],
    });
  }
  console.log(`Analyzing fees from block ${startBlock} to ${endBlock}...`);

  return initialPositions;
}

function setPoolConfig(poolId_: `0x${string}`, period: number) {
  const pool = POOLS.find((p) => p.poolId === poolId_);
  if (!pool) throw new Error("Unrecognized pool ID");

  const { network, denominator, name, currency0, currency1 } = pool;
  if (!(network in NETWORKS)) {
    throw new Error(`Network ${network} is not supported`);
  }
  const { poolManager, positionRegistry, positionManager, stateView } =
    NETWORKS[network as SupportedChainId];
  const checkpointFile = `${TELX_BASE_PATH}/${pool.name}-${period - 1}.json`;

  const { reward, start, end } = buildPeriodConfig(pool, period);

  return {
    network,
    name,
    poolId: pool.poolId,
    poolManager,
    positionRegistry,
    positionManager,
    stateView,
    denominator,
    currency0,
    currency1,
    rewardAmount: reward,
    startBlock: start,
    endBlock: end,
    tickSpacing: pool.tickSpacing,
    checkpointFile,
  };
}

function parseCLIArgs(args: string[]): [`0x${string}`, number, boolean] {
  if (args.length < 1 || args.length > 2) {
    throw new Error("Usage: <poolId:period> [--rerun]");
  }
  const [poolId, periodStr] = args[0].split(":");
  if (!poolId?.startsWith("0x")) {
    throw new Error("Invalid poolId format");
  }
  const period = Number(periodStr);
  if (isNaN(period) || period < 0 || period > PERIODS.length - 1) {
    throw new Error(`Invalid period, must be [0:${PERIODS.length - 1}]`);
  }
  const rerun = args[1] === "--rerun";
  if (args[1] !== undefined && !rerun) {
    throw new Error(`Unknown flag: ${args[1]}`);
  }
  return [poolId as `0x${string}`, period, rerun];
}

function buildPeriodConfig(pool: PoolConfig, period: number) {
  const networkCfg = NETWORKS[pool.network as SupportedChainId];
  if (period === 0) {
    return {
      reward: INITIALIZE_REWARD_AMOUNT,
      start: pool.initializeBlock,
      end: networkCfg.periodStarts[0] - 1n,
    };
  }

  const index = period - 1;

  // Automate the start block: a period begins on the block immediately after
  // the previous period's recorded end block (read from its checkpoint output),
  // rather than a hand-entered value. This removes the manual start-block
  // selection that previously had to be typed in, and guarantees the range is
  // sequential and contiguous with the last epoch — derived from output, not
  // from the clock. `periodStarts` remains the source of truth for the period
  // END boundary.
  const start = previousPeriodEndBlock(pool, period) + 1n;
  const end = networkCfg.periodStarts[index + 1] - 1n;

  // Contiguity guard: if a curated boundary exists for this period's start, the
  // derived value must agree with it — catches gaps/overlaps from a mistyped
  // boundary block before any fees are computed.
  const curatedStart = networkCfg.periodStarts[index];
  if (curatedStart !== undefined && start !== curatedStart) {
    throw new Error(
      `Derived startBlock ${start} for ${pool.name} period ${period} does not ` +
        `match periodStarts[${index}] (${curatedStart}). Check the boundary ` +
        `blocks in NETWORKS — the previous period's checkpoint ended at ` +
        `${start - 1n}.`,
    );
  }

  const reward =
    period === 1 ? pool.rewardAmounts.FIRST : pool.rewardAmounts.PERIOD;

  return { reward, start, end };
}

/**
 * Reads the end block recorded in the previous period's checkpoint output so
 * the next period can continue sequentially from it. The start of period N is,
 * by definition, the block immediately after period N-1's end — so it is
 * recovered from prior output and never chosen by hand.
 */
function previousPeriodEndBlock(pool: PoolConfig, period: number): bigint {
  const checkpointFile = `${TELX_BASE_PATH}/${pool.name}-${period - 1}.json`;
  if (!existsSync(checkpointFile)) {
    throw new Error(
      `Cannot derive startBlock for ${pool.name} period ${period}: previous ` +
        `checkpoint ${checkpointFile} not found. Run period ${period - 1} first.`,
    );
  }
  const raw = JSON.parse(readFileSync(checkpointFile, "utf-8"));
  if (!raw?.blockRange?.endBlock) {
    throw new Error(
      `Checkpoint ${checkpointFile} has no blockRange.endBlock to continue from.`,
    );
  }
  return toBigInt(raw.blockRange.endBlock);
}

// identifies whether denominator is token0 or token1
function denominatorIsCurrencyZero(
  denominator: Address,
  currency0: Address,
  currency1: Address,
): boolean {
  const denominatorIsCurrency0 = getAddress(currency0) === denominator;
  const denominatorIsCurrency1 = getAddress(currency1) === denominator;
  if (!denominatorIsCurrency0 && !denominatorIsCurrency1) {
    throw new Error("denominator not found in pool");
  }

  return denominatorIsCurrency0;
}
