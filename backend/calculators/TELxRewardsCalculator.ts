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
import { existsSync } from "fs";
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

export interface PositionState {
  lastOwner: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint; // the final liquidity amount after fully processing the period
  feeGrowthInsidePeriod0: bigint; // currency0 final total fee growth after processing period
  feeGrowthInsidePeriod1: bigint; // currency1 final total fee growth after processing period
  liquidityModifications: LiquidityChange[];
}

interface LiquidityChange {
  blockNumber: bigint;
  newLiquidityAmount: bigint;
  owner: Address;
}

export interface LPData {
  periodFeesCurrency0: bigint;
  periodFeesCurrency1: bigint;
  totalFeesCommonDenominator?: bigint;
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
}

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

const PRECISION = 10n ** 64n;
const INITIALIZE_REWARD_AMOUNT = 0n;
const FIRST_PERIOD_REWARD_AMOUNT_ETH_TEL = 101_851_851n; // prorated
const PERIOD_REWARD_AMOUNT_ETH_TEL = 64_814_814n;
const FIRST_PERIOD_REWARD_AMOUNT_USDC_EMXN = 88_000_000n; // prorated
const PERIOD_REWARD_AMOUNT_USDC_EMXN = 56_000_000n;
const POOL_MANAGER_ABI = parseAbi([
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
]);
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

// ---------------- Pool Definitions ----------------

// BASE — ETH/TEL
const BASE_ETH_TEL: PoolConfig = {
  network: ChainId.Base,
  name: "base-ETH-TEL",
  poolId: "0xb6d004fca4f9a34197862176485c45ceab7117c86f07422d1fe3d9cfd6e9d1da",
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
  poolId: "0x9a005a0c12cc2ef01b34e9a7f3fb91a0e6304d377b5479bd3f08f8c29cdf5deb",
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
  poolId: "0xfd56605f7f4620ab44dfc0860d70b9bd1d1f648a5a74558491b39e816a10b99a",
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

export const POOLS = [BASE_ETH_TEL, POLYGON_ETH_TEL, POLYGON_USDC_EMXN];
export const PERIODS = Array.from({ length: 9 }, (_, i) => i); // [0, 1, 2, 3, 4, 5, 6, 7, 8]
export const TELX_BASE_PATH = "backend/checkpoints";

export type SupportedChainId = ChainId.Polygon | ChainId.Base;
const NETWORKS = {
  [ChainId.Polygon]: {
    poolManager: getAddress("0x67366782805870060151383f4bbff9dab53e5cd6"),
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
    ],
  },
  [ChainId.Base]: {
    poolManager: getAddress("0x498581fF718922c3f8e6A244956aF099B2652b2b"),
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
    ],
  },
};

async function main() {
  const args = process.argv.slice(2);
  const [poolId, period] = parseCLIArgs(args);
  const poolConfig = setPoolConfig(poolId, period);

  // Load state from checkpoint json if it exists and reset its period-specific fee fields
  const client = createRpcClient(poolConfig.network);

  let initialPositions: Map<bigint, PositionState> = await initialize(
    poolConfig.checkpointFile,
    period,
    poolConfig.startBlock,
    poolConfig.endBlock,
    client,
    poolConfig.positionManager
  );
  const { lpData: lpFees, finalPositions } = await updateFeesAndPositions(
    poolId,
    poolConfig.startBlock,
    poolConfig.endBlock,
    client,
    poolConfig.poolManager,
    poolConfig.stateView,
    poolConfig.positionManager,
    poolConfig.tickSpacing,
    initialPositions
  );
  const denominatorIsCurrency0 = denominatorIsCurrencyZero(
    poolConfig.denominator,
    poolConfig.currency0,
    poolConfig.currency1
  );
  const vwapPriceScaled = await getVolumeWeightedAveragePriceScaled(
    client,
    poolId,
    poolConfig.stateView,
    poolConfig.startBlock,
    poolConfig.endBlock,
    denominatorIsCurrency0
  );
  const lpData = await populateTotalFeesCommonDenominator(
    lpFees,
    vwapPriceScaled,
    denominatorIsCurrency0
  );

  const lpRewards = calculateRewardDistribution(
    lpData,
    poolConfig.rewardAmount
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
  };
  const outputFile = `${TELX_BASE_PATH}/${poolConfig.name}-${period}.json`;
  await writeFile(
    outputFile,
    JSON.stringify(
      newCheckpoint,
      (key, value) =>
        typeof value === "bigint" ? value.toString() + "n" : value,
      2
    ),
    "utf-8"
  );

  console.log("Analysis complete. New checkpoint saved.");
}

async function updateFeesAndPositions(
  poolId: `0x${string}`,
  startBlock: bigint,
  endBlock: bigint,
  client: PublicClient,
  poolManager: Address,
  stateView: Address,
  positionManager: Address,
  tickSpacing: number,
  initialPositions: Map<bigint, PositionState>
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
    poolManager,
    positionManager,
    initialPositions
  );
  // use final positions to credit fees to LPs
  const { lpData, finalPositions } = await processFees(
    poolId,
    client,
    startBlock,
    endBlock,
    stateView,
    tickSpacing,
    updatedPositions
  );

  return { lpData, finalPositions };
}

async function updatePositions(
  poolId: `0x${string}`,
  startBlock: bigint,
  endBlock: bigint,
  client: PublicClient,
  poolManager: Address,
  positionManager: Address,
  initialPositions: Map<bigint, PositionState>
): Promise<Map<bigint, PositionState>> {
  // use copy of initial positions fetched from checkpoint file
  const positions = new Map<bigint, PositionState>(initialPositions);

  // fetch all ModifyPosition events in the new range
  const logs = await client.getLogs({
    address: poolManager,
    event: parseAbiItem(
      "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)"
    ),
    args: { id: poolId },
    fromBlock: startBlock,
    toBlock: endBlock,
  });

  // sort logs by block number and then log index to ensure chronological processing
  logs.sort((a: any, b: any) => {
    if (a.blockNumber === b.blockNumber) {
      return Number(a.logIndex) - Number(b.logIndex);
    }
    return Number(a.blockNumber) - Number(b.blockNumber);
  });

  // process logs to update position list, adding new ones when detected and marking liquidity changes on existing ones
  for (const log of logs) {
    if (!log.args || !log.blockNumber) continue;
    const { tickLower, tickUpper, liquidityDelta, salt } = log.args as any;
    const tokenId = hexToBigInt(salt!);
    if (!tokenId) throw new Error("Missing tokenId in event args");
    // fees accrued are credited to the owner at the time of the event (since transfers do not settle fees)
    const lp = await client.readContract({
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber: log.blockNumber,
    });

    const currentPositionState = positions.get(tokenId);
    let newLiquidity = 0n;
    if (currentPositionState) {
      // previously existing position, mark subperiod with liquidity change
      const currentLiquidity = toBigInt(currentPositionState.liquidity);
      // Check if this is the first modification we've seen for this existing position in this period
      if (currentPositionState.liquidityModifications.length === 0) {
        // Add the initial state at the start of the period
        currentPositionState.liquidityModifications.push({
          blockNumber: startBlock,
          newLiquidityAmount: currentLiquidity, // use checkpoint liquidity (persisted as opposed to liquidityModifications wipe in initialize())
          owner: lp,
        });
      }

      // update the positions entry with new liquidity and append the liquidity modification event
      newLiquidity = currentLiquidity + toBigInt(liquidityDelta!);
      const change: LiquidityChange = {
        blockNumber: log.blockNumber,
        newLiquidityAmount: newLiquidity,
        owner: lp,
      };

      positions.set(tokenId, {
        ...currentPositionState,
        liquidity: newLiquidity,
        liquidityModifications: [
          ...currentPositionState.liquidityModifications,
          change,
        ],
      });
    } else {
      // this is a newly detected position; delta is the initial liquidity amount
      newLiquidity = toBigInt(liquidityDelta!);
      // new positions start period with a subperiod of 0 liquidity until creation time
      const changes: LiquidityChange[] = [
        { blockNumber: startBlock, newLiquidityAmount: 0n, owner: zeroAddress },
        {
          blockNumber: log.blockNumber,
          newLiquidityAmount: newLiquidity,
          owner: lp,
        },
      ];

      // placeholders used for feeGrowth params until final processing step
      positions.set(tokenId, {
        lastOwner: lp,
        tickLower: tickLower!,
        tickUpper: tickUpper!,
        liquidity: liquidityDelta!,
        feeGrowthInsidePeriod0: 0n,
        feeGrowthInsidePeriod1: 0n,
        liquidityModifications: changes,
      });
    }
  }

  // loop over map again to append final subperiod chunk from last update to endBlock
  for (const [tokenId, position] of positions.entries()) {
    const ownerAtEndBlock: Address = await client.readContract({
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber: endBlock,
    });

    // construct new memory array which includes final chunk of time between last modification and period endBlock
    const timelinePoints = [];
    if (position.liquidityModifications.length === 0) {
      // Case 1: Pre-existing position with NO modifications this period, but owner may have changed
      // first delete irrelevant positions; even if not burned they will be recognized as new if liquidity is re-added
      if (position.liquidity === 0n) {
        positions.delete(tokenId);
        continue;
      }
      // The timeline is just the start and end of the full period.
      timelinePoints.push({
        blockNumber: startBlock,
        newLiquidityAmount: position.liquidity,
        owner: position.lastOwner,
      });
      timelinePoints.push({
        blockNumber: endBlock,
        newLiquidityAmount: position.liquidity,
        owner: ownerAtEndBlock,
      });

      updatePosition(positions, tokenId, {
        liquidityModifications: timelinePoints,
      });
    } else {
      // Case 2: Position was created or modified during the period.
      // The timeline is its list of modifications prepended with pre-chunk from startBlock; append post-chunk until endBlock
      timelinePoints.push(...position.liquidityModifications);
      const lastChange = timelinePoints[timelinePoints.length - 1];
      timelinePoints.push({
        blockNumber: endBlock,
        newLiquidityAmount: lastChange.newLiquidityAmount, // Liquidity carries over til endBlock
        owner: ownerAtEndBlock,
      });

      updatePosition(positions, tokenId, {
        liquidityModifications: timelinePoints,
      });
    }
  }

  return positions;
}

/**
 * Identifies cumulative fee totals for each liquidity provider
 * @return finalPositions Map of `tokenId => PositionState` tracking state of each unique position
 * @return lpData Map of `LP => LPData` tracking total fees per LP
 */
async function processFees(
  poolId: `0x${string}`,
  client: PublicClient,
  startBlock: bigint,
  endBlock: bigint,
  stateView: Address,
  tickSpacing: number,
  positions: Map<bigint, PositionState> // must be fully processed for the period
): Promise<{
  lpData: Map<Address, LPData>;
  finalPositions: Map<bigint, PositionState>;
}> {
  // iterate over finalized PositionStates to construct lpData map<lpTokenOwnerAddress, totalFeesEarned>
  const lpData = new Map<Address, LPData>();
  for (const [tokenId, position] of positions.entries()) {
    // iterate over the liquidity modifications to process each sub-period, summing to fee growth over whole period
    let feesEarnedThisPeriod0 = 0n;
    let feesEarnedThisPeriod1 = 0n;
    for (let i = 1; i < position.liquidityModifications.length; i++) {
      // define the sub-period starting from the second item, as the first is the initial state at period start
      const prevChange = position.liquidityModifications[i - 1];
      const currChange = position.liquidityModifications[i];

      const subperiodStart = prevChange.blockNumber;
      const subperiodEnd = currChange.blockNumber;
      const effectiveSubperiodEnd =
        subperiodEnd > subperiodStart ? subperiodEnd - 1n : subperiodEnd;
      const liquidityForSubperiod = prevChange.newLiquidityAmount;

      // skip if no liquidity or if the period is zero blocks
      if (
        liquidityForSubperiod === 0n ||
        startBlock === endBlock ||
        effectiveSubperiodEnd < subperiodStart
      ) {
        continue;
      }

      // get fee growth values and calculate the subperiod delta
      const feeGrowthStart = await getFeeGrowthInsideOffchain(
        client,
        poolId,
        stateView,
        position.tickLower,
        position.tickUpper,
        tickSpacing,
        subperiodStart
      );
      const feeGrowthEnd = await getFeeGrowthInsideOffchain(
        client,
        poolId,
        stateView,
        position.tickLower,
        position.tickUpper,
        tickSpacing,
        effectiveSubperiodEnd
      );

      // calculate subperiod's fees and add to period total for this position
      const { token0Fees: feesEarned0, token1Fees: feesEarned1 } =
        calculateFees(
          liquidityForSubperiod,
          feeGrowthEnd.feeGrowthInside0X128,
          feeGrowthEnd.feeGrowthInside1X128,
          feeGrowthStart.feeGrowthInside0X128,
          feeGrowthStart.feeGrowthInside1X128
        );
      feesEarnedThisPeriod0 += feesEarned0;
      feesEarnedThisPeriod1 += feesEarned1;

      // aggregate fees for the owner of the position at that time
      const lp = currChange.owner;
      const currentFees = lpData.get(lp) ?? {
        periodFeesCurrency0: 0n,
        periodFeesCurrency1: 0n,
      };

      lpData.set(lp, {
        periodFeesCurrency0: currentFees.periodFeesCurrency0 + feesEarned0,
        periodFeesCurrency1: currentFees.periodFeesCurrency1 + feesEarned1,
      });
      updatePosition(positions, tokenId, {
        lastOwner: lp,
        feeGrowthInsidePeriod0: feesEarnedThisPeriod0,
        feeGrowthInsidePeriod1: feesEarnedThisPeriod1,
      });
    }
  }

  return { lpData, finalPositions: positions };
}

// calculates fees earned for the given `liquidity` between start and end checkpoints
export function calculateFees(
  liquidity: bigint,
  feeGrowthInside0End: bigint,
  feeGrowthInside1End: bigint,
  feeGrowthInside0Start: bigint,
  feeGrowthInside1Start: bigint
): { token0Fees: bigint; token1Fees: bigint } {
  const Q128 = 2n ** 128n;
  const MAX_UINT256 = 2n ** 256n;
  const feeGrowthDelta0 =
    (feeGrowthInside0End - feeGrowthInside0Start + MAX_UINT256) % MAX_UINT256;
  const feeGrowthDelta1 =
    (feeGrowthInside1End - feeGrowthInside1Start + MAX_UINT256) % MAX_UINT256;

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
    feeGrowthInsidePeriod0?: bigint;
    feeGrowthInsidePeriod1?: bigint;
    liquidityModifications?: LiquidityChange[];
  }
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
      updates.feeGrowthInsidePeriod0 === undefined ||
      updates.feeGrowthInsidePeriod1 === undefined ||
      updates.liquidityModifications === undefined
    ) {
      throw new Error(
        `Cannot create new position ${key}: due to missing required fields.`
      );
    }

    // create new position entry
    positions.set(key, {
      lastOwner: updates.lastOwner,
      tickLower: updates.tickLower,
      tickUpper: updates.tickUpper,
      liquidity: updates.liquidity,
      feeGrowthInsidePeriod0: updates.feeGrowthInsidePeriod0,
      feeGrowthInsidePeriod1: updates.feeGrowthInsidePeriod1,
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
  updates: Partial<LPData>
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
async function getFeeGrowthInsideOffchain(
  client: PublicClient,
  poolId: `0x${string}`,
  stateView: Address,
  tickLower: number,
  tickUpper: number,
  tickSpacing: number,
  blockNumber: bigint
): Promise<{ feeGrowthInside0X128: bigint; feeGrowthInside1X128: bigint }> {
  try {
    const [feeGrowthInside0X128, feeGrowthInside1X128] =
      await client.readContract({
        address: stateView,
        abi: STATE_VIEW_ABI,
        functionName: "getFeeGrowthInside",
        args: [poolId, tickLower, tickUpper],
        blockNumber,
      });
    return { feeGrowthInside0X128, feeGrowthInside1X128 };
  } catch (error) {
    console.warn(
      "getFeeGrowthInside call failed, falling back to manual computation",
      error
    );
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

  // find nearest initialized ticks: lower searches downward, upper searches upward
  const safeTickLower = await findInitializedTickUnder(
    client,
    poolId,
    stateView,
    tickLower,
    tickSpacing,
    blockNumber
  );
  const safeTickUpper = await findInitializedTickAbove(
    client,
    poolId,
    stateView,
    tickUpper,
    tickSpacing,
    blockNumber
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

  const feeGrowthInside0X128 = calculateFeeGrowthInside(
    feeGrowthGlobal0X128,
    feeGrowthBelow0X128,
    feeGrowthAbove0X128
  );
  const feeGrowthInside1X128 = calculateFeeGrowthInside(
    feeGrowthGlobal1X128,
    feeGrowthBelow1X128,
    feeGrowthAbove1X128
  );

  return { feeGrowthInside0X128, feeGrowthInside1X128 };
}

export function calculateFeeGrowthInside(
  feeGrowthGlobal: bigint,
  feeGrowthBelow: bigint,
  feeGrowthAbove: bigint
): bigint {
  const MAX_UINT256 = 2n ** 256n;
  return (
    (feeGrowthGlobal - feeGrowthBelow - feeGrowthAbove + MAX_UINT256) %
    MAX_UINT256
  );
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
 * Finds the highest safe initialized tick under `startTick` by searching downward (inclusive)
 */
export async function findInitializedTickUnder(
  client: PublicClient,
  poolId: `0x${string}`,
  stateView: Address,
  startTick: number,
  tickSpacing: number,
  blockNumber: bigint,
  searchLimit: number = 2560 // Safety limit: search up to 10 words
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
      blockNumber
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
 * Finds the lowest safe initialized tick above `startTick` by searching upward (inclusive)
 */
export async function findInitializedTickAbove(
  client: PublicClient,
  poolId: `0x${string}`,
  stateView: Address,
  startTick: number,
  tickSpacing: number,
  blockNumber: bigint,
  searchLimit: number = 2560 // Safety limit: search up to 10 words
): Promise<number | null> {
  const startWord = tickToWord(startTick, tickSpacing);

  let startCompressed = Math.floor(startTick / tickSpacing);
  if (startTick < 0 && startTick % tickSpacing !== 0) {
    startCompressed -= 1;
  }
  const startBitPos = startCompressed & 255;

  for (let wordOffset = 0; wordOffset < searchLimit; wordOffset++) {
    const currentWord = startWord + wordOffset;

    const bitmap = await getTickBitmap(
      client,
      poolId,
      stateView,
      currentWord,
      blockNumber
    );

    if (bitmap !== 0n) {
      const startBit = wordOffset === 0 ? startBitPos : 0;

      for (let bit = startBit; bit < 256; bit++) {
        if ((bitmap & (1n << BigInt(bit))) !== 0n) {
          const tickIndex = (currentWord * 256 + bit) * tickSpacing;
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
  blockNumber: bigint
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

// Sums token0 and token1 amounts into a value denominated in a single currency based on current tick price
// updates lpData map by setting `LPData.totalFeesDenominatedInTEL` for all entries
async function populateTotalFeesCommonDenominator(
  lpData: Map<Address, LPData>,
  vwapPriceScaled: bigint,
  denominatorIsCurrency0: boolean
): Promise<Map<Address, LPData>> {
  // convert both amounts into denominator and sum;
  for (const [lpAddress, fees] of lpData) {
    let totalFeesInDenominator: bigint;

    if (denominatorIsCurrency0) {
      // periodFeesCurrency0 is already in denominator; convert periodFeesCurrency1
      const amount1InDenominator =
        (fees.periodFeesCurrency1 * vwapPriceScaled) / PRECISION; // unscale
      totalFeesInDenominator = fees.periodFeesCurrency0 + amount1InDenominator;
    } else {
      // periodFeesCurrency1 is already in denominator, so convert periodFeesCurrency0
      const amount0InDenominator =
        (fees.periodFeesCurrency0 * vwapPriceScaled) / PRECISION; // unscale
      totalFeesInDenominator = fees.periodFeesCurrency1 + amount0InDenominator;
    }

    modifyLPData(lpData, lpAddress, {
      totalFeesCommonDenominator: totalFeesInDenominator,
    });
  }

  return lpData;
}

async function getFeeGrowthGlobalsPeriodDelta(
  client: PublicClient,
  poolId: `0x${string}`,
  stateView: Address,
  startBlock: bigint,
  endBlock: bigint
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

  if (feeGrowthDelta0 === 0n || feeGrowthDelta1 === 0n) {
    throw new Error("No fee growth in one or both assets during the period.");
  }

  return { feeGrowthDelta0, feeGrowthDelta1 };
}

// Use total global fee growth of period to calculate deltas as VWAP
async function getVolumeWeightedAveragePriceScaled(
  client: PublicClient,
  poolId: `0x${string}`,
  stateView: Address,
  startBlock: bigint,
  endBlock: bigint,
  denominatorIsCurrency0: boolean
): Promise<bigint> {
  // fetch fee growth at start and end of period
  const { feeGrowthDelta0, feeGrowthDelta1 } =
    await getFeeGrowthGlobalsPeriodDelta(
      client,
      poolId,
      stateView,
      startBlock,
      endBlock
    );

  // Calculate VWAP based on fee ratio, representing average exchange rate for period
  let scaledVwapPrice: bigint;
  if (denominatorIsCurrency0) {
    // Price = token1 / token0
    scaledVwapPrice = (feeGrowthDelta0 * PRECISION) / feeGrowthDelta1;
    return scaledVwapPrice;
  } else {
    // Price = token0 / token1
    scaledVwapPrice = (feeGrowthDelta1 * PRECISION) / feeGrowthDelta0;
    return scaledVwapPrice;
  }
}

// allocates each LP the amount proportional to their share of the total reward amount
function calculateRewardDistribution(
  lpData: Map<Address, LPData>,
  rewardAmount: bigint
): Map<Address, LPData> {
  const totalFees = Array.from(lpData.values())
    .map((data) => data.totalFeesCommonDenominator!)
    .reduce((a, b) => a + b, 0n);
  if (totalFees === 0n) return new Map();

  // calculate each LP's share of rewards
  for (const [lpAddress, lpFees] of lpData) {
    // identify proportional reward: (lpFeesTELDenominated / totalFees) * rewardAmount
    const scaledShare =
      (lpFees.totalFeesCommonDenominator! * PRECISION) / totalFees;
    const lpReward = (scaledShare * rewardAmount) / PRECISION;

    modifyLPData(lpData, lpAddress, { reward: lpReward });
  }

  return lpData;
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
  toBlock: bigint
) {
  const events = await client.getLogs({
    address: poolManagerAddress,
    event: parseAbiItem(
      "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"
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
  endBlock: bigint
) {
  const position = {
    tickLower: tickLower,
    tickUpper: tickUpper,
    startBlock: startBlock,
    endBlock: endBlock,
  };

  // The specific `Swap` event signature from the Uniswap v4 `IPoolManager` interface
  const swapEventAbi = parseAbiItem(
    "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"
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
    endBlock
  );
  console.log(growthSafe);
  const lowerSafe = await findInitializedTickUnder(
    client,
    poolId,
    stateView,
    tickLower,
    tickSpacing,
    endBlock
  );
  const upperSafe = await findInitializedTickUnder(
    client,
    poolId,
    stateView,
    tickUpper,
    tickSpacing,
    endBlock
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
async function initialize(
  checkpointFile: string,
  period: number,
  startBlock: bigint,
  endBlock: bigint,
  client: PublicClient,
  positionManager: Address
): Promise<Map<bigint, PositionState>> {
  let initialPositions = new Map<bigint, PositionState>();

  if (existsSync(checkpointFile)) {
    if (period === 0)
      throw new Error(
        "Checkpoint file found but period is 0; delete checkpoint file"
      );

    console.log("Checkpoint file found, loading previous state...");
    const fileContent = await readFile(checkpointFile, "utf-8");
    const checkpoint: CheckpointData = JSON.parse(fileContent, (key, value) =>
      typeof value === "string" && /^\d+n$/.test(value)
        ? BigInt(value.slice(0, -1))
        : value
    );

    const expectedStartBlock = BigInt(checkpoint.blockRange.endBlock) + 1n;
    if (startBlock !== expectedStartBlock) {
      throw new Error(
        `Provided startBlock (${startBlock}) does not correspond to lastProcessedBlock + 1 (${expectedStartBlock})`
      );
    }

    initialPositions = new Map(checkpoint.positions);
  } else {
    if (period !== 0) {
      throw new Error(
        `No checkpoint file found. Period must be 0 for first runs`
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
      if (positionInfo === 0n) initialPositions.delete(key);
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
  const { poolManager, positionManager, stateView } =
    NETWORKS[network as SupportedChainId];
  const checkpointFile = `${TELX_BASE_PATH}/${pool.name}-${period - 1}.json`;

  const { reward, start, end } = buildPeriodConfig(pool, period);

  return {
    network,
    name,
    poolId: pool.poolId,
    poolManager,
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

function parseCLIArgs(args: string[]): [`0x${string}`, number] {
  if (args.length !== 1) {
    throw new Error("Usage: <poolId:period>");
  }
  const [poolId, periodStr] = args[0].split(":");
  if (!poolId?.startsWith("0x")) {
    throw new Error("Invalid poolId format");
  }
  const period = Number(periodStr);
  if (isNaN(period) || period < 0 || period > 8) {
    throw new Error("Invalid period, must be 0–8");
  }
  return [poolId as `0x${string}`, period];
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
  const start = networkCfg.periodStarts[index];
  const end = networkCfg.periodStarts[index + 1] - 1n;
  const reward =
    period === 1 ? pool.rewardAmounts.FIRST : pool.rewardAmounts.PERIOD;

  return { reward, start, end };
}

// identifies whether denominator is token0 or token1
function denominatorIsCurrencyZero(
  denominator: Address,
  currency0: Address,
  currency1: Address
): boolean {
  const denominatorIsCurrency0 = getAddress(currency0) === denominator;
  const denominatorIsCurrency1 = getAddress(currency1) === denominator;
  if (!denominatorIsCurrency0 && !denominatorIsCurrency1) {
    throw new Error("denominator not found in pool");
  }

  return denominatorIsCurrency0;
}
