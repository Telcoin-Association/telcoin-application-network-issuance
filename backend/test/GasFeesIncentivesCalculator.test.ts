import { expect } from "chai";
import * as crypto from "crypto";
import {
  Address,
  Block,
  Hash,
  Transaction,
  TransactionReceipt,
  getAddress,
} from "viem";
import { copyByJson, jsonParse, jsonStringify } from "../helpers";
import {
  BaseExecutorRegistry,
  Executor,
} from "../datasources/ExecutorRegistry";
import { BaseBlocksDatabase } from "../datasources/persistent/BlocksDatabase";
import { readFileSync } from "fs";
import { GasFeesIncentivesCalculator } from "../calculators/GasFeesIncentivesCalculator";
import {
  BaseDatabase,
  HasToString,
} from "../datasources/persistent/BaseDatabase";
import { BaseTransactionReceiptsDatabase } from "../datasources/persistent/TransactionReceiptsDatabase";
import { ChainId } from "../config";
import { transactionTemplate } from "./dummydata/transactionTemplate";

const blockTemplate = jsonParse(
  readFileSync(`${__dirname}/dummydata/blockTemplate.json`, "utf8")
) as Block;
const transactionReceiptTemplate = jsonParse(
  readFileSync(`${__dirname}/dummydata/transactionReceiptTemplate.json`, "utf8")
) as TransactionReceipt;

class FakeDb<K extends HasToString, V> extends BaseDatabase<K, V> {
  _store: Map<string, string> = new Map();
  _rpc: Map<K, V> = new Map();

  getFromStore(key: string): Promise<string> {
    if (!this._store.has(key)) {
      throw new Error("Key not found");
    }
    return Promise.resolve(this._store.get(key)!);
  }

  putToStore(key: string, val: string): Promise<void> {
    this._store.set(key, val);
    return Promise.resolve();
  }

  fetchData(key: K): Promise<V> {
    if (!this._rpc.has(key)) {
      throw new Error("Block not found");
    }
    return Promise.resolve(this._rpc.get(key)!);
  }
}

class FakeBlocksDatabase extends BaseBlocksDatabase {
  fakeDb = new FakeDb<bigint, Block>();

  protected getFromStore(key: string): Promise<string> {
    return this.fakeDb.getFromStore(key);
  }
  protected putToStore(key: string, val: string): Promise<void> {
    return this.fakeDb.putToStore(key, val);
  }
  protected fetchData(key: bigint): Promise<Block> {
    return this.fakeDb.fetchData(key);
  }
}

class FakeTransactionReceiptsDatabase extends BaseTransactionReceiptsDatabase {
  fakeDb = new FakeDb<Hash, TransactionReceipt>();

  protected getFromStore(key: string): Promise<string> {
    return this.fakeDb.getFromStore(key);
  }
  protected putToStore(key: string, val: string): Promise<void> {
    return this.fakeDb.putToStore(key, val);
  }
  protected fetchData(key: Hash): Promise<TransactionReceipt> {
    return this.fakeDb.fetchData(key);
  }
}

class FakeExecutorRegistry extends BaseExecutorRegistry {
  setExecutors(executors: Executor[]) {
    super.setExecutors(executors);
  }
}

function randomHex(bytes: number): `0x${string}` {
  return `0x${Array.from(
    crypto.getRandomValues(new Uint8Array(bytes)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

function randomAddress(): Address {
  return getAddress(randomHex(20));
}

function randomHash(): Hash {
  return randomHex(32);
}

function randBigInt(min: bigint, max: bigint): bigint {
  return BigInt(Math.floor(Math.random() * Number(max - min) + Number(min)));
}

async function generateFakeData(
  nDevelopers: number,
  nExecutorsPerDeveloper: number,
  nTransactions: number
) {
  // returning these
  const executorRegistry = new FakeExecutorRegistry();
  const blocksDatabase = new FakeBlocksDatabase(ChainId.Polygon);
  const transactionReceiptsDatabase = new FakeTransactionReceiptsDatabase(
    ChainId.Polygon
  );
  const gasPaidPerDeveloper = new Map<Address, bigint>();

  // generate the fake executors
  const executors: Executor[] = [];
  for (let i = 0; i < nDevelopers; i++) {
    const devName = `developer-${i}`;
    const devAddr = randomAddress();
    for (let j = 0; j < nExecutorsPerDeveloper; j++) {
      executors.push({
        address: randomAddress(),
        developerName: devName,
        developerAddress: devAddr,
      });
    }
  }
  executorRegistry.setExecutors(executors);

  // generate a bunch of fake transactions and transaction receipts
  const transactions: Transaction[] = [];
  const transactionReceipts: TransactionReceipt[] = [];

  for (let i = 0; i < nTransactions; i++) {
    const txHash = randomHash();
    const blockNumber = 1n;
    const tx = copyByJson(transactionTemplate);
    const txReceipt = copyByJson(transactionReceiptTemplate);

    const executor = executors[Math.floor(Math.random() * executors.length)];

    tx.hash = txHash;
    tx.from = executor.address;
    txReceipt.transactionHash = txHash;
    txReceipt.from = executor.address;
    txReceipt.gasUsed = randBigInt(100000n, 1000000n);
    txReceipt.effectiveGasPrice = randBigInt(1000000000n, 10000000000n);

    const prevDevGasPaid =
      gasPaidPerDeveloper.get(executor.developerAddress) ?? 0n;
    gasPaidPerDeveloper.set(
      executor.developerAddress,
      prevDevGasPaid + txReceipt.gasUsed * txReceipt.effectiveGasPrice
    );

    transactions.push(tx);
    transactionReceipts.push(txReceipt);
  }

  const newBlock = copyByJson(blockTemplate);
  newBlock.number = 1n;
  newBlock.transactions = transactions;

  blocksDatabase.fakeDb._rpc.set(1n, newBlock);

  for (const txReceipt of transactionReceipts) {
    transactionReceiptsDatabase.fakeDb._rpc.set(
      txReceipt.transactionHash,
      txReceipt
    );
  }

  return {
    executorRegistry,
    blocksDatabase,
    transactionReceiptsDatabase,
    gasPaidPerDeveloper,
  };
}

describe("GasFeesIncentivesCalculator", () => {
  describe("calculateGasPaidPerDeveloper", () => {
    it("should accurately calculate gas fees paid per developer", async () => {
      const incentivesAmount = 1_000_000n;
      const {
        executorRegistry,
        blocksDatabase,
        transactionReceiptsDatabase,
        gasPaidPerDeveloper,
      } = await generateFakeData(10, 10, 10);
      const calculator = new GasFeesIncentivesCalculator(
        executorRegistry,
        blocksDatabase,
        transactionReceiptsDatabase,
        incentivesAmount,
        1n,
        1n
      );

      const calculatedGasPaidPerDeveloper =
        await calculator.calculateGasPaidPerDeveloper();

      // assert that volPerDeveloper is the same as volumePerDeveloper
      expect(gasPaidPerDeveloper.size).to.equal(
        calculatedGasPaidPerDeveloper.size
      );
      for (const [developer, paid] of calculatedGasPaidPerDeveloper.entries()) {
        expect(gasPaidPerDeveloper.get(developer)).to.equal(paid);
      }
    });
  });
});
