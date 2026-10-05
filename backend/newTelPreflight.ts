import {
  Abi,
  AbiEvent,
  Address,
  erc20Abi,
  formatUnits,
  getAddress,
  Hex,
  parseAbi,
  parseAbiItem,
  PublicClient,
  toFunctionSelector,
} from "viem";
import { StakerIncentivesCalculator } from "./calculators/StakerIncentivesCalculator";
import {
  classifyChunk,
  NEW_TEL,
  OLD_TEL,
  RewardEntry,
  STAKING_MODULE,
  TAN_ISSUANCE_HISTORY,
  TAN_SAFE,
  toNewTel,
} from "./newTelDistribution";

/**
 * Onchain checks run by the batch builder before writing any file. Every read is pinned to one block so
 * the checks see a single consistent state, and all failures are reported together.
 */

export type ContractReader = {
  readContract(args: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown>;
  getLogs(args: {
    address: Address;
    event: AbiEvent;
    args?: { account?: Address[] };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<{ args: unknown; blockNumber: bigint | null }[]>;
};

export class PreflightError extends Error {
  constructor(public readonly failures: string[]) {
    super(`Preflight failed:\n  - ${failures.join("\n  - ")}`);
    this.name = "PreflightError";
  }
}

const historyAbi = parseAbi([
  "function tanIssuancePlugin() view returns (address)",
  "function lastSettlementBlock() view returns (uint256)",
  "function cumulativeRewardsAtBlock(address account, uint256 queryBlock) view returns (uint256)",
]);

const stakingModuleAbi = parseAbi([
  "function stakedByAt(address account, uint256 blockNumber) view returns (uint256)",
]);

const stakeChangedEvent = parseAbiItem(
  "event StakeChanged(address indexed account, uint256 oldStake, uint256 newStake)",
);

const recordOnlyPluginAbi = parseAbi([
  "function tel() view returns (address)",
  "function increaser() view returns (address)",
  "function totalClaimable() view returns (uint256)",
  "function supportsInterface(bytes4) view returns (bool)",
]);

/// `type(ISimplePlugin).interfaceId`
export const ISIMPLE_PLUGIN_INTERFACE_ID = (() => {
  const id = [
    "increaseClaimableBy(address,uint256)",
    "tel()",
    "totalClaimable()",
    "deactivated()",
  ].reduce((acc, sig) => acc ^ parseInt(toFunctionSelector(sig).slice(2), 16), 0);
  return `0x${(id >>> 0).toString(16).padStart(8, "0")}` as Hex;
})();

const fmtNew = (amount: bigint) =>
  formatUnits(amount, Number(NEW_TEL.decimals));

/// collects check outcomes; a reverting read counts as a failed check rather than aborting the run
class Checks {
  readonly passed: string[] = [];
  readonly failed: string[] = [];

  async run(label: string, check: () => Promise<string | null>) {
    try {
      const failure = await check();
      if (failure) this.failed.push(`${label}: ${failure}`);
      else this.passed.push(label);
    } catch (err) {
      const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
      this.failed.push(`${label}: read failed (${reason})`);
    }
  }

  result(): string[] {
    if (this.failed.length > 0) throw new PreflightError(this.failed);
    return this.passed;
  }
}

type Read = <T = unknown>(
  address: Address,
  abi: Abi,
  functionName: string,
  args?: readonly unknown[],
) => Promise<T>;

/// every contract read goes through this, pinned to `atBlock`
function pinnedRead(reader: ContractReader, atBlock: bigint): Read {
  return async <T>(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) =>
    (await reader.readContract({ address, abi, functionName, args, blockNumber: atBlock })) as T;
}

const sameAddress = (a: unknown, b: Address) =>
  typeof a === "string" && getAddress(a) === b;

async function checkNewTel(checks: Checks, read: Read, label: string, safe: Address, required: bigint) {
  await checks.run(`${label} new TEL decimals() == ${NEW_TEL.decimals}`, async () => {
    const decimals = await read<number>(NEW_TEL.address, erc20Abi, "decimals");
    return BigInt(decimals) === NEW_TEL.decimals ? null : `got ${decimals}`;
  });
  await checks.run(`${label} Safe ${safe} new TEL balance >= ${fmtNew(required)}`, async () => {
    const balance = await read<bigint>(NEW_TEL.address, erc20Abi, "balanceOf", [safe]);
    return balance >= required ? null : `has ${fmtNew(balance)}`;
  });
}

async function checkStubWiring(checks: Checks, read: Read, stub: Address) {
  await checks.run(`stub tel() == old TEL ${OLD_TEL.address}`, async () => {
    const tel = await read(stub, recordOnlyPluginAbi, "tel");
    return sameAddress(tel, OLD_TEL.address) ? null : `got ${tel}`;
  });
  await checks.run(`stub increaser() == TANIssuanceHistory ${TAN_ISSUANCE_HISTORY}`, async () => {
    const increaser = await read(stub, recordOnlyPluginAbi, "increaser");
    return sameAddress(increaser, TAN_ISSUANCE_HISTORY) ? null : `got ${increaser}`;
  });
}

/// cumulative rewards recorded for each rewardee at `endBlock`; only this period's settlements write that checkpoint
async function recordedAtEndBlock(
  read: Read,
  rewards: RewardEntry[],
  endBlock: bigint,
): Promise<Map<Address, bigint>> {
  const deltas = await Promise.all(
    rewards.map(async ({ address }) => {
      const [atEnd, before] = await Promise.all([
        read<bigint>(TAN_ISSUANCE_HISTORY, historyAbi, "cumulativeRewardsAtBlock", [address, endBlock]),
        read<bigint>(TAN_ISSUANCE_HISTORY, historyAbi, "cumulativeRewardsAtBlock", [address, endBlock - 1n]),
      ]);
      return [address, atEnd - before] as const;
    }),
  );
  return new Map(deltas);
}

/**
 * The stake each rewardee's cap is computed from, exactly as StakerIncentivesCalculator does it: the
 * time-weighted average over StakeChanged events in the period, falling back to `stakedByAt(endBlock - 1)`
 * when there are none or the average is 0 (`if (existingAverageStake)` in `processAddress`).
 * The calculator's own methods are reused; neither reads instance state.
 */
async function calculatorStakes(
  reader: ContractReader,
  read: Read,
  accounts: Address[],
  startBlock: bigint,
  endBlock: bigint,
): Promise<Map<Address, bigint>> {
  const calculator = StakerIncentivesCalculator.prototype;
  const events = await calculator.fetchStakeChangedEvents(
    reader as unknown as PublicClient,
    STAKING_MODULE,
    stakeChangedEvent,
    { account: accounts },
    startBlock,
    endBlock,
  );
  const averages = await calculator.CalculateAvgStakedAmountsPerAccount(events, startBlock, endBlock);
  const averageOf = new Map(
    Array.from(averages.entries()).map(([account, average]) => [getAddress(account), average]),
  );

  const stakes = await Promise.all(
    accounts.map(async (account) => {
      const average = averageOf.get(account);
      const stake = average
        ? average
        : await read<bigint>(STAKING_MODULE, stakingModuleAbi, "stakedByAt", [account, endBlock - 1n]);
      return [account, stake] as const;
    }),
  );
  return new Map(stakes);
}

export type TanPreflightResult = {
  passed: string[];
  /// indices into `chunks` still to be executed; all of them for a fresh period
  pendingChunks: number[];
};

/**
 * Per-period TAN checks: stub in place, rewards file continues from the last settlement (or the period is
 * partly settled with every recorded chunk matching the file), rewards within each rewardee's stake cap as
 * the calculator computes it, no old TEL in the history, Safe funded for the pending chunks.
 * All reads are pinned to `atBlock`.
 */
export async function preflightTan(
  reader: ContractReader,
  params: {
    startBlock: bigint;
    endBlock: bigint;
    chunks: RewardEntry[][];
    recordOnlyPlugin: Address | null;
    atBlock: bigint;
  },
): Promise<TanPreflightResult> {
  const checks = new Checks();
  const { startBlock, endBlock, chunks, atBlock } = params;
  const read = pinnedRead(reader, atBlock);
  const rewards = chunks.flat();
  const stub = params.recordOnlyPlugin;

  if (atBlock < endBlock)
    checks.failed.push(`pinned block ${atBlock} is before the period's endBlock ${endBlock}`);

  if (!stub) {
    checks.failed.push(
      "RECORD_ONLY_PLUGIN is not set in backend/newTelDistribution.ts (deploy the stub and run --setup-stub first)",
    );
  } else {
    await checks.run(`TANIssuanceHistory.tanIssuancePlugin() == RecordOnlyPlugin ${stub}`, async () => {
      const plugin = await read(TAN_ISSUANCE_HISTORY, historyAbi, "tanIssuancePlugin");
      return sameAddress(plugin, stub) ? null : `got ${plugin}`;
    });
    await checkStubWiring(checks, read, stub);
  }

  let pendingChunks: number[] = [];
  await checks.run(`settlement state matches rewards file blocks ${startBlock}-${endBlock}`, async () => {
    const last = await read<bigint>(TAN_ISSUANCE_HISTORY, historyAbi, "lastSettlementBlock");
    if (last > endBlock)
      return `lastSettlementBlock ${last} is past endBlock ${endBlock}; a later period has already been settled`;
    if (last < endBlock && startBlock !== last + 1n)
      return `rewards file startBlock ${startBlock} != lastSettlementBlock + 1 (${last + 1n}); settle periods in order from the last settlement`;

    // classify every chunk from what is recorded at endBlock, also for a fresh period, where all must be pending
    const deltas = await recordedAtEndBlock(read, rewards, endBlock);
    const statuses = chunks.map((chunk) => classifyChunk(chunk, deltas));
    const notPending = statuses.flatMap((status, i) => (status === "pending" ? [] : [i]));
    if (last < endBlock && notPending.length > 0)
      return `chunk ${notPending.join(", ")} recorded at endBlock although lastSettlementBlock ${last} < endBlock; inconsistent chain view`;
    const inconsistent = statuses.flatMap((status, i) => (status === "inconsistent" ? [i] : []));
    if (inconsistent.length > 0)
      return `recorded amounts at endBlock do not match chunk ${inconsistent.join(", ")} (executed twice, or the rewards file changed after execution)`;
    pendingChunks = statuses.flatMap((status, i) => (status === "pending" ? [i] : []));
    return null;
  });

  await checks.run(`TANIssuanceHistory holds no old TEL`, async () => {
    const balance = await read<bigint>(OLD_TEL.address, erc20Abi, "balanceOf", [TAN_ISSUANCE_HISTORY]);
    return balance === 0n
      ? null
      : `holds ${balance} raw; the original plugin could pull it if ever set back, so rescue it first`;
  });

  if (rewards.length > 0) {
    await checks.run("each rewardee: reward + prior cumulative rewards <= calculator stake (time-weighted average)", async () => {
      const accounts = rewards.map((r) => r.address);
      const stakes = await calculatorStakes(reader, read, accounts, startBlock, endBlock);
      const exceeded: string[] = [];
      await Promise.all(
        rewards.map(async ({ address, amount }) => {
          const prior = await read<bigint>(TAN_ISSUANCE_HISTORY, historyAbi, "cumulativeRewardsAtBlock", [
            address,
            endBlock - 1n,
          ]);
          const stake = stakes.get(address) ?? 0n;
          if (amount + prior > stake)
            exceeded.push(`${address} (reward ${amount} + prior ${prior} > stake ${stake})`);
        }),
      );
      if (exceeded.length === 0) return null;
      return `exceeded for ${exceeded.length}: ${exceeded.slice(0, 5).join("; ")}${exceeded.length > 5 ? "; ..." : ""}`;
    });
  }

  const pendingTotal = pendingChunks.reduce(
    (acc, i) => acc + chunks[i].reduce((chunkAcc, r) => chunkAcc + r.amount, 0n),
    0n,
  );
  await checkNewTel(checks, read, "Polygon", TAN_SAFE, toNewTel(pendingTotal));

  return { passed: checks.result(), pendingChunks };
}

/// one-time setup checks: the target is a correctly wired RecordOnlyPlugin and not already set
export async function preflightStubSetup(
  reader: ContractReader,
  stub: Address,
  atBlock: bigint,
): Promise<string[]> {
  const checks = new Checks();
  const read = pinnedRead(reader, atBlock);

  await checkStubWiring(checks, read, stub);
  await checks.run("stub totalClaimable() == 0", async () => {
    const total = await read<bigint>(stub, recordOnlyPluginAbi, "totalClaimable");
    return total === 0n ? null : `got ${total}`;
  });
  await checks.run("stub supportsInterface(ISimplePlugin)", async () => {
    const supported = await read<boolean>(stub, recordOnlyPluginAbi, "supportsInterface", [
      ISIMPLE_PLUGIN_INTERFACE_ID,
    ]);
    return supported ? null : "returned false";
  });
  await checks.run("TANIssuanceHistory.tanIssuancePlugin() != stub", async () => {
    const plugin = await read(TAN_ISSUANCE_HISTORY, historyAbi, "tanIssuancePlugin");
    return sameAddress(plugin, stub) ? "already set; nothing to do" : null;
  });

  return checks.result();
}
