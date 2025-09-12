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
import { readFile, writeFile } from "fs/promises";
import { NetworkConfig, parseAndSanitizeCLIArgs } from "helpers";
dotenv.config();

/// usage: `yarn ts-node backend/calculators/TELxRewardsCalculator.ts`

interface PositionState {
  lp: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInsidePeriod0: bigint;
  feeGrowthInsidePeriod1: bigint;
  // the fee growth inside the range, as of the last modification event
  feeGrowthInsideLast0: bigint;
  feeGrowthInsideLast1: bigint;
  // the block number when this position was last updated
  lastUpdatedBlock: bigint;
}

interface LPData {
  periodFeesCurrency0: bigint;
  periodFeesCurrency1: bigint;
  totalFeesTELDenominated?: bigint;
  reward?: bigint;
}

interface CheckpointData {
  blockRange: NetworkConfig;
  poolId: `0x${string}`;
  positions: [string, PositionState][];
  lpData: [string, LPData][];
}

type PoolConfig = {
  network: "polygon" | "base";
  poolId: `0x${string}`;
  denominator: Address;
  initializeBlock: bigint;
  rewardAmounts: { FIRST: bigint; PERIOD: bigint };
};

const PRECISION = 10n ** 18n;
const CHECKPOINT_FILE = "./positions-checkpoint.json";
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
]);
const POSITION_MANAGER_ABI = parseAbi([
  "function positionInfo(uint256 tokenId) external view returns (uint256)",
  "function ownerOf(uint256 id) public view returns (address owner)",
  "function poolKeys(bytes25 poolId) external view returns (address token0, address token1, uint24 fee, int24 tickSpacing, address hooks)",
]);

// ---------------- Pool Definitions ----------------

// BASE — ETH/TEL
const BASE_ETH_TEL: PoolConfig = {
  network: "base",
  poolId: "0xb6d004fca4f9a34197862176485c45ceab7117c86f07422d1fe3d9cfd6e9d1da",
  denominator: getAddress("0x09bE1692ca16e06f536F0038fF11D1dA8524aDB1"), // TEL
  initializeBlock: 25_832_462n,
  rewardAmounts: {
    FIRST: FIRST_PERIOD_REWARD_AMOUNT_ETH_TEL,
    PERIOD: PERIOD_REWARD_AMOUNT_ETH_TEL,
  },
};

// POLYGON — ETH/TEL
const POLYGON_ETH_TEL: PoolConfig = {
  network: "polygon",
  poolId: "0x9a005a0c12cc2ef01b34e9a7f3fb91a0e6304d377b5479bd3f08f8c29cdf5deb",
  denominator: getAddress("0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32"), // TEL
  initializeBlock: 67_949_841n,
  rewardAmounts: {
    FIRST: FIRST_PERIOD_REWARD_AMOUNT_ETH_TEL,
    PERIOD: PERIOD_REWARD_AMOUNT_ETH_TEL,
  },
};

// POLYGON — USDC/eMXN
const POLYGON_USDC_EMXN: PoolConfig = {
  network: "polygon",
  poolId: "0xfd56605f7f4620ab44dfc0860d70b9bd1d1f648a5a74558491b39e816a10b99a",
  denominator: getAddress("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"), // USDC
  initializeBlock: 74_664_812n,
  rewardAmounts: {
    FIRST: FIRST_PERIOD_REWARD_AMOUNT_USDC_EMXN,
    PERIOD: PERIOD_REWARD_AMOUNT_USDC_EMXN,
  },
};

const NETWORKS = {
  polygon: {
    poolManager: getAddress("0x67366782805870060151383f4bbff9dab53e5cd6"),
    positionManager: getAddress("0x1Ec2eBf4F37E7363FDfe3551602425af0B3ceef9"),
    stateView: getAddress("0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a"),
    rpcEnv: "POLYGON_RPC_URL",
    periodStarts: [
      74_970_501n, // programStart
      75_417_061n,
      75_697_435n,
      75_981_195n,
      76_265_454n,
    ],
  },
  base: {
    poolManager: getAddress("0x498581fF718922c3f8e6A244956aF099B2652b2b"),
    positionManager: getAddress("0x7C5f5A4bBd8fD63184577525326123B519429bDc"),
    stateView: getAddress("0xa3c0c9b65bad0b08107aa264b0f3db444b867a71"),
    rpcEnv: "BASE_RPC_URL",
    periodStarts: [
      33_954_128n, // programStart
      34_429_327n,
      34_731_727n,
      35_034_127n,
      35_336_526n,
    ],
  },
};

async function main() {
  const args = process.argv.slice(2);
  const [poolId, period] = parseCLIArgs(args);
  const config = setConfig(poolId, period);

  // Load state from checkpoint json if it exists and reset its period-specific fee fields
  let initialPositions: Map<string, PositionState> = await initialize(
    period,
    config.startBlock,
    config.endBlock
  );
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const { lpData: lpFees, finalPositions } = await updateFeesAndPositions(
    poolId,
    config.startBlock,
    config.endBlock,
    client,
    config.poolManager,
    config.stateView,
    config.positionManager,
    initialPositions
  );

  const lpData = await denominateTokenAmountsInTEL(
    lpFees,
    config.denominator,
    config.stateView,
    config.positionManager,
    poolId,
    client,
    config.endBlock
  );

  const lpRewards = calculateRewardDistribution(lpData, config.rewardAmount);

  // write to the checkpoint file
  const newCheckpoint: CheckpointData = {
    blockRange: {
      network: config.network,
      startBlock: config.startBlock,
      endBlock: config.endBlock,
    },
    poolId: poolId,
    positions: Array.from(finalPositions.entries()),
    lpData: Array.from(lpRewards.entries()),
  };
  await writeFile(
    CHECKPOINT_FILE,
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
  initialPositions: Map<string, PositionState>
): Promise<{
  lpData: Map<string, LPData>;
  finalPositions: Map<string, PositionState>;
}> {
  // Run the core analysis logic
  const { lpData, finalPositions } = await fetchLPData(
    poolId,
    startBlock,
    endBlock,
    client,
    poolManager,
    stateView,
    positionManager,
    initialPositions
  );

  // assert final outputs are correct
  for (const [key, position] of finalPositions) {
    verifyPositionCheckpoint(
      key,
      position,
      client,
      poolId as `0x${string}`,
      endBlock,
      positionManager,
      stateView
    );
  }

  return { lpData, finalPositions };
}

/**
 * Initialize the script run by loading previous state from checkpoint file if it exists
 * and resetting all per-period fee values such as `position.feeGrowthInsidePeriod0/1`
 */
async function initialize(
  period: number,
  startBlock: bigint,
  endBlock: bigint
): Promise<Map<string, PositionState>> {
  let initialPositions = new Map<string, PositionState>();

  if (existsSync(CHECKPOINT_FILE)) {
    console.log("Checkpoint file found, loading previous state...");
    const fileContent = await readFile(CHECKPOINT_FILE, "utf-8");
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
    //todo: validate period info against checkpoint file, make sure lastupdatedblock is 1 before startBlock

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

  // wipe all positions.feeGrowthInsidePeriod0/1 to 0n at start of period to track per-period fees
  for (const [key, position] of initialPositions) {
    updatePosition(initialPositions, key, {
      feeGrowthInsidePeriod0: 0n,
      feeGrowthInsidePeriod1: 0n,
    });
  }
  console.log(`Analyzing fees from block ${startBlock} to ${endBlock}...`);

  return initialPositions;
}

/**
 * Identifies cumulative fee totals for each liquidity provider
 * @return finalPositions Map of `tokenId => PositionState` tracking state of each unique position
 * @return lpData Map of `LP => LPData` tracking total fees per LP
 */
async function fetchLPData(
  poolId: `0x${string}`,
  startBlock: bigint,
  endBlock: bigint,
  client: PublicClient,
  poolManager: Address,
  stateView: Address,
  positionManager: Address,
  initialPositions: Map<string, PositionState>
): Promise<{
  lpData: Map<string, LPData>;
  finalPositions: Map<string, PositionState>;
}> {
  const lpData = new Map<string, LPData>();
  // use copy of initial positions fetched from checkpoint file
  const positions = new Map<string, PositionState>(initialPositions);

  // 1. Fetch all ModifyPosition events in the new range
  const logs = await client.getLogs({
    address: poolManager,
    event: parseAbiItem(
      "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)"
    ),
    args: { id: poolId as `0x${string}` },
    fromBlock: startBlock,
    toBlock: endBlock,
  });

  // Sort logs by block number and then log index to ensure chronological processing
  logs.sort((a, b) => {
    if (a.blockNumber === b.blockNumber) {
      return Number(a.logIndex) - Number(b.logIndex);
    }
    return Number(a.blockNumber) - Number(b.blockNumber);
  });

  // 2. Calculate fees for positions that existed before this period but had no modifications
  for (const [key, position] of positions.entries()) {
    if (position.liquidity > 0) {
      // Check if this position was modified in any of the fetched ModifyLiquidity logs
      const wasModified = logs.some(
        (log) => `${hexToBigInt(log.args.salt!).toString()}` === key
      );
      if (!wasModified) {
        // If not modified, calculate its fees over the whole period and update its feeGrowth baseline
        const feeGrowthAtStart = await getFeeGrowthInside(
          client,
          poolId,
          stateView,
          position.tickLower,
          position.tickUpper,
          startBlock
        );
        const feeGrowthAtEnd = await getFeeGrowthInside(
          client,
          poolId,
          stateView,
          position.tickLower,
          position.tickUpper,
          endBlock
        );

        const { token0Fees: feesEarned0, token1Fees: feesEarned1 } =
          calculateUncollectedFees(
            position.liquidity,
            feeGrowthAtEnd.feeGrowthInside0,
            feeGrowthAtEnd.feeGrowthInside1,
            feeGrowthAtStart.feeGrowthInside0,
            feeGrowthAtStart.feeGrowthInside1
          );

        // fetch current lp owner as of last block since lp may have changed
        const lp = await client.readContract({
          address: positionManager,
          abi: POSITION_MANAGER_ABI,
          functionName: "ownerOf",
          args: [BigInt(key)],
          blockNumber: endBlock,
        });
        const currentLpTotal = lpData.get(lp) ?? {
          periodFeesCurrency0: 0n,
          periodFeesCurrency1: 0n,
        };
        lpData.set(lp, {
          periodFeesCurrency0: currentLpTotal.periodFeesCurrency0 + feesEarned0,
          periodFeesCurrency1: currentLpTotal.periodFeesCurrency1 + feesEarned1,
        });
        updatePosition(positions, key, {
          lp: lp,
          feeGrowthInsidePeriod0: feesEarned0,
          feeGrowthInsidePeriod1: feesEarned1,
          feeGrowthInsideLast0: feeGrowthAtEnd.feeGrowthInside0,
          feeGrowthInsideLast1: feeGrowthAtEnd.feeGrowthInside1,
          lastUpdatedBlock: endBlock,
        });
      }
    }
  }

  // 3. Identify collected fee totals by processing ModifyLiquidity events chronologically
  for (const log of logs) {
    if (!log.args || !log.blockNumber) continue;
    const { tickLower, tickUpper, liquidityDelta, salt } = log.args;
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

    // If position existed, its liquidity was active since last update; calculate subperiod's fees
    const currentPositionState = positions.get(tokenId.toString());
    // all positions.feeGrowthInsidePeriod0/1 are wiped to 0n at start of period so this assignment is period-specific
    let feesEarnedThisPeriod0 = currentPositionState?.feeGrowthInsidePeriod0
      ? currentPositionState?.feeGrowthInsidePeriod0
      : 0n;
    let feesEarnedThisPeriod1 = currentPositionState?.feeGrowthInsidePeriod1
      ? currentPositionState?.feeGrowthInsidePeriod1
      : 0n;
    if (currentPositionState && currentPositionState.liquidity > 0) {
      // calculate fees collected as part of this event (ie uncollected fee amount just before event)
      const feeGrowthInsideNow = await getFeeGrowthInside(
        client,
        poolId,
        stateView,
        currentPositionState.tickLower,
        currentPositionState.tickUpper,
        log.blockNumber
      );
      const { token0Fees: feesEarned0, token1Fees: feesEarned1 } =
        calculateUncollectedFees(
          currentPositionState.liquidity,
          feeGrowthInsideNow.feeGrowthInside0,
          feeGrowthInsideNow.feeGrowthInside1,
          currentPositionState.feeGrowthInsideLast0,
          currentPositionState.feeGrowthInsideLast1
        );

      // add subperiod's collected fees to period total for this position
      feesEarnedThisPeriod0 += feesEarned0;
      feesEarnedThisPeriod1 += feesEarned1;

      // add these collected fees to the LP's total
      const currentLpTotal = lpData.get(lp) ?? {
        periodFeesCurrency0: 0n,
        periodFeesCurrency1: 0n,
      };
      lpData.set(lp, {
        periodFeesCurrency0: currentLpTotal.periodFeesCurrency0 + feesEarned0,
        periodFeesCurrency1: currentLpTotal.periodFeesCurrency1 + feesEarned1,
      });
    }

    // save (add/update) the position's state to current event's block for the *next* iteration
    // these become the new baseline for the next subperiod in case of another modification
    const newLiquidity =
      (currentPositionState?.liquidity ?? 0n) + liquidityDelta!;
    const feeGrowthInsideAtEvent = await getFeeGrowthInside(
      client,
      poolId,
      stateView,
      tickLower!,
      tickUpper!,
      log.blockNumber
    );
    updatePosition(positions, tokenId.toString(), {
      lp: lp,
      poolId: poolId,
      tickLower: tickLower!,
      tickUpper: tickUpper!,
      liquidity: newLiquidity,
      feeGrowthInsidePeriod0: feesEarnedThisPeriod0,
      feeGrowthInsidePeriod1: feesEarnedThisPeriod1,
      feeGrowthInsideLast0: feeGrowthInsideAtEvent.feeGrowthInside0,
      feeGrowthInsideLast1: feeGrowthInsideAtEvent.feeGrowthInside1,
      lastUpdatedBlock: log.blockNumber,
    });
  }

  // 4. Calculate final uncollected fees for all positions with liquidity modifications this period
  for (const [key, position] of positions.entries()) {
    if (position.liquidity > 0 && position.lastUpdatedBlock !== endBlock) {
      const positionFinalFeeGrowth = await getFeeGrowthInside(
        client,
        poolId,
        stateView,
        position.tickLower,
        position.tickUpper,
        endBlock
      );

      // calculate uncollected fees since last modification up to endBlock
      const { token0Fees: uncollectedFees0, token1Fees: uncollectedFees1 } =
        calculateUncollectedFees(
          position.liquidity,
          positionFinalFeeGrowth.feeGrowthInside0,
          positionFinalFeeGrowth.feeGrowthInside1,
          position.feeGrowthInsideLast0,
          position.feeGrowthInsideLast1
        );

      // add uncollected fees to previously identified collected fees
      const totalFeesThisPeriod0 =
        position.feeGrowthInsidePeriod0 + uncollectedFees0;
      const totalFeesThisPeriod1 =
        position.feeGrowthInsidePeriod1 + uncollectedFees1;

      // owner may have changed; fetch current lp owner as of last block
      const lp = await client.readContract({
        address: positionManager,
        abi: POSITION_MANAGER_ABI,
        functionName: "ownerOf",
        args: [BigInt(key)],
        blockNumber: endBlock,
      });
      // update lpData with uncollected fees (credited to current position owner)
      const currentLpTotal = lpData.get(lp) ?? {
        periodFeesCurrency0: 0n,
        periodFeesCurrency1: 0n,
      };
      lpData.set(lp, {
        periodFeesCurrency0:
          currentLpTotal.periodFeesCurrency0 + uncollectedFees0,
        periodFeesCurrency1:
          currentLpTotal.periodFeesCurrency1 + uncollectedFees1,
      });

      // update position's feeGrowth baseline to the final state for this period
      // liquidity is excluded since it is guaranteed the same after processing all events
      updatePosition(positions, key, {
        lp: lp,
        feeGrowthInsidePeriod0: totalFeesThisPeriod0,
        feeGrowthInsidePeriod1: totalFeesThisPeriod1,
        feeGrowthInsideLast0: positionFinalFeeGrowth.feeGrowthInside0,
        feeGrowthInsideLast1: positionFinalFeeGrowth.feeGrowthInside1,
        lastUpdatedBlock: endBlock,
      });
    } else {
      // liquidity is 0; delete it
      positions.delete(key);
    }
  }

  return { lpData, finalPositions: positions };
}

function calculateUncollectedFees(
  liquidity: bigint,
  feeGrowthInside0Current: bigint,
  feeGrowthInside1Current: bigint,
  feeGrowthInside0Last: bigint,
  feeGrowthInside1Last: bigint
): { token0Fees: bigint; token1Fees: bigint } {
  const Q128 = 2n ** 128n;
  // underflow protection: return 0 if current is less than last
  const feeGrowthDelta0 =
    feeGrowthInside0Current >= feeGrowthInside0Last
      ? feeGrowthInside0Current - feeGrowthInside0Last
      : 0n;
  const feeGrowthDelta1 =
    feeGrowthInside1Current >= feeGrowthInside1Last
      ? feeGrowthInside1Current - feeGrowthInside1Last
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
  positions: Map<string, PositionState>,
  key: string,
  updates: {
    lp?: Address;
    poolId?: `0x${string}`;
    tickLower?: number;
    tickUpper?: number;
    liquidity?: bigint;
    feeGrowthInsidePeriod0?: bigint;
    feeGrowthInsidePeriod1?: bigint;
    feeGrowthInsideLast0?: bigint;
    feeGrowthInsideLast1?: bigint;
    lastUpdatedBlock?: bigint;
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
      !updates.lp ||
      !updates.poolId ||
      updates.tickLower === undefined ||
      updates.tickUpper === undefined ||
      updates.liquidity === undefined ||
      updates.feeGrowthInsidePeriod0 === undefined ||
      updates.feeGrowthInsidePeriod1 === undefined ||
      updates.feeGrowthInsideLast0 === undefined ||
      updates.feeGrowthInsideLast1 === undefined ||
      updates.lastUpdatedBlock === undefined
    ) {
      throw new Error(
        `Cannot create new position ${key}: due to missing required fields.`
      );
    }

    // create new position entry
    positions.set(key, {
      lp: updates.lp,
      tickLower: updates.tickLower,
      tickUpper: updates.tickUpper,
      liquidity: updates.liquidity,
      feeGrowthInsidePeriod0: updates.feeGrowthInsidePeriod0,
      feeGrowthInsidePeriod1: updates.feeGrowthInsidePeriod1,
      feeGrowthInsideLast0: updates.feeGrowthInsideLast0,
      feeGrowthInsideLast1: updates.feeGrowthInsideLast1,
      lastUpdatedBlock: updates.lastUpdatedBlock,
    });
  }
}

/**
 * Updates existing entry at `lpData[key]` with fields provided in `updates`
 */
function modifyLPData(
  lpData: Map<string, LPData>,
  key: string,
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
 * Uses v4 StateView contract to get the fee growth inside a tick range.
 */
async function getFeeGrowthInside(
  client: PublicClient,
  poolId: string,
  stateView: Address,
  tickLower: number,
  tickUpper: number,
  blockNumber: bigint
) {
  const [feeGrowthInside0, feeGrowthInside1] = await client.readContract({
    address: stateView,
    abi: STATE_VIEW_ABI,
    functionName: "getFeeGrowthInside",
    args: [poolId as `0x${string}`, tickLower, tickUpper],
    blockNumber: blockNumber,
  });

  return {
    feeGrowthInside0: feeGrowthInside0,
    feeGrowthInside1: feeGrowthInside1,
  };
}

/**
 * Asserts that a position's stored state matches on-chain data at the end of the analyzed period.
 * Throws an error if any discrepancies are found.
 */
async function verifyPositionCheckpoint(
  key: string,
  position: PositionState,
  client: PublicClient,
  poolId: `0x${string}`,
  endBlock: bigint,
  positionManager: Address,
  stateView: Address
) {
  // ensure `lastUpdatedBlock === endBlock` for all positions
  if (position.lastUpdatedBlock !== endBlock) {
    throw new Error(
      `Position ${key} lastUpdatedBlock ${position.lastUpdatedBlock} does not match endBlock ${endBlock}`
    );
  }
  if (position.liquidity === 0n) {
    throw new Error(
      `Position ${key} has zero liquidity; should have been deleted`
    );
  }
  // ensure position lp corresponds to ownerOf(tokenId)
  const owner = await client.readContract({
    address: positionManager,
    abi: POSITION_MANAGER_ABI,
    functionName: "ownerOf",
    args: [BigInt(key)],
    blockNumber: endBlock,
  });
  if (owner !== position.lp) {
    throw new Error(
      `Discrepancy found for tokenId ${key}: stored LP ${position.lp} vs on-chain owner ${owner}`
    );
  }
  // ensure feeGrowthInside position's tick range was updated with latest on-chain state
  const feeGrowthOnChain = await getFeeGrowthInside(
    client,
    poolId,
    stateView,
    position.tickLower,
    position.tickUpper,
    endBlock
  );
  if (
    feeGrowthOnChain.feeGrowthInside0 !== position.feeGrowthInsideLast0 ||
    feeGrowthOnChain.feeGrowthInside1 !== position.feeGrowthInsideLast1
  ) {
    throw new Error(
      `Discrepancy found for tokenId ${key}: stored feeGrowthInsideLast0/1 (${position.feeGrowthInsideLast0}, ${position.feeGrowthInsideLast1}) vs on-chain (${feeGrowthOnChain.feeGrowthInside0}, ${feeGrowthOnChain.feeGrowthInside1})`
    );
  }
}

// Sums token0 and token1 amounts into a value denominated in a single currency based on current tick price
async function denominateTokenAmountsInTEL( //todo rename
  lpData: Map<string, LPData>,
  denominator: Address,
  stateView: Address,
  positionManager: Address,
  poolId: `0x${string}`,
  client: PublicClient,
  blockNumber: bigint
): Promise<Map<string, LPData>> {
  // the position manager uses only the first 25 bytes of the poolId
  const [currency0, currency1] = await client.readContract({
    address: positionManager,
    abi: POSITION_MANAGER_ABI,
    functionName: "poolKeys",
    args: [poolId.slice(0, 52) as `0x${string}`],
  });

  // Identify whether TEL is token0 or token1
  const telIsCurrency0 = getAddress(currency0) === denominator;
  const telIsCurrency1 = currency1 === denominator;
  if (!telIsCurrency0 && !telIsCurrency1) {
    throw new Error("TEL token not found in pool");
  }

  // fetch price; uniswap uses token1/token0 convention + incorporates decimal difference
  const [sqrtPriceX96] = await client.readContract({
    address: stateView,
    abi: STATE_VIEW_ABI,
    functionName: "getSlot0",
    args: [poolId],
    blockNumber: blockNumber,
  });

  const Q96 = 2n ** 96n;
  // denominate both token amounts into TEL and sum;
  for (const [lpAddress, fees] of lpData) {
    let totalFeesInTEL: bigint;

    if (telIsCurrency0) {
      // periodFeesCurrency0 is already in TEL; convert periodFeesCurrency1 to TEL
      const scaledFees1 = fees.periodFeesCurrency1 * PRECISION;
      // Price from tick represents token1/token0, ie nonTEL/TEL: `amount0 = amount1 * Q96^2 / sqrtPriceX96^2`
      const nonTelAmountInTEL =
        (scaledFees1 * Q96 * Q96) / (sqrtPriceX96 * sqrtPriceX96);

      totalFeesInTEL = fees.periodFeesCurrency0 + nonTelAmountInTEL / PRECISION;
    } else {
      // TEL is currency1; periodFeesCurrency1 is already in TEL, so convert periodFeesCurrency0 to TEL
      const scaledFees0 = fees.periodFeesCurrency0 * PRECISION;
      // price is TEL/nonTEL; `amount1 = (amount0 * sqrtPriceX96^2) / Q96^2`
      const nonTelAmount =
        (scaledFees0 * sqrtPriceX96 * sqrtPriceX96) / (Q96 * Q96);
      const nonTelAmountInTEL = nonTelAmount / PRECISION;

      totalFeesInTEL = fees.periodFeesCurrency1 + nonTelAmountInTEL;
    }

    modifyLPData(lpData, lpAddress, {
      totalFeesTELDenominated: totalFeesInTEL,
    });
  }

  return lpData;
}

// allocates each LP the amount proportional to their share of the total reward amount
function calculateRewardDistribution(
  lpData: Map<string, LPData>,
  rewardAmount: bigint
): Map<string, LPData> {
  const totalFees = Array.from(lpData.values())
    .map((data) => data.totalFeesTELDenominated!)
    .reduce((a, b) => a + b, 0n);
  if (totalFees === 0n) return new Map();

  // calculate each LP's share of rewards
  for (const [lpAddress, lpFees] of lpData) {
    // identify proportional reward: (lpFeesTELDenominated / totalFees) * rewardAmount
    const scaledShare =
      (lpFees.totalFeesTELDenominated! * PRECISION) / totalFees;
    const lpReward = (scaledShare * rewardAmount) / PRECISION;

    modifyLPData(lpData, lpAddress, { reward: lpReward });
  }

  return lpData;
}

/**
 * Misc utility to find the block a pool was created at, which is useful for
 * identifying the INITIALIZE_BLOCK constant needed for first runs to build position state
 * ie:
 *   await getPoolCreationBlock(
 *     client,
 *     POOL_MANAGER_ADDRESS,
 *     POOL_ID as `0x${string}`,
 *     FROM_BLOCK,
 *     TO_BLOCK
 *   ).then((res) => console.log(res));
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
  const initEvent = events[0];

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

main();

function setConfig(poolId_: `0x${string}`, period: number) {
  const POOLS = [BASE_ETH_TEL, POLYGON_ETH_TEL, POLYGON_USDC_EMXN];
  const pool = POOLS.find((p) => p.poolId === poolId_);
  if (!pool) throw new Error("Unrecognized pool ID");

  const { network, denominator } = pool;
  const { poolManager, positionManager, stateView, rpcEnv } = NETWORKS[network];
  const rpcUrl =
    process.env[rpcEnv] ??
    (() => {
      throw new Error(`${rpcEnv} environment variable is not set`);
    })();

  const { reward, start, end } = buildPeriodConfig(pool, period);

  return {
    network,
    rpcUrl,
    poolId: pool.poolId,
    poolManager,
    positionManager,
    stateView,
    denominator,
    rewardAmount: reward,
    startBlock: start,
    endBlock: end,
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
  if (isNaN(period) || period < 0 || period > 4) {
    throw new Error("Invalid period, must be 0–4");
  }
  return [poolId as `0x${string}`, period];
}

function buildPeriodConfig(pool: PoolConfig, period: number) {
  const networkCfg = NETWORKS[pool.network];
  if (period === 0) {
    return {
      reward: INITIALIZE_REWARD_AMOUNT,
      start: pool.initializeBlock,
      end: networkCfg.periodStarts[0],
    };
  }

  const index = period - 1;
  const start = networkCfg.periodStarts[index];
  const end = networkCfg.periodStarts[index + 1] - 1n;
  const reward =
    period === 1 ? pool.rewardAmounts.FIRST : pool.rewardAmounts.PERIOD;

  return { reward, start, end };
}
