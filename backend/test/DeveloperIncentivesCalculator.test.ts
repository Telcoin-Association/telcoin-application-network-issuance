import * as crypto from "crypto";
import { Address, Block, Hash, Transaction, getAddress } from "viem";
import { copyByJson, jsonParse, scaleDecimals } from "../helpers";
import {
  BaseExecutorRegistry,
  Executor,
} from "../datasources/ExecutorRegistry";
import { BaseBlocksDatabase } from "../datasources/persistent/BlocksDatabase";
import { readFileSync } from "fs";
import { ChainId, config } from "../config";
import {
  BaseSimplePlugin,
  ClaimableIncreasedEvent,
} from "../datasources/SimplePlugin";
import { DeveloperIncentivesCalculator } from "../calculators/DeveloperIncentivesCalculator";
import { transactionTemplate } from "./dummydata/transactionTemplate";

const blockTemplate = jsonParse(
  readFileSync(`${__dirname}/dummydata/blockTemplate.json`, "utf8")
) as Block;

class FakeBlocksDatabase extends BaseBlocksDatabase {
  _store: Map<string, string> = new Map();
  _rpc: Map<bigint, Block> = new Map();

  protected getFromStore(key: string): Promise<string> {
    if (!this._store.has(key)) {
      throw new Error("Key not found");
    }
    return Promise.resolve(this._store.get(key)!);
  }

  protected putToStore(key: string, val: string): Promise<void> {
    this._store.set(key, val);
    return Promise.resolve();
  }

  protected fetchData(blockNumber: bigint): Promise<Block> {
    if (!this._rpc.has(blockNumber)) {
      throw new Error("Block not found");
    }
    return Promise.resolve(this._rpc.get(blockNumber)!);
  }
}

class FakeExecutorRegistry extends BaseExecutorRegistry {
  setExecutors(executors: Executor[]) {
    super.setExecutors(executors);
  }
}

class FakeSimplePlugin extends BaseSimplePlugin {
  events: ClaimableIncreasedEvent[] = [];
  fetchClaimableIncreasedEvents(): Promise<ClaimableIncreasedEvent[]> {
    return Promise.resolve(copyByJson(this.events));
  }
}

function randomChainId(): ChainId {
  return config.chains[Math.floor(Math.random() * config.chains.length)].id;
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
  nPlugins: number,
  nEventsPerPlugin: number
) {
  // generate fake executor registry
  const executorRegistry = new FakeExecutorRegistry();
  const executors: Executor[] = [];
  for (let i = 0; i < nDevelopers; i++) {
    const developerAddress = randomAddress();
    for (let j = 0; j < nExecutorsPerDeveloper; j++) {
      const executor = randomAddress();
      executors.push({
        developerAddress,
        address: executor,
        developerName: `Developer ${i}`,
      });
    }
  }
  executorRegistry.setExecutors(executors);

  // generate fake blocks dbs (and set a fake block #1 in rpc)
  const blocksDbs: FakeBlocksDatabase[] = [];
  for (const chain of config.chains) {
    const db = new FakeBlocksDatabase(chain.id);

    db._rpc.set(1n, copyByJson(blockTemplate));

    blocksDbs.push(db);
  }

  // generate the fake plugins (with events)
  // also generate developer totals
  const simplePlugins: BaseSimplePlugin[] = [];
  const referralsPerDeveloper = new Map<Address, bigint>();
  for (let i = 0; i < nPlugins; i++) {
    const plugin = new FakeSimplePlugin(randomChainId());
    simplePlugins.push(plugin);

    for (let j = 0; j < nEventsPerPlugin; j++) {
      const oldClaimable = randBigInt(0n, 1000n);
      const newClaimable = oldClaimable + randBigInt(0n, 1000n);
      const event: ClaimableIncreasedEvent = {
        txHash: randomHash(),
        account: randomAddress(),
        oldClaimable,
        newClaimable,
      };
      plugin.events.push(event);

      // pick an executor to assign this event to
      const executor =
        executorRegistry.executors[
          Math.floor(Math.random() * executors.length)
        ];

      // make a fake transaction
      const transaction = copyByJson(transactionTemplate);
      transaction.hash = event.txHash;
      transaction.from = executor.address;

      // add it to the appropriate blocks db
      const blocksDb = blocksDbs.find((db) => db.chain === plugin.chain)!;
      blocksDb._rpc.get(1n)!.transactions.push(transaction as any);

      // add the amount to the developer's total (mind the decimals)
      const developerTotal =
        referralsPerDeveloper.get(executor.developerAddress) ?? 0n;
      referralsPerDeveloper.set(
        executor.developerAddress,
        developerTotal +
          scaleDecimals(
            newClaimable - oldClaimable,
            getTelTokenDecimals(plugin.chain),
            config.canonicalDecimals
          )
      );
    }
  }

  return {
    executorRegistry,
    blocksDbs,
    simplePlugins,
    referralsPerDeveloper,
  };
}

function getTelTokenDecimals(chain: ChainId): bigint {
  const telTokens = config.telToken as Record<number, { decimals: bigint }>;
  const entry = telTokens[chain];
  if (!entry) {
    throw new Error(`TEL token decimals not configured for chain ${chain}`);
  }
  return entry.decimals;
}

describe("DeveloperIncentivesCalculator", () => {
  describe("calculateReferralsPerDeveloper", () => {
    it("should accurately calculate referrals per developer", async () => {
      const {
        executorRegistry,
        blocksDbs,
        simplePlugins,
        referralsPerDeveloper,
      } = await generateFakeData(10, 10, 10, 10);
      const calculator = new DeveloperIncentivesCalculator(
        blocksDbs,
        simplePlugins,
        executorRegistry,
        1_000_000n,
        {
          [ChainId.Polygon]: 1n,
          [ChainId.Mainnet]: 1n,
          [ChainId.Base]: 1n,
        },
        {
          [ChainId.Polygon]: 1n,
          [ChainId.Mainnet]: 1n,
          [ChainId.Base]: 1n,
        }
      );
      const calculatedReferralsPerDeveloper =
        await calculator.calculateReferralsPerDeveloper();
      expect(calculatedReferralsPerDeveloper.size).toBe(
        referralsPerDeveloper.size
      );
      for (const [developer, referrals] of referralsPerDeveloper.entries()) {
        expect(calculatedReferralsPerDeveloper.get(developer)).toBe(referrals);
      }
    });
  });
});
