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
dotenv.config();

/// usage: `yarn ts-node backend/calculators/TELxRewardsCalculator.ts`
const CHECKPOINT_FILE = "./checkpoint.json";

// BASE — WETH/TEL
const rpcUrl =
  process.env.BASE_RPC_URL ||
  (() => {
    throw new Error("BASE_RPC_URL environment variable is not set");
  })();
const POOL_MANAGER_ADDRESS: Address =
  "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const POSITION_MANAGER_ADDRESS: Address =
  "0x7C5f5A4bBd8fD63184577525326123B519429bDc";
const STATE_VIEW_ADDRESS: Address =
  "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71";
const POOL_ID =
  "0xb6d004fca4f9a34197862176485c45ceab7117c86f07422d1fe3d9cfd6e9d1da";
const INITIALIZE_BLOCK = 25_832_462n;
const PROGRAM_START = 33_954_126n; // aug 9
const FIRST_PERIOD_END = 34_429_326n; // aug 20
const SECOND_PERIOD_END = 34_731_726n; // aug 27
const THIRD_PERIOD_END = 35_034_126n; // sep 3

// //  POLYGON — WETH/TEL
// const rpcUrl =
//   process.env.POLYGON_RPC_URL ||
//   (() => {
//     throw new Error("POLYGON_RPC_URL environment variable is not set");
//   })();
// const POOL_MANAGER_ADDRESS = "0x67366782805870060151383f4bbff9dab53e5cd6";
// const POSITION_MANAGER_ADDRESS = "0x1Ec2eBf4F37E7363FDfe3551602425af0B3ceef9";
// const STATE_VIEW_ADDRESS: Address = "0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a"
// const POOL_ID = "0x9a005a0c12cc2ef01b34e9a7f3fb91a0e6304d377b5479bd3f08f8c29cdf5deb";
// const FROM_BLOCK = 74_970_501n;
// const TO_BLOCK = 75_417_060n;
// const SEED_PATH = "seeds/positions_seed_polygon_weth_tel.json";

// // POLYGON — USDC/eMXN
// const rpcUrl =
//   process.env.POLYGON_RPC_URL ||
//   (() => {
//     throw new Error("POLYGON_RPC_URL environment variable is not set");
//   })();
// const POOL_MANAGER_ADDRESS = "0x67366782805870060151383f4bbff9dab53e5cd6";
// const POSITION_MANAGER_ADDRESS = "0x1Ec2eBf4F37E7363FDfe3551602425af0B3ceef9";
// const STATE_VIEW_ADDRESS: Address = "0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a"
// const POOL_ID = "0xfd56605f7f4620ab44dfc0860d70b9bd1d1f648a5a74558491b39e816a10b99a";
// const FROM_BLOCK = 74_970_501n;
// const TO_BLOCK = 75_417_060n;
// const SEED_PATH = "seeds/positions_seed_polygon_usdc_emxn.json";

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
]);

interface PositionState {
  lp: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  // The fee growth inside the range, as of the last modification event
  feeGrowthInsideLast0: bigint;
  feeGrowthInsideLast1: bigint;
}

interface LPFees {
  totalFees0: bigint;
  totalFees1: bigint;
}

interface CheckpointData {
  lastProcessedBlock: string;
  positions: [string, PositionState][];
}

async function main() {
  const client = createPublicClient({ transport: http(rpcUrl) });

  // for finding the initialize block
  //   await getPoolCreationBlock(
  //     client,
  //     POOL_MANAGER_ADDRESS,
  //     POOL_ID as `0x${string}`,
  //     FROM_BLOCK,
  //     TO_BLOCK
  //   ).then((res) => console.log(res));

  // SET RANGE HERE
  let startBlock = INITIALIZE_BLOCK;
  let endBlock = PROGRAM_START;

  await updateFeesAndPositions(POOL_ID, startBlock, endBlock, client).then(
    (res) => console.log(res)
  );
}

async function updateFeesAndPositions(
  poolId: string,
  startBlock: bigint,
  currentBlock: bigint,
  client: PublicClient
): Promise<{}> {
  let initialPositions = new Map<string, PositionState>();

  // 1. Load state from checkpoint json if it exists
  if (existsSync(CHECKPOINT_FILE)) {
    console.log("Checkpoint file found, loading previous state...");
    const fileContent = await readFile(CHECKPOINT_FILE, "utf-8");
    const checkpoint: CheckpointData = JSON.parse(fileContent, (key, value) =>
      typeof value === "string" && /^\d+n$/.test(value)
        ? BigInt(value.slice(0, -1))
        : value
    );
    startBlock = BigInt(checkpoint.lastProcessedBlock) + 1n;
    initialPositions = new Map(checkpoint.positions);
  } else {
    console.log("No checkpoint file found, starting from pool creation block.");
  }

  if (startBlock > currentBlock) {
    console.error("Already up to date. No new blocks to process.");
    throw new Error("No new blocks to process");
  }

  console.log(`Analyzing fees from block ${startBlock} to ${currentBlock}...`);

  // 2. Run the core analysis logic
  const { lpFees, finalPositions } = await fetchLPFees(
    poolId,
    startBlock,
    currentBlock,
    client,
    initialPositions
  );

  //todo remove to save to checkpoints file once working properly
  //todo forward positions checkpoints file to telx council to check position info is accurate
  //todo derive rewards from lpFees
  //todo write rewards and lpFees to a separate file for publishing
  return { lpFees, finalPositions };

  // 3. Save the new state to the checkpoint file
  const newCheckpoint: CheckpointData = {
    lastProcessedBlock: currentBlock.toString(),
    positions: Array.from(finalPositions.entries()),
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
  console.log("LP Fees Earned in Period:", lpFees);
  return { lpFees, finalPositions };
}

/**
 * Identifies cumulative fee totals for each liquidity provider
 * @return lpFees Map of `tokenId => PositionState` tracking state of each unique position
 * @return finalPositions Map of `LP => LPFees` tracking total fees per LP
 */
async function fetchLPFees(
  poolId: string,
  startBlock: bigint,
  endBlock: bigint,
  client: PublicClient,
  initialPositions: Map<string, PositionState>
): Promise<{
  lpFees: Map<string, LPFees>;
  finalPositions: Map<string, PositionState>;
}> {
  const lpFees = new Map<string, LPFees>();
  // use copy of initial positions fetched from checkpoint file
  const positions = new Map<string, PositionState>(initialPositions);

  // 1. Fetch all ModifyPosition events in the new range
  const logs = await client.getLogs({
    address: POOL_MANAGER_ADDRESS,
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
      // Check if this position was modified during the log period
      const wasModified = logs.some(
        (log) => `${hexToBigInt(log.args.salt!).toString()}` === key
      );
      if (!wasModified) {
        // If not modified, calculate its fees over the whole period and update its feeGrowth baseline
        const feeGrowthAtStart = await getFeeGrowthInside(
          client,
          poolId,
          position.tickLower,
          position.tickUpper,
          startBlock - 1n
        );
        const feeGrowthAtEnd = await getFeeGrowthInside(
          client,
          poolId,
          position.tickLower,
          position.tickUpper,
          endBlock
        );
        const feesEarned0 =
          ((feeGrowthAtEnd.feeGrowthInside0 -
            feeGrowthAtStart.feeGrowthInside0) *
            position.liquidity) /
          2n ** 128n;
        const feesEarned1 =
          ((feeGrowthAtEnd.feeGrowthInside1 -
            feeGrowthAtStart.feeGrowthInside1) *
            position.liquidity) /
          2n ** 128n;
        const currentLpTotal = lpFees.get(position.lp) ?? {
          totalFees0: 0n,
          totalFees1: 0n,
        };
        lpFees.set(position.lp, {
          totalFees0: currentLpTotal.totalFees0 + feesEarned0,
          totalFees1: currentLpTotal.totalFees1 + feesEarned1,
        });
        position.feeGrowthInsideLast0 = feeGrowthAtEnd.feeGrowthInside0;
        position.feeGrowthInsideLast1 = feeGrowthAtEnd.feeGrowthInside1;
      }
    }
  }

  // 3. Process ModifyLiquidity events chronologically
  for (const log of logs) {
    if (!log.args || !log.blockNumber) continue;
    const { tickLower, tickUpper, liquidityDelta, salt } = log.args;
    const tokenId = hexToBigInt(salt!);
    if (!tokenId) throw new Error("Missing tokenId in event args");
    const lp = await client.readContract({
      address: POSITION_MANAGER_ADDRESS,
      abi: POSITION_MANAGER_ABI,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber: log.blockNumber,
    });

    // If position existed, its liquidity was active since last update; calculate period's fees
    const currentPositionState = positions.get(tokenId.toString());
    if (currentPositionState && currentPositionState.liquidity > 0) {
      // fetch state just BEFORE this event
      const feeGrowthInsideNow = await getFeeGrowthInside(
        client,
        poolId,
        currentPositionState.tickLower,
        currentPositionState.tickUpper,
        log.blockNumber - 1n
      );
      const feesEarned0 =
        ((feeGrowthInsideNow.feeGrowthInside0 -
          currentPositionState.feeGrowthInsideLast0) *
          currentPositionState.liquidity) /
        2n ** 128n;
      const feesEarned1 =
        ((feeGrowthInsideNow.feeGrowthInside1 -
          currentPositionState.feeGrowthInsideLast1) *
          currentPositionState.liquidity) /
        2n ** 128n;
      // Add these "collected" fees to the LP's total
      const currentLpTotal = lpFees.get(lp) ?? {
        totalFees0: 0n,
        totalFees1: 0n,
      };
      lpFees.set(lp, {
        totalFees0: currentLpTotal.totalFees0 + feesEarned0,
        totalFees1: currentLpTotal.totalFees1 + feesEarned1,
      });
    }

    // update the position's state for the *next* iteration
    const newLiquidity =
      (currentPositionState?.liquidity ?? 0n) + liquidityDelta!;

    // The `feeGrowthInside` values are updated to the state at the block of the current event.
    // This becomes the new baseline for the next fee calculation period.
    const feeGrowthInsideAtEvent = await getFeeGrowthInside(
      client,
      poolId,
      tickLower!,
      tickUpper!,
      log.blockNumber
    );
    positions.set(tokenId.toString(), {
      lp: lp,
      poolId: poolId,
      tickLower: tickLower!,
      tickUpper: tickUpper!,
      liquidity: newLiquidity,
      feeGrowthInsideLast0: feeGrowthInsideAtEvent.feeGrowthInside0,
      feeGrowthInsideLast1: feeGrowthInsideAtEvent.feeGrowthInside1,
    });
  }

  // 3. Calculate final "uncollected" fees for all remaining positions
  for (const [key, position] of positions.entries()) {
    if (position.liquidity > 0) {
      const positionFinalFeeGrowth = await getFeeGrowthInside(
        client,
        poolId,
        position.tickLower,
        position.tickUpper,
        endBlock
      );

      const uncollectedFees0 =
        ((positionFinalFeeGrowth.feeGrowthInside0 -
          position.feeGrowthInsideLast0) *
          position.liquidity) /
        2n ** 128n;
      const uncollectedFees1 =
        ((positionFinalFeeGrowth.feeGrowthInside1 -
          position.feeGrowthInsideLast1) *
          position.liquidity) /
        2n ** 128n;

      const currentLpTotal = lpFees.get(position.lp) ?? {
        totalFees0: 0n,
        totalFees1: 0n,
      };
      lpFees.set(position.lp, {
        totalFees0: currentLpTotal.totalFees0 + uncollectedFees0,
        totalFees1: currentLpTotal.totalFees1 + uncollectedFees1,
      });
    }
  }

  // This script now only calculates fees earned *during the specified block range*.
  // The total cumulative fee is implicitly stored by not resetting lpFees between runs
  return { lpFees, finalPositions: positions };
}

/**
 * PositionInfoLibrary logic replicated offchain to decode packed `uint256 positionInfo`
 * @param info The packed bigint/uint256 value.
 * @returns An object with the decoded `(bytes25 poolId), int24 tickLower, int24 tickUpper`
 */
function unpackPositionInfo(info: bigint): {
  poolId: string;
  tickLower: number;
  tickUpper: number;
} {
  const TICK_LOWER_OFFSET = 8n;
  const TICK_UPPER_OFFSET = 32n;
  const POOL_ID_OFFSET = 56n;

  const MASK_24_BITS = 0xffffffn;
  const SIGN_BIT_24 = 0x800000n;
  const MAX_UINT_24 = 0x1000000n;

  // Extract tickLower (int24)
  let tickLowerRaw = (info >> TICK_LOWER_OFFSET) & MASK_24_BITS;
  if ((tickLowerRaw & SIGN_BIT_24) !== 0n) {
    tickLowerRaw -= MAX_UINT_24;
  }

  // Extract tickUpper (int24)
  let tickUpperRaw = (info >> TICK_UPPER_OFFSET) & MASK_24_BITS;
  if ((tickUpperRaw & SIGN_BIT_24) !== 0n) {
    tickUpperRaw -= MAX_UINT_24;
  }

  // Extract poolId (bytes25)
  // The poolId is in the upper 200 bits. We just need to shift right.
  const poolIdBigInt = info >> POOL_ID_OFFSET;
  const poolIdHex = poolIdBigInt.toString(16).padStart(50, "0");

  return {
    poolId: `0x${poolIdHex}`,
    tickLower: Number(tickLowerRaw),
    tickUpper: Number(tickUpperRaw),
  };
}

/**
 * Uses v4 StateView contract to get the fee growth inside a tick range.
 */
async function getFeeGrowthInside(
  client: PublicClient,
  poolId: string,
  tickLower: number,
  tickUpper: number,
  blockNumber: bigint
) {
  if (blockNumber < INITIALIZE_BLOCK)
    throw new Error("Block too early; provide exact pool creation block");
  const [feeGrowthInside0, feeGrowthInside1] = await client.readContract({
    address: STATE_VIEW_ADDRESS,
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

//todo: delete below once above is verified working
async function fetchLPFeesTransfer(
  poolId: string,
  startBlock: bigint,
  endBlock: bigint,
  client: PublicClient,
  initialPositions: Map<string, PositionState>
): Promise<{
  lpFees: Map<Address, LPFees>;
  finalPositions: Map<string, PositionState>;
}> {
  const lpFees = new Map<Address, LPFees>();
  // use copy of initial positions fetched from checkpoint file
  const positions = new Map<string, PositionState>(initialPositions);

  // 1. Fetch all relevant events (transfers, modifyLiquidities) from the PositionManager
  const transferLogs = await client.getLogs({
    address: POSITION_MANAGER_ADDRESS,
    event: parseAbiItem(
      "event Transfer(address indexed from, address indexed to, uint256 indexed id)"
    ),
    fromBlock: startBlock,
    toBlock: endBlock,
  });
  const modifyLogs = await client.getLogs({
    address: POOL_MANAGER_ADDRESS,
    event: parseAbiItem(
      "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)"
    ),
    args: { id: poolId as `0x${string}` },
    fromBlock: startBlock,
    toBlock: endBlock,
  });

  const allLogs = [...transferLogs, ...modifyLogs].sort((a, b) => {
    if (a.blockNumber === b.blockNumber) {
      return Number(a.logIndex) - Number(b.logIndex);
    }
    return Number(a.blockNumber) - Number(b.blockNumber);
  });

  // 2. Process events chronologically
  for (const log of allLogs) {
    if (!log.args || !log.blockNumber) continue;
    const tokenId = (log.args as any).tokenId
      ? BigInt((log.args as any).tokenId)
      : hexToBigInt((log.args as any).salt);
    if (!tokenId) throw new Error("Missing tokenId in event args");
    let currentPositionState = positions.get(tokenId.toString());

    // Fetch position details if we haven't seen this tokenId before
    if (!currentPositionState) {
      const positionInfo = await client.readContract({
        address: POSITION_MANAGER_ADDRESS,
        abi: POSITION_MANAGER_ABI,
        functionName: "positionInfo",
        args: [tokenId],
        blockNumber: log.blockNumber,
      });

      const posDetails = unpackPositionInfo(positionInfo as bigint);

      // IMPORTANT: poolIds are truncated to 52 chars (0x + 50 hex chars) in packed `positionInfo`
      const poolIdTruncated = poolId.toLowerCase().substring(0, 52); // 0x + 50 chars
      // Only proceed if the position belongs to the pool we're analyzing
      if (posDetails.poolId.toLowerCase() !== poolIdTruncated) continue;

      positions.set(tokenId.toString(), {
        lp: zeroAddress, // placeholder; will be set when processing Transfer event below
        poolId: posDetails.poolId,
        tickLower: posDetails.tickLower,
        tickUpper: posDetails.tickUpper,
        liquidity: 0n, // placeholder: will be set when processing Modifyliquidity event below
        feeGrowthInsideLast0: 0n,
        feeGrowthInsideLast1: 0n,
      });
      currentPositionState = positions.get(tokenId.toString())!;
    }

    // handle event based on its type
    if (log.eventName === "Transfer") {
      // Transfer event: overwrite zero address placeholder with actual LP address
      currentPositionState.lp = (log.args as any).to;
    } else {
      // ModifyLiquidity event: apply fee calculation logic triggered by liquidity change
      if (currentPositionState.liquidity > 0) {
        const feeGrowthInsideNow = await getFeeGrowthInside(
          client,
          currentPositionState.poolId,
          currentPositionState.tickLower,
          currentPositionState.tickUpper,
          log.blockNumber - 1n // fetch state just BEFORE this event
        );
        const feesEarned0 =
          ((feeGrowthInsideNow.feeGrowthInside0 -
            currentPositionState.feeGrowthInsideLast0) *
            currentPositionState.liquidity) /
          2n ** 128n;
        const feesEarned1 =
          ((feeGrowthInsideNow.feeGrowthInside1 -
            currentPositionState.feeGrowthInsideLast1) *
            currentPositionState.liquidity) /
          2n ** 128n;

        // update current lp owner
        const lp = await client.readContract({
          address: POSITION_MANAGER_ADDRESS,
          abi: POSITION_MANAGER_ABI,
          functionName: "ownerOf",
          args: [tokenId],
          blockNumber: log.blockNumber,
        });
        currentPositionState.lp = lp;

        // Add collected fees to the LP's total
        const currentLpTotal = lpFees.get(lp) ?? {
          totalFees0: 0n,
          totalFees1: 0n,
        };
        lpFees.set(lp, {
          totalFees0: currentLpTotal.totalFees0 + feesEarned0,
          totalFees1: currentLpTotal.totalFees1 + feesEarned1,
        });
      }

      const liquidityDelta = BigInt(log.args.liquidityDelta!);
      currentPositionState.liquidity += liquidityDelta;

      const feeGrowthInsideAtEvent = await getFeeGrowthInside(
        client,
        currentPositionState.poolId,
        currentPositionState.tickLower,
        currentPositionState.tickUpper,
        log.blockNumber
      );
      currentPositionState.feeGrowthInsideLast0 =
        feeGrowthInsideAtEvent.feeGrowthInside0;
      currentPositionState.feeGrowthInsideLast1 =
        feeGrowthInsideAtEvent.feeGrowthInside1;
    }
  }

  //todo:
  // After processing events, calculate fees for positions that were not modified in this period
  // This logic is now more complex as we need to ensure we don't double-count
  // For simplicity, this part is omitted but would be needed for full accuracy if many positions are idle.
  // The current script accurately calculates fees for any position that had any interaction (transfer/liquidity change).

  return { lpFees, finalPositions: positions };
}
