import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
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
const PROGRAM_START = 33_954_126; // aug 9
const FIRST_PERIOD_END = 34_429_326n; // aug 20
const SECOND_PERIOD_END = 34_731_726n; // aug 27
const THIRD_PERIOD_END = 35_034_126n; // sep 3

const FROM_BLOCK = 25_000_000n;
const TO_BLOCK = 34_429_326n;

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

interface PositionState {
  owner: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  // The fee growth inside the range, as of the last modification event
  feeGrowthInsideLast0: bigint;
  feeGrowthInsideLast1: bigint;
}

// interface LPFees {
//   totalFees0: bigint;
//   totalFees1: bigint;
// }

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

  await fetchLPFees(POOL_ID, INITIALIZE_BLOCK, TO_BLOCK, client).then((res) =>
    console.log(res)
  );
}

//todo: dedicate this function to updating checkpoints only
async function updateCheckpoints(
  rpcUrl: string,
  poolId: string,
  currentBlock: bigint
) {
  let startBlock = INITIALIZE_BLOCK;
  let initialPositions = new Map<string, PositionState>();

  // 1. Load state from checkpoint if it exists
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
    console.log("Already up to date. No new blocks to process.");
    return;
  }

  return; //TODO
  console.log(`Analyzing fees from block ${startBlock} to ${currentBlock}...`);

  //   // 2. Run the core analysis logic
  //   const { lpFees, finalPositions } = await fetchLPFees(
  //     poolId,
  //     startBlock,
  //     currentBlock,
  //     rpcUrl,
  //     initialPositions
  //   );

  //   // 3. Save the new state to the checkpoint file
  //   const newCheckpoint: CheckpointData = {
  //     lastProcessedBlock: currentBlock.toString(),
  //     positions: Array.from(finalPositions.entries()),
  //   };
  //   await writeFile(
  //     CHECKPOINT_FILE,
  //     JSON.stringify(
  //       newCheckpoint,
  //       (key, value) =>
  //         typeof value === "bigint" ? value.toString() + "n" : value,
  //       2
  //     ),
  //     "utf-8"
  //   );

  //   console.log("Analysis complete. New checkpoint saved.");
  //   console.log("LP Fees Earned in Period:", lpFees);
  //   return { lpFees, finalPositions };
}

/**
 * Identifies cumulative fee totals for each liquidity provider
 */
async function fetchLPFees(
  poolId: string,
  startBlock: bigint,
  endBlock: bigint,
  client: PublicClient
) {
  // 1. Fetch all ModifyPosition events in the range
  const logs = await client.getLogs({
    address: POOL_MANAGER_ADDRESS,
    event: POOL_MANAGER_ABI.find(
      (item) => item.type === "event" && item.name === "ModifyLiquidity"
    )!,
    args: { id: poolId as `0x${string}` },
    fromBlock: startBlock,
    toBlock: endBlock,
  });

  // // Sort logs by block number and then log index to ensure chronological processing
  // logs.sort((a, b) => {
  //     if (a.blockNumber === b.blockNumber) {
  //         return Number(a.logIndex) - Number(b.logIndex);
  //     }
  //     return Number(a.blockNumber) - Number(b.blockNumber);
  // });

  // // Map to track the state of each unique position
  // // Key: owner-tickLower-tickUpper
  // const positions = new Map<string, PositionState>();

  // // Map to track total fees per LP
  // // Key: owner address
  // const lpFees = new Map<string, LPFees>();

  // // 2. Process events chronologically
  // for (const log of logs) {
  //     if (!log.args || !log.blockNumber) continue;
  //     const { owner, tickLower, tickUpper, liquidityDelta } = log.args;
  //     const positionKey = `${owner}-${tickLower}-${tickUpper}`;

  //     const currentPositionState = positions.get(positionKey);

  //     // If the position existed, its liquidity was active since its last update.
  //     // We must calculate the fees earned during that period.
  //     if (currentPositionState && currentPositionState.liquidity > 0) {
  //         const feeGrowthInsideNow = await getFeeGrowthInside(
  //             client,
  //             poolId,
  //             currentPositionState.tickLower, // Use state's ticks
  //             currentPositionState.tickUpper,
  //             log.blockNumber - 1n // State just BEFORE this event
  //         );

  //         const feesEarned0 = ((feeGrowthInsideNow.feeGrowthInside0 - currentPositionState.feeGrowthInsideLast0) * currentPositionState.liquidity) / (2n ** 128n);
  //         const feesEarned1 = ((feeGrowthInsideNow.feeGrowthInside1 - currentPositionState.feeGrowthInsideLast1) * currentPositionState.liquidity) / (2n ** 128n);

  //         // Add these "collected" fees to the LP's total
  //         const currentLpTotal = lpFees.get(owner) ?? { totalFees0: 0n, totalFees1: 0n };
  //         lpFees.set(owner, {
  //             totalFees0: currentLpTotal.totalFees0 + feesEarned0,
  //             totalFees1: currentLpTotal.totalFees1 + feesEarned1,
  //         });
  //     }

  //     // 3. Update the position's state for the *next* iteration
  //     const newLiquidity = (currentPositionState?.liquidity ?? 0n) + BigInt(liquidityDelta as number);

  //     // The `feeGrowthInside` values are updated to the state at the block of the current event.
  //     // This becomes the new baseline for the next fee calculation period.
  //     const feeGrowthInsideAtEvent = await getFeeGrowthInside(
  //         client,
  //         poolId,
  //         tickLower,
  //         tickUpper,
  //         log.blockNumber
  //     );

  //     positions.set(positionKey, {
  //         owner: owner as string,
  //         poolId,
  //         tickLower,
  //         tickUpper,
  //         liquidity: newLiquidity,
  //         feeGrowthInsideLast0: feeGrowthInsideAtEvent.feeGrowthInside0,
  //         feeGrowthInsideLast1: feeGrowthInsideAtEvent.feeGrowthInside1,
  //     });
  // }

  // // 4. Calculate final "uncollected" fees for all remaining positions
  // for (const [key, position] of positions.entries()) {
  //     if (position.liquidity > 0) {
  //         const positionFinalFeeGrowth = await getFeeGrowthInside(
  //             client,
  //             poolId,
  //             position.tickLower,
  //             position.tickUpper,
  //             endBlock
  //         );

  //         const uncollectedFees0 = ((positionFinalFeeGrowth.feeGrowthInside0 - position.feeGrowthInsideLast0) * position.liquidity) / (2n ** 128n);
  //         const uncollectedFees1 = ((positionFinalFeeGrowth.feeGrowthInside1 - position.feeGrowthInsideLast1) * position.liquidity) / (2n ** 128n);

  //         const currentLpTotal = lpFees.get(position.owner) ?? { totalFees0: 0n, totalFees1: 0n };
  //         lpFees.set(position.owner, {
  //             totalFees0: currentLpTotal.totalFees0 + uncollectedFees0,
  //             totalFees1: currentLpTotal.totalFees1 + uncollectedFees1,
  //         });
  //     }
}

// return lpFees;
// }

/**
 * Replicates the logic from Uniswap V4's StateLibrary.getFeeGrowthInside
 * to calculate the fee growth within a tick range at a specific block.
 */
// async function getFeeGrowthInside(
//   client: PublicClient,
//   poolId: string,
//   tickLower: number,
//   tickUpper: number,
//   blockNumber: bigint
// ) {
// const [feeGrowthInside0, feeGrowthInside1] = await client.readContract({
//     address: STATE_VIEW_ADDRESS,
//     abi: STATE_VIEW_ABI,
//     functionName: 'getFeeGrowthInside',
//     args: [poolId as `0x${string}`, tickLower, tickUpper],
//     blockNumber: blockNumber,
// });

// return {
//     feeGrowthInside0: feeGrowthInside0,
//     feeGrowthInside1: feeGrowthInside1
// };
// }

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
