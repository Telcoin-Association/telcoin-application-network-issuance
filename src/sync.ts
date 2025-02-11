// this is a script to periodically sync the local databases with the blockchain

import * as dotenv from "dotenv";
dotenv.config();

import { Address, Transaction } from "viem";
import * as cliProgress from "cli-progress";
import { ChainId, config } from "./config";
import {
  BaseExecutorRegistry,
  LocalFileExecutorRegistry,
} from "./datasources/ExecutorRegistry";
import {
  BaseBlocksDatabase,
  BlocksDatabase,
} from "./datasources/persistent/BlocksDatabase";
import {
  BaseTransactionReceiptsDatabase,
  TransactionReceiptsDatabase,
} from "./datasources/persistent/TransactionReceiptsDatabase";
import { createRpcClient, getSupportedChain } from "./helpers";

async function main() {
  const chainId = getSupportedChain(process.argv[2]);
  const startBlock = parseInt(process.argv[3]);

  if (!startBlock) {
    console.log("Usage: node sync.js <chainId> <startBlock>");
    process.exit(1);
  }

  await syncRecursive(
    new BlocksDatabase(chainId),
    new TransactionReceiptsDatabase(chainId),
    new LocalFileExecutorRegistry(),
    BigInt(startBlock)
  );
}

async function syncRecursive(
  blocksDb: BaseBlocksDatabase,
  transactionReceiptsDb: BaseTransactionReceiptsDatabase,
  executorRegistry: BaseExecutorRegistry,
  startBlock: bigint
) {
  const blocksSynced = await sync(
    blocksDb,
    transactionReceiptsDb,
    executorRegistry,
    startBlock
  );
  setTimeout(
    () =>
      syncRecursive(
        blocksDb,
        transactionReceiptsDb,
        executorRegistry,
        startBlock + blocksSynced
      ),
    config.blocksSyncTimer
  );
}

// returns the number of blocks synced
async function sync(
  blocksDb: BaseBlocksDatabase,
  transactionReceiptsDb: BaseTransactionReceiptsDatabase,
  executorRegistry: BaseExecutorRegistry,
  startBlock: bigint
) {
  try {
    const currentChain = blocksDb.chain;
    const client = createRpcClient(currentChain);

    const latestBlock = await client.getBlockNumber();
    const batchStart = startBlock;
    const batchEnd = latestBlock - config.reorgSafeDepth[currentChain];

    if (batchStart > batchEnd) {
      console.log(
        `No blocks to sync (batchStart: ${batchStart}, batchEnd: ${batchEnd}, latestBlock: ${latestBlock})`
      );
      return 0n;
    }

    await syncBlocks(blocksDb, batchStart, batchEnd);
    await syncTransactionReceipts(
      blocksDb,
      transactionReceiptsDb,
      executorRegistry,
      batchStart,
      batchEnd
    );

    return batchEnd - batchStart + 1n;
  } catch (e) {
    console.error(e);
    return 0n;
  }
}

async function syncBlocks(
  blocksDb: BaseBlocksDatabase,
  batchStart: bigint,
  batchEnd: bigint
) {
  console.log(`Syncing blocks ${batchStart} to ${batchEnd}`);

  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar.start(Number(batchEnd - batchStart + 1n), 0);

  let batch: Promise<any>[] = [];
  for (let blockNumber = batchStart; blockNumber <= batchEnd; blockNumber++) {
    batch.push(blocksDb.getValue(blockNumber));

    if (batch.length > 0 && batch.length % config.blocksSyncBatchSize === 0) {
      await Promise.all(batch);
      batch = [];
      bar.increment(config.blocksSyncBatchSize);
    }
  }

  bar.stop();
}

async function syncTransactionReceipts(
  blocksDb: BaseBlocksDatabase,
  transactionReceiptsDb: BaseTransactionReceiptsDatabase,
  executorRegistry: BaseExecutorRegistry,
  batchStart: bigint,
  batchEnd: bigint
) {
  const executorSet = new Set<Address>(
    executorRegistry.executors.map((e) => e.address)
  );
  const txsPerExecutor = await blocksDb.getTransactionsOfEOASet(
    executorSet,
    batchStart,
    batchEnd
  );
  const txHashes = ([] as Transaction[])
    .concat(...txsPerExecutor.values())
    .map((tx) => tx.hash);

  if (txHashes.length === 0) return;

  console.log(`Syncing ${txHashes.length} transaction receipts`);

  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar.start(txHashes.length, 0);

  for (const txHash of txHashes) {
    await transactionReceiptsDb.getValue(txHash);
    bar.increment();
  }

  bar.stop();
}

main().catch(console.error);
