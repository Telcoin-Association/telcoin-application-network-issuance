import {
  Address,
  decodeFunctionData,
  zeroAddress,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  Hex,
  parseAbi,
} from "viem";
import { ChainId, config } from "./config";
import { stakingModules } from "./data/stakingModules";
import { tanIssuanceHistories } from "./data/tanIssuanceHistories";

/**
 * Post-migration reward distribution: rewards are calculated and recorded onchain in old-TEL (2 decimal)
 * units and paid out in new TEL (18 decimals) by direct transfer. Old and new TEL are 1:1.
 */

export const OLD_TEL = config.telToken[ChainId.Polygon];
export const NEW_TEL = config.rewardTelToken;
export const OLD_TO_NEW_TEL_SCALE = 10n ** (NEW_TEL.decimals - OLD_TEL.decimals);

export const TAN_SAFE = getAddress("0x8Dcf8d134F22aC625A7aFb39514695801CD705b5");
export const TAN_ISSUANCE_HISTORY = tanIssuanceHistories.find(
  (history) => history.chain === ChainId.Polygon,
)!.address;

export const STAKING_MODULE = stakingModules.find(
  (stakingModule) => stakingModule.chain === ChainId.Polygon,
)!.address;

// set after `script/DeployRecordOnlyPlugin.s.sol` is broadcast; TAN runs refuse to build until then
export const RECORD_ONLY_PLUGIN: Address | null = null;

// upper bounds on a period's payout, independent of the calculators' output
export const TAN_BUDGET = config.incentivesAmounts.stakerIncentivesAmount;

// a fork run of a real period measured ~160k gas per rewardee (record + transfer); 100 keeps a Safe tx near 16M
export const TAN_CHUNK_SIZE = 100;

// `backend/abi/TanIssuanceHistoryAbi.ts` predates the deployed `IssuanceReward[]` signature
export const TanIssuanceHistoryWriteAbi = parseAbi([
  "function increaseClaimableByBatch((address account, uint256 amount)[] rewards, uint256 endBlock)",
  "function setTanIssuancePlugin(address newPlugin)",
]);

export class AccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountingError";
  }
}

/// amounts are in old-TEL units unless stated otherwise
export type RewardEntry = { address: Address; amount: bigint };

export type SafeTx = { to: Address; value: "0"; data: Hex };

export type SafeBatch = { chainId: ChainId; transactions: SafeTx[] };

export type TanAccountingReport = {
  expectedOldTotal: bigint;
  recordedOldTotal: bigint;
  transferredNewTotal: bigint;
  recipients: number;
  oldTotalFormatted: string;
  newTotalFormatted: string;
};

export function toNewTel(oldAmount: bigint): bigint {
  if (oldAmount < 0n) throw new AccountingError(`Negative amount: ${oldAmount}`);
  return oldAmount * OLD_TO_NEW_TEL_SCALE;
}

/// `BigInt()` accepts "", whitespace and hex, and JSON numbers lose precision past 2^53
function parseDecimalString(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new AccountingError(`${label}: expected a decimal string, got ${JSON.stringify(value)}`);
  return BigInt(value);
}

export function parseTanRewards(json: {
  stakerIncentives: { address: Address; reward: bigint | string }[];
  blockRanges: unknown[];
}): RewardEntry[] {
  return json.stakerIncentives
    .map((incentive) => ({
      address: getAddress(incentive.address),
      amount: parseDecimalString(incentive.reward, `reward for ${incentive.address}`),
    }))
    .filter((entry) => entry.amount !== 0n);
}

export function selectPolygonRange(
  blockRanges: { network: string; startBlock: unknown; endBlock: unknown }[],
): { startBlock: bigint; endBlock: bigint } {
  const ranges = blockRanges.filter((range) => range.network === "polygon");
  if (ranges.length !== 1)
    throw new AccountingError(`Expected exactly one polygon block range, found ${ranges.length}`);

  const startBlock = parseDecimalString(ranges[0].startBlock, "polygon startBlock");
  const endBlock = parseDecimalString(ranges[0].endBlock, "polygon endBlock");
  if (startBlock > endBlock)
    throw new AccountingError(`polygon startBlock ${startBlock} is after endBlock ${endBlock}`);
  return { startBlock, endBlock };
}

function assertValidRewards(rewards: RewardEntry[], label: string) {
  const seen = new Set<Address>();
  for (const { address, amount } of rewards) {
    if (address === zeroAddress)
      throw new AccountingError(`${label}: zero address rewardee`);
    if (amount <= 0n)
      throw new AccountingError(`${label}: non-positive reward for ${address}`);
    if (seen.has(address))
      throw new AccountingError(`${label}: duplicate rewardee ${address}`);
    seen.add(address);
  }
}

export function assertWithinBudget(
  label: string,
  rewards: RewardEntry[],
  budget: bigint,
) {
  const total = sum(rewards);
  if (total > budget)
    throw new AccountingError(
      `${label}: total ${total} exceeds budget ${budget} (old TEL units)`,
    );
}

export function parsePeriod(value: string): number {
  if (!/^\d+$/.test(value))
    throw new Error(`Invalid period: ${JSON.stringify(value)}`);
  return Number(value);
}

export function batchFilePrefix(period: number) {
  return `safe_batch_period_${period}_tan_`;
}

/// every earlier TAN batch file of the same period, so a re-run cannot leave stale higher-index chunks
export function batchFilesToRemove(fileNames: string[], period: number): string[] {
  const prefix = batchFilePrefix(period);
  return fileNames.filter((name) => name.startsWith(prefix));
}

/// the chunking `buildTanBatches` uses; chunk indices identify batch files across runs
export function chunkRewards(
  rewards: RewardEntry[],
  size: number = TAN_CHUNK_SIZE,
): RewardEntry[][] {
  const chunks: RewardEntry[][] = [];
  for (let i = 0; i < rewards.length; i += size) {
    chunks.push(rewards.slice(i, i + size));
  }
  return chunks;
}

export type ChunkStatus = "executed" | "pending" | "inconsistent";

/// `deltas` are each rewardee's cumulative rewards recorded at the period's endBlock (only this period writes that key)
export function classifyChunk(
  rewards: RewardEntry[],
  deltas: Map<Address, bigint>,
): ChunkStatus {
  const recorded = rewards.map((r) => deltas.get(r.address) ?? 0n);
  if (recorded.every((delta) => delta === 0n)) return "pending";
  if (rewards.every((r, i) => recorded[i] === r.amount)) return "executed";
  return "inconsistent";
}

function transferTx(entry: RewardEntry): SafeTx {
  return {
    to: NEW_TEL.address,
    value: "0",
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [entry.address, toNewTel(entry.amount)],
    }),
  };
}

function sum(entries: RewardEntry[]): bigint {
  return entries.reduce((acc, entry) => acc + entry.amount, 0n);
}

/// one-time TAN Safe tx: route `increaseClaimableByBatch` through the record-only plugin
export function buildStubSetupBatch(recordOnlyPlugin: Address): SafeBatch {
  return {
    chainId: ChainId.Polygon,
    transactions: [
      {
        to: TAN_ISSUANCE_HISTORY,
        value: "0",
        data: encodeFunctionData({
          abi: TanIssuanceHistoryWriteAbi,
          functionName: "setTanIssuancePlugin",
          args: [recordOnlyPlugin],
        }),
      },
    ],
  };
}

/// each batch records a chunk in old-TEL units and pays the same chunk in new TEL, so every Safe tx is self-consistent
export function buildTanBatches(
  rewards: RewardEntry[],
  endBlock: bigint,
  chunkSize: number = TAN_CHUNK_SIZE,
): SafeBatch[] {
  assertValidRewards(rewards, "TAN");

  return chunkRewards(rewards, chunkSize).map((rewardsChunk) => ({
    chainId: ChainId.Polygon,
    transactions: [
      {
        to: TAN_ISSUANCE_HISTORY,
        value: "0",
        data: encodeFunctionData({
          abi: TanIssuanceHistoryWriteAbi,
          functionName: "increaseClaimableByBatch",
          args: [
            rewardsChunk.map((r) => ({ account: r.address, amount: r.amount })),
            endBlock,
          ],
        }),
      },
      ...rewardsChunk.map(transferTx),
    ],
  }));
}

function decodeTransfer(tx: SafeTx, where: string): RewardEntry {
  if (tx.value !== "0")
    throw new AccountingError(`${where}: non-zero native value`);
  if (getAddress(tx.to) !== NEW_TEL.address)
    throw new AccountingError(`${where}: unexpected target ${tx.to}`);

  const { functionName, args } = decodeFunctionData({
    abi: erc20Abi,
    data: tx.data,
  });
  if (functionName !== "transfer")
    throw new AccountingError(`${where}: expected transfer, got ${functionName}`);

  return { address: getAddress(args[0]), amount: args[1] };
}

/// compares old-TEL entries against new-TEL transfers entry by entry
function assertScaledMatch(
  expectedOld: RewardEntry[],
  actualNew: RewardEntry[],
  where: string,
) {
  if (expectedOld.length !== actualNew.length)
    throw new AccountingError(
      `${where}: ${actualNew.length} transfers for ${expectedOld.length} rewards`,
    );
  expectedOld.forEach((expected, i) => {
    const actual = actualNew[i];
    if (actual.address !== expected.address)
      throw new AccountingError(
        `${where}: transfer ${i} pays ${actual.address}, expected ${expected.address}`,
      );
    if (actual.amount !== toNewTel(expected.amount))
      throw new AccountingError(
        `${where}: ${expected.address} gets ${actual.amount} new TEL, expected ${toNewTel(expected.amount)} (${expected.amount} old TEL)`,
      );
  });
}

function assertFormattedTotalsMatch(oldTotal: bigint, newTotal: bigint) {
  const oldTotalFormatted = formatUnits(oldTotal, Number(OLD_TEL.decimals));
  const newTotalFormatted = formatUnits(newTotal, Number(NEW_TEL.decimals));
  if (oldTotalFormatted !== newTotalFormatted)
    throw new AccountingError(
      `Total mismatch: ${oldTotalFormatted} old TEL vs ${newTotalFormatted} new TEL`,
    );
  return { oldTotalFormatted, newTotalFormatted };
}

/**
 * Decodes every tx in the TAN batches and checks them against the rewards file:
 * - records equal the rewards file exactly, in old-TEL units, at `endBlock`
 * - each batch's new-TEL transfers equal that batch's records × 10^16
 * - totals agree in both units and nothing else is called
 */
export function verifyTanBatches(
  rewards: RewardEntry[],
  endBlock: bigint,
  batches: SafeBatch[],
): TanAccountingReport {
  assertValidRewards(rewards, "TAN");

  const recorded: RewardEntry[] = [];
  let transferredNewTotal = 0n;

  batches.forEach((batch, b) => {
    if (batch.chainId !== ChainId.Polygon)
      throw new AccountingError(`TAN batch ${b}: wrong chain ${batch.chainId}`);

    const batchRecords: RewardEntry[] = [];
    const batchTransfers: RewardEntry[] = [];
    batch.transactions.forEach((tx, t) => {
      const where = `TAN batch ${b} tx ${t}`;
      if (getAddress(tx.to) === TAN_ISSUANCE_HISTORY) {
        if (tx.value !== "0")
          throw new AccountingError(`${where}: non-zero native value`);
        const { functionName, args } = decodeFunctionData({
          abi: TanIssuanceHistoryWriteAbi,
          data: tx.data,
        });
        if (functionName !== "increaseClaimableByBatch")
          throw new AccountingError(`${where}: unexpected ${functionName}`);
        const [records, recordEndBlock] = args;
        if (recordEndBlock !== endBlock)
          throw new AccountingError(
            `${where}: endBlock ${recordEndBlock}, expected ${endBlock}`,
          );
        batchRecords.push(
          ...records.map((r) => ({
            address: getAddress(r.account),
            amount: r.amount,
          })),
        );
      } else {
        batchTransfers.push(decodeTransfer(tx, where));
      }
    });

    assertScaledMatch(batchRecords, batchTransfers, `TAN batch ${b}`);
    recorded.push(...batchRecords);
    transferredNewTotal += sum(batchTransfers);
  });

  if (recorded.length !== rewards.length)
    throw new AccountingError(
      `TAN: ${recorded.length} records for ${rewards.length} rewards`,
    );
  rewards.forEach((expected, i) => {
    const actual = recorded[i];
    if (actual.address !== expected.address || actual.amount !== expected.amount)
      throw new AccountingError(
        `TAN record ${i}: ${actual.address}=${actual.amount}, expected ${expected.address}=${expected.amount}`,
      );
  });

  const expectedOldTotal = sum(rewards);
  const recordedOldTotal = sum(recorded);
  if (transferredNewTotal !== toNewTel(expectedOldTotal))
    throw new AccountingError(
      `TAN: transferred ${transferredNewTotal} new TEL, expected ${toNewTel(expectedOldTotal)}`,
    );

  return {
    expectedOldTotal,
    recordedOldTotal,
    transferredNewTotal,
    recipients: rewards.length,
    ...assertFormattedTotalsMatch(expectedOldTotal, transferredNewTotal),
  };
}

export type SafeTxBuilderJson = {
  version: "1.0";
  chainId: string;
  createdAt: number;
  meta: {
    name: string;
    description: string;
    txBuilderVersion: string;
    createdFromSafeAddress: string;
    createdFromOwnerAddress: string;
  };
  transactions: {
    to: Address;
    value: "0";
    data: Hex;
    contractMethod: null;
    contractInputsValues: null;
  }[];
};

/// file format accepted by the Safe{Wallet} Transaction Builder "drag and drop" import;
/// `createdAt` is fixed so identical inputs give identical bytes and reproducible sha256s
export function toSafeTxBuilderJson(
  batch: SafeBatch,
  meta: {
    name: string;
    description: string;
    safeAddress?: Address;
  },
): SafeTxBuilderJson {
  return {
    version: "1.0",
    chainId: batch.chainId.toString(),
    createdAt: 0,
    meta: {
      name: meta.name,
      description: meta.description,
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: meta.safeAddress ?? "",
      createdFromOwnerAddress: "",
    },
    transactions: batch.transactions.map((tx) => ({
      to: tx.to,
      value: "0",
      data: tx.data,
      contractMethod: null,
      contractInputsValues: null,
    })),
  };
}

/// parses a Transaction Builder file back into a batch, rejecting a chain or Safe other than expected
export function safeBatchFromJson(
  json: SafeTxBuilderJson,
  expected: { chainId: ChainId; safeAddress: Address },
): SafeBatch {
  if (json.chainId !== expected.chainId.toString())
    throw new AccountingError(
      `Batch file chainId ${json.chainId}, expected ${expected.chainId}`,
    );
  if (
    !json.meta.createdFromSafeAddress ||
    getAddress(json.meta.createdFromSafeAddress) !== expected.safeAddress
  )
    throw new AccountingError(
      `Batch file Safe ${json.meta.createdFromSafeAddress || "(none)"}, expected ${expected.safeAddress}`,
    );

  return {
    chainId: expected.chainId,
    transactions: json.transactions.map(({ to, value, data }) => ({
      to,
      value,
      data,
    })),
  };
}
