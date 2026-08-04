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
 * Builds the one-time `TANIssuanceHistory::backfillCumulativeRewards` payload.
 *
 * A redeployed `TANIssuanceHistory` starts with no reward history, which would reset every wallet's
 * reward cap to its full stake. This script reads each wallet's lifetime cumulative rewards from the
 * predecessor contract, rescales them into the V3 reward token's decimals, and emits Safe UI chunks.
 *
 * Usage:
 *   yarn ts-node backend/buildBackfill.ts --cutover-block <n> [--scan-from <n>] [--skip-onchain-check]
 *
 * The emitted amounts are already rescaled; the contract stores whatever it is given.
 */

/// Legacy TEL carries 2 decimals and TelcoinV3 carries 18, so every carried-over balance scales up.
const LEGACY_TEL_DECIMALS = 2n;
const DECIMAL_RESCALE = 10n ** (18n - LEGACY_TEL_DECIMALS);

/// Matches the chunk size the Safe UI settlement flow already uses.
const CHUNK_SIZE = 300;

/// Addresses per `cumulativeRewardsAtBlockBatched` call. The getter loops, so keep calls modest.
const READ_BATCH_SIZE = 200;

/// Only whole period files count. Reruns duplicate a period and would double count.
const PERIOD_FILE_PATTERN = /^staker_rewards_period_(\d+)\.json$/;

const legacyHistoryAbi = parseAbi([
  "function cumulativeRewardsAtBlockBatched(address[] accounts, uint256 queryBlock) view returns (address[], uint256[])",
  "function lastSettlementBlock() view returns (uint256)",
]);

/// The predecessor plugin emits the pre- and post-credit balances rather than the delta.
const legacyClaimableIncreased = parseAbiItem(
  "event ClaimableIncreased(address indexed account, uint256 oldClaimable, uint256 newClaimable)",
);

type Deployments = {
  TANIssuanceHistory: Address;
  TANIssuancePlugin: Address;
};

type CliArgs = {
  cutoverBlock: bigint;
  scanFrom?: bigint;
  skipOnchainCheck: boolean;
};

async function main() {
  const { cutoverBlock, scanFrom, skipOnchainCheck } = parseCliArgs();

  const deployments = await readDeployments();
  const legacyHistory = getAddress(deployments.TANIssuanceHistory);
  const legacyPlugin = getAddress(deployments.TANIssuancePlugin);

  const client = createPublicClient({
    batch: { multicall: true },
    chain: polygon,
    transport: http(config.rpcUrls[ChainId.Polygon], { batch: true }),
  }) as PublicClient;

  const latestBlock = await client.getBlockNumber();
  if (cutoverBlock > latestBlock) {
    throw new Error(
      `--cutover-block ${cutoverBlock} is ahead of chain head ${latestBlock}`,
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
  //    the plugin's only increaser, so these logs are exactly the TAN recipient set.
  let sumFromLogs: bigint | undefined;
  if (skipOnchainCheck) {
    console.warn(
      "WARNING: --skip-onchain-check passed. The recipient set is not verified against chain logs.",
    );
  } else {
    // the first period's start block is the earliest any settlement can have landed
    const fromBlock = scanFrom ?? earliestStartBlock;
    console.log(
      `Scanning ${legacyPlugin} ClaimableIncreased logs over [${fromBlock}, ${cutoverBlock}]...`,
    );
    const onchain = await readClaimableIncreased(
      client,
      legacyPlugin,
      fromBlock,
      cutoverBlock,
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
  );

  // 4. Reconcile all three sources before emitting anything.
  const sumFromGetter = [...cumulative.values()].reduce((a, b) => a + b, 0n);
  console.log(
    `\nReconciliation (legacy TEL, ${LEGACY_TEL_DECIMALS} decimals):\n` +
      `  period files : ${sumFromFiles}\n` +
      `  onchain logs : ${sumFromLogs ?? "(skipped)"}\n` +
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
    // a zero row is skipped by the contract, so leave it out of the payload entirely
    .filter(([, amount]) => amount > 0n);

  const rescaledTotal = entries.reduce((sum, [, amount]) => sum + amount, 0n);
  console.log(
    `\nBackfilling ${entries.length} accounts, ${rescaledTotal} total (18 decimals).`,
  );

  await writeChunks(entries, cutoverBlock, legacyHistory);
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
 * Collects every account credited on the predecessor plugin, and the total credited.
 *
 * @dev The block range is split adaptively: a range that a provider rejects (log cap or range cap)
 * is halved and retried, so this works across providers without tuning a chunk size.
 */
async function readClaimableIncreased(
  client: PublicClient,
  plugin: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ accounts: Set<Address>; total: bigint }> {
  const accounts = new Set<Address>();
  let total = 0n;

  const scan = async (from: bigint, to: bigint): Promise<void> => {
    try {
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
    } catch (err) {
      if (from >= to) throw err;

      const mid = from + (to - from) / 2n;
      await scan(from, mid);
      await scan(mid + 1n, to);
    }
  };

  await scan(fromBlock, toBlock);
  return { accounts, total };
}

/**
 * Reads each account's lifetime cumulative rewards from the predecessor contract at `queryBlock`.
 */
async function readCumulativeRewards(
  client: PublicClient,
  legacyHistory: Address,
  accounts: Address[],
  queryBlock: bigint,
): Promise<Map<Address, bigint>> {
  const cumulative = new Map<Address, bigint>();

  for (let i = 0; i < accounts.length; i += READ_BATCH_SIZE) {
    const batch = accounts.slice(i, i + READ_BATCH_SIZE);
    const [returnedAccounts, rewards] = await client.readContract({
      address: legacyHistory,
      abi: legacyHistoryAbi,
      functionName: "cumulativeRewardsAtBlockBatched",
      args: [batch, queryBlock],
    });

    returnedAccounts.forEach((account, j) => {
      cumulative.set(getAddress(account), rewards[j]);
    });
  }

  return cumulative;
}

/**
 * Writes the payload as Safe UI chunks, one file per `backfillCumulativeRewards` transaction.
 */
async function writeChunks(
  entries: Array<[Address, bigint]>,
  cutoverBlock: bigint,
  legacyHistory: Address,
) {
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

    const outputFilePath = path.join(
      outputDir,
      `safe_param_backfill_chunk_${i}.json`,
    );
    await fs.writeFile(outputFilePath, JSON.stringify(payload, null, 2));
    console.log(`  chunk ${i} (${chunk.length} accounts) -> ${outputFilePath}`);
  }

  console.log(
    `\nSubmit each chunk to TANIssuanceHistory::backfillCumulativeRewards(address[], uint256[], uint256)\n` +
      `  atBlock: ${cutoverBlock}\n` +
      `  source : ${legacyHistory}\n` +
      `Chunks are order independent and safe to retry; an account that already carries history is skipped.\n` +
      `Once every chunk has landed and been spot checked, call sealBackfill() to close the path.`,
  );
}

async function readDeployments(): Promise<Deployments> {
  const raw = await fs.readFile(
    path.join(__dirname, "..", "deployments", "deployments.json"),
    "utf-8",
  );

  return JSON.parse(raw) as Deployments;
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);

  const readBigInt = (flag: string): bigint | undefined => {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    if (index + 1 >= args.length) {
      throw new Error(`${flag} must be followed by a block number`);
    }

    return BigInt(args[index + 1]);
  };

  const cutoverBlock = readBigInt("--cutover-block");
  if (cutoverBlock === undefined) {
    throw new Error(
      "--cutover-block is required. Use the block the V3 system goes live at; it becomes the " +
        "new contract's lastSettlementBlock and the key every seeded checkpoint is written under.",
    );
  }

  return {
    cutoverBlock,
    scanFrom: readBigInt("--scan-from"),
    skipOnchainCheck: args.includes("--skip-onchain-check"),
  };
}

main().catch((err) => {
  console.error("\nBackfill build failed:", err.message ?? err);
  process.exit(1);
});
