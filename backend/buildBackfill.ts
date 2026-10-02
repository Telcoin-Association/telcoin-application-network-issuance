import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs/promises";
import * as path from "path";
import {
  Address,
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  PublicClient,
} from "viem";
import { polygon } from "viem/chains";
import { ChainId, config } from "./config";
import { IncentivesJson } from "./safeTxArrayBuilder";

/**
 * Builds and verifies the one-time `TANIssuanceHistory::backfillCumulativeRewards` payload.
 *
 * A redeployed `TANIssuanceHistory` starts with no reward history, which would reset every wallet's
 * reward cap to its full stake. This script reads each wallet's lifetime cumulative rewards from the
 * predecessor contract, rescales them into the V3 reward token's decimals, and emits Safe chunks plus
 * a manifest the Safe operations script checks every chunk against.
 *
 * Usage:
 *   yarn ts-node backend/buildBackfill.ts [--cutover-block <n>] [--scan-from <n>] [--skip-onchain-check]
 *   yarn ts-node backend/buildBackfill.ts --verify --new-history <address>
 *
 * The cutover block is the predecessor's own `lastSettlementBlock`. The backfill keys every seed there
 * and the new history's first period starts one block later, so periods stay contiguous across the
 * cutover. `--cutover-block` is only a cross-check and must equal it.
 *
 * Build after the predecessor has settled its last period and been removed as its plugin's increaser,
 * so nothing can change the values read here. `--verify` re-reads both contracts after the chunks
 * land and must pass before `sealBackfill`.
 *
 * The predecessor book is `deployments/deployments.json`, which is frozen for this purpose.
 */

/// Legacy TEL carries 2 decimals and TelcoinV3 carries 18, so every carried-over balance scales up.
const LEGACY_TEL_DECIMALS = 2n;
const DECIMAL_RESCALE = 10n ** (18n - LEGACY_TEL_DECIMALS);

/// A backfill chunk of 300 new accounts costs about 14.4M gas, well inside Polygon's 32M cap.
const CHUNK_SIZE = 300;

/// Addresses per `cumulativeRewardsAtBlockBatched` call. The getter loops, so keep calls modest.
const READ_BATCH_SIZE = 200;

/// Only whole period files count. Reruns duplicate a period and would double count.
const PERIOD_FILE_PATTERN = /^staker_rewards_period_(\d+)\.json$/;

const MANIFEST_FILE = "safe_param_backfill_manifest.json";

const historyAbi = parseAbi([
  "function cumulativeRewardsAtBlockBatched(address[] accounts, uint256 queryBlock) view returns (address[], uint256[])",
  "function lastSettlementBlock() view returns (uint256)",
]);

const newHistoryAbi = parseAbi([
  "function backfillBlock() view returns (uint256)",
  "function backfillSealed() view returns (bool)",
]);

const legacyPluginAbi = parseAbi([
  "function increaser() view returns (address)",
]);

/// The predecessor plugin emits the pre- and post-credit balances rather than the delta.
const legacyClaimableIncreased = parseAbiItem(
  "event ClaimableIncreased(address indexed account, uint256 oldClaimable, uint256 newClaimable)",
);

const cumulativeRewardsBackfilled = parseAbiItem(
  "event CumulativeRewardsBackfilled(address indexed account, uint256 amount, uint256 atBlock)",
);

type Deployments = {
  TANIssuanceHistory: Address;
  TANIssuancePlugin: Address;
};

/** Written alongside the chunks; `TANIssuanceSafeOps.backfillChunk` refuses a chunk it does not match. */
type Manifest = {
  atBlock: string;
  snapshotBlock: string;
  source: Address;
  predecessorFrozen: boolean;
  totalAmount: string;
  chunks: Array<{ file: string; accounts: number; total: string }>;
};

type CliArgs =
  | {
      mode: "build";
      cutoverBlock?: bigint;
      scanFrom?: bigint;
      skipOnchainCheck: boolean;
    }
  | { mode: "verify"; newHistory: Address };

async function main() {
  const args = parseCliArgs();

  const deployments = await readDeployments();
  const legacyHistory = getAddress(deployments.TANIssuanceHistory);
  const legacyPlugin = getAddress(deployments.TANIssuancePlugin);

  const client = createPublicClient({
    batch: { multicall: true },
    chain: polygon,
    transport: http(config.rpcUrls[ChainId.Polygon], { batch: true }),
  }) as PublicClient;

  if (args.mode === "verify") {
    await verify(client, legacyHistory, args.newHistory);
    return;
  }

  // Pin every read to one block so a settlement landing mid-run cannot skew the sources apart.
  const snapshotBlock = await client.getBlockNumber();
  const cutoverBlock = await client.readContract({
    address: legacyHistory,
    abi: historyAbi,
    functionName: "lastSettlementBlock",
    blockNumber: snapshotBlock,
  });
  if (args.cutoverBlock !== undefined && args.cutoverBlock !== cutoverBlock) {
    throw new Error(
      `--cutover-block ${args.cutoverBlock} must equal the predecessor's lastSettlementBlock ` +
        `${cutoverBlock}. Any other block either skips fee volume between the two or keys seeds ` +
        `before history the predecessor already settled.`,
    );
  }
  console.log(
    `Cutover block (predecessor lastSettlementBlock): ${cutoverBlock}, snapshot at ${snapshotBlock}`,
  );

  const increaser = await client.readContract({
    address: legacyPlugin,
    abi: legacyPluginAbi,
    functionName: "increaser",
    blockNumber: snapshotBlock,
  });
  const predecessorFrozen = getAddress(increaser) !== legacyHistory;
  if (!predecessorFrozen) {
    console.warn(
      `WARNING: ${legacyHistory} is still the increaser on ${legacyPlugin}, so the predecessor can ` +
        `still settle and change what is read here. Remove it as increaser before building the payload ` +
        `that will be submitted, and run --verify before sealing either way.`,
    );
  }

  // 1. Every wallet that has ever been settled a TAN reward, per the published period files.
  const { recipients, sumFromFiles, periods, earliestStartBlock } =
    await readRecipientsFromFiles();
  console.log(
    `Read ${periods.length} period files (${periods[0]}..${
      periods[periods.length - 1]
    }): ${recipients.size} distinct recipients, ${sumFromFiles} total legacy TEL`,
  );

  // 2. Independent completeness check straight from the chain. The predecessor history contract is
  //    the plugin's only increaser, so these logs are exactly the TAN recipient set. A settlement is
  //    mined after the end block it is keyed at, so the scan runs to the snapshot rather than stopping
  //    at the cutover block.
  let sumFromLogs: bigint | undefined;
  if (args.skipOnchainCheck) {
    console.warn(
      "WARNING: --skip-onchain-check passed. The recipient set is not verified against chain logs.",
    );
  } else {
    // the first period's start block is the earliest any settlement can have landed
    const fromBlock = args.scanFrom ?? earliestStartBlock;
    console.log(
      `Scanning ${legacyPlugin} ClaimableIncreased logs over [${fromBlock}, ${snapshotBlock}]...`,
    );
    const onchain = await readCredits(
      client,
      legacyPlugin,
      fromBlock,
      snapshotBlock,
    );
    sumFromLogs = onchain.total;

    const missing = [...onchain.accounts].filter(
      (account) => !recipients.has(account),
    );
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} account(s) were credited onchain but are absent from the period files, ` +
          `so the backfill would silently drop them. First few: ${missing
            .slice(0, 5)
            .join(", ")}. Widen --scan-from or reconcile the rewards files before proceeding.`,
      );
    }
    console.log(
      `Onchain logs: ${onchain.accounts.size} distinct accounts, ${onchain.total} total legacy TEL`,
    );
  }

  // 3. Authoritative per-account values, read from the predecessor's own getter at the cutover.
  const accounts = [...recipients].sort();
  const cumulative = await readCumulativeRewards(
    client,
    legacyHistory,
    accounts,
    cutoverBlock,
    snapshotBlock,
  );

  // 4. Reconcile all three sources before emitting anything.
  const sumFromGetter = [...cumulative.values()].reduce((a, b) => a + b, 0n);
  console.log(
    `\nReconciliation (legacy TEL, ${LEGACY_TEL_DECIMALS} decimals):\n` +
      `  period files  : ${sumFromFiles}\n` +
      `  onchain logs  : ${sumFromLogs ?? "(skipped)"}\n` +
      `  history getter: ${sumFromGetter}`,
  );
  if (sumFromGetter !== sumFromFiles) {
    throw new Error(
      `Reconciliation failed: the predecessor reports ${sumFromGetter} cumulative TEL but the ` +
        `period files sum to ${sumFromFiles}. Resolve before backfilling.`,
    );
  }
  if (sumFromLogs !== undefined && sumFromLogs !== sumFromGetter) {
    throw new Error(
      `Reconciliation failed: onchain credits sum to ${sumFromLogs} but the predecessor reports ` +
        `${sumFromGetter}. Resolve before backfilling.`,
    );
  }
  console.log("All sources agree.");

  // 5. Rescale into the V3 reward token's decimals and emit Safe chunks.
  const entries: Array<[Address, bigint]> = accounts
    .map((account): [Address, bigint] => [
      account,
      (cumulative.get(account) ?? 0n) * DECIMAL_RESCALE,
    ])
    // a fresh history already reads zero for every account, so a zero row would only cost gas
    .filter(([, amount]) => amount > 0n);

  const rescaledTotal = entries.reduce((sum, [, amount]) => sum + amount, 0n);
  console.log(
    `\nBackfilling ${entries.length} accounts, ${rescaledTotal} total (18 decimals).`,
  );

  await writeChunks(entries, {
    atBlock: cutoverBlock.toString(),
    snapshotBlock: snapshotBlock.toString(),
    source: legacyHistory,
    predecessorFrozen,
    totalAmount: rescaledTotal.toString(),
    chunks: [],
  });
}

/**
 * Checks a new history's seeds against the predecessor, account by account. Run after every chunk
 * has landed and before `sealBackfill`, since a sealed seed can no longer be corrected.
 */
async function verify(
  client: PublicClient,
  legacyHistory: Address,
  newHistory: Address,
) {
  const manifest = await readManifest();
  const atBlock = BigInt(manifest.atBlock);
  if (getAddress(manifest.source) !== legacyHistory) {
    throw new Error(
      `The manifest was built from ${manifest.source}, not the predecessor ${legacyHistory}`,
    );
  }

  const [legacyLast, backfillBlock, sealed] = await Promise.all([
    client.readContract({
      address: legacyHistory,
      abi: historyAbi,
      functionName: "lastSettlementBlock",
    }),
    client.readContract({
      address: newHistory,
      abi: newHistoryAbi,
      functionName: "backfillBlock",
    }),
    client.readContract({
      address: newHistory,
      abi: newHistoryAbi,
      functionName: "backfillSealed",
    }),
  ]);

  const failures: string[] = [];
  if (legacyLast !== atBlock) {
    failures.push(
      `the predecessor has settled since the build (lastSettlementBlock ${legacyLast}, built at ${atBlock}); rebuild`,
    );
  }
  if (backfillBlock !== atBlock) {
    failures.push(
      `the new history is keyed at ${backfillBlock}, the manifest at ${atBlock}`,
    );
  }
  if (sealed) {
    console.warn(
      "Note: the new history is already sealed, so any mismatch below is permanent.",
    );
  }

  const { recipients } = await readRecipientsFromFiles();
  const accounts = [...recipients].sort();
  const [legacy, seeded] = await Promise.all([
    readCumulativeRewards(client, legacyHistory, accounts, atBlock),
    readCumulativeRewards(client, newHistory, accounts, atBlock),
  ]);

  let mismatches = 0;
  for (const account of accounts) {
    const expected = (legacy.get(account) ?? 0n) * DECIMAL_RESCALE;
    const actual = seeded.get(account) ?? 0n;
    if (expected !== actual) {
      mismatches++;
      if (mismatches <= 10) {
        failures.push(`${account}: expected ${expected}, seeded ${actual}`);
      }
    }
  }
  if (mismatches > 10) failures.push(`...and ${mismatches - 10} more`);

  // anything seeded outside the recipient set has no predecessor history behind it
  const stray = new Set<Address>();
  const seededLogs = await readSeedEvents(
    client,
    newHistory,
    BigInt(manifest.snapshotBlock),
    await client.getBlockNumber(),
  );
  for (const account of seededLogs) {
    if (!recipients.has(account)) stray.add(account);
  }
  if (stray.size > 0) {
    failures.push(
      `${stray.size} account(s) seeded with no predecessor history, e.g. ${[...stray]
        .slice(0, 5)
        .join(", ")}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `Backfill verification failed:\n  ${failures.join("\n  ")}`,
    );
  }
  console.log(
    `Verified ${accounts.length} accounts on ${newHistory} against ${legacyHistory} at block ${atBlock}. ` +
      `Safe to sealBackfill().`,
  );
}

/**
 * Reads every published period file and returns the union of recipients plus the total settled.
 */
async function readRecipientsFromFiles(): Promise<{
  recipients: Set<Address>;
  sumFromFiles: bigint;
  periods: number[];
  earliestStartBlock: bigint;
}> {
  const rewardsDir = path.join(__dirname, "..", "rewards");
  const files = (await fs.readdir(rewardsDir)).filter((file) =>
    PERIOD_FILE_PATTERN.test(file),
  );
  if (files.length === 0) {
    throw new Error(`No period files found in ${rewardsDir}`);
  }

  const recipients = new Set<Address>();
  const periods: number[] = [];
  let sumFromFiles = 0n;
  let earliestStartBlock: bigint | undefined;

  for (const file of files) {
    periods.push(Number(PERIOD_FILE_PATTERN.exec(file)![1]));

    const raw = await fs.readFile(path.join(rewardsDir, file), "utf-8");
    const parsed = JSON.parse(raw) as IncentivesJson;
    for (const incentive of parsed.stakerIncentives) {
      const reward = BigInt(incentive.reward);
      if (reward === 0n) continue;

      recipients.add(getAddress(incentive.address));
      sumFromFiles += reward;
    }

    for (const range of parsed.blockRanges) {
      if (range.network !== "polygon") continue;

      const startBlock = BigInt(range.startBlock);
      if (earliestStartBlock === undefined || startBlock < earliestStartBlock) {
        earliestStartBlock = startBlock;
      }
    }
  }

  if (earliestStartBlock === undefined) {
    throw new Error(
      "No polygon block range found across the period files, so the log scan floor is unknown. " +
        "Pass --scan-from explicitly.",
    );
  }

  periods.sort((a, b) => a - b);
  return { recipients, sumFromFiles, periods, earliestStartBlock };
}

/**
 * Runs a log query over `[fromBlock, toBlock]`, halving any range a provider rejects (log cap or
 * range cap) and retrying, so this works across providers without tuning a chunk size.
 */
async function scanLogs(
  fromBlock: bigint,
  toBlock: bigint,
  query: (from: bigint, to: bigint) => Promise<void>,
): Promise<void> {
  const scan = async (from: bigint, to: bigint): Promise<void> => {
    try {
      await query(from, to);
    } catch (err) {
      if (from >= to) throw err;

      const mid = from + (to - from) / 2n;
      await scan(from, mid);
      await scan(mid + 1n, to);
    }
  };

  await scan(fromBlock, toBlock);
}

/** Collects every account credited on the predecessor plugin, and the total credited. */
async function readCredits(
  client: PublicClient,
  plugin: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ accounts: Set<Address>; total: bigint }> {
  const accounts = new Set<Address>();
  let total = 0n;

  await scanLogs(fromBlock, toBlock, async (from, to) => {
    const logs = await client.getLogs({
      address: plugin,
      event: legacyClaimableIncreased,
      fromBlock: from,
      toBlock: to,
    });

    for (const log of logs) {
      accounts.add(getAddress(log.args.account!));
      total += log.args.newClaimable! - log.args.oldClaimable!;
    }
  });

  return { accounts, total };
}

/** Collects every account the new history has emitted a backfill seed for. */
async function readSeedEvents(
  client: PublicClient,
  history: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Set<Address>> {
  const accounts = new Set<Address>();

  await scanLogs(fromBlock, toBlock, async (from, to) => {
    const logs = await client.getLogs({
      address: history,
      event: cumulativeRewardsBackfilled,
      fromBlock: from,
      toBlock: to,
    });

    for (const log of logs) accounts.add(getAddress(log.args.account!));
  });

  return accounts;
}

/**
 * Reads each account's lifetime cumulative rewards from a history contract at `queryBlock`, optionally
 * against chain state pinned at `stateBlock`.
 */
async function readCumulativeRewards(
  client: PublicClient,
  history: Address,
  accounts: Address[],
  queryBlock: bigint,
  stateBlock?: bigint,
): Promise<Map<Address, bigint>> {
  const cumulative = new Map<Address, bigint>();

  for (let i = 0; i < accounts.length; i += READ_BATCH_SIZE) {
    const batch = accounts.slice(i, i + READ_BATCH_SIZE);
    const [returnedAccounts, rewards] = await client.readContract({
      address: history,
      abi: historyAbi,
      functionName: "cumulativeRewardsAtBlockBatched",
      args: [batch, queryBlock],
      blockNumber: stateBlock,
    });

    returnedAccounts.forEach((account, j) => {
      cumulative.set(getAddress(account), rewards[j]);
    });
  }

  return cumulative;
}

/**
 * Writes the payload as Safe chunks, one file per `backfillCumulativeRewards` transaction, plus a
 * manifest recording the key block and each chunk's size and total.
 */
async function writeChunks(entries: Array<[Address, bigint]>, manifest: Manifest) {
  const outputDir = path.join(__dirname, "temp");
  await fs.mkdir(outputDir, { recursive: true });

  const chunkCount = Math.ceil(entries.length / CHUNK_SIZE);
  for (let i = 0; i < chunkCount; i++) {
    const chunk = entries.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    // shaped for `backfillCumulativeRewards(address[], uint256[], uint256)`
    const payload = [
      chunk.map(([account]) => account),
      chunk.map(([, amount]) => amount.toString()),
    ];

    const file = `safe_param_backfill_chunk_${i}.json`;
    const outputFilePath = path.join(outputDir, file);
    await fs.writeFile(outputFilePath, JSON.stringify(payload, null, 2));
    console.log(`  chunk ${i} (${chunk.length} accounts) -> ${outputFilePath}`);

    manifest.chunks.push({
      file,
      accounts: chunk.length,
      total: chunk.reduce((sum, [, amount]) => sum + amount, 0n).toString(),
    });
  }

  const manifestPath = path.join(outputDir, MANIFEST_FILE);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`  manifest -> ${manifestPath}`);

  console.log(
    `\nPropose each chunk with TANIssuanceSafeOps.backfillChunk, which reads atBlock from the manifest\n` +
      `  atBlock: ${manifest.atBlock}\n` +
      `  source : ${manifest.source}\n` +
      `Chunks are order independent and safe to retry. Send nothing else to the history until every\n` +
      `chunk has landed: any settlement that credits a non-zero amount seals the backfill for good.\n` +
      `Then run --verify --new-history <address>, and only once it passes, sealBackfill().`,
  );
}

async function readDeployments(): Promise<Deployments> {
  const raw = await fs.readFile(
    path.join(__dirname, "..", "deployments", "deployments.json"),
    "utf-8",
  );

  return JSON.parse(raw) as Deployments;
}

async function readManifest(): Promise<Manifest> {
  const raw = await fs.readFile(
    path.join(__dirname, "temp", MANIFEST_FILE),
    "utf-8",
  );

  return JSON.parse(raw) as Manifest;
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);

  const readValue = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    if (index + 1 >= args.length) {
      throw new Error(`${flag} must be followed by a value`);
    }

    return args[index + 1];
  };
  const readBigInt = (flag: string): bigint | undefined => {
    const value = readValue(flag);
    return value === undefined ? undefined : BigInt(value);
  };

  if (args.includes("--verify")) {
    const newHistory = readValue("--new-history");
    if (newHistory === undefined) {
      throw new Error("--verify requires --new-history <address>");
    }

    return { mode: "verify", newHistory: getAddress(newHistory) };
  }

  return {
    mode: "build",
    cutoverBlock: readBigInt("--cutover-block"),
    scanFrom: readBigInt("--scan-from"),
    skipOnchainCheck: args.includes("--skip-onchain-check"),
  };
}

main().catch((err) => {
  console.error("\nBackfill build failed:", err.message ?? err);
  process.exit(1);
});
