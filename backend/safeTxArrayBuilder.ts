import { Address, formatUnits, getAddress, isAddress } from "viem";
import * as fs from "fs/promises";
import * as path from "path";
import { createRpcClient, NetworkConfig } from "./helpers";
import { ChainId, config } from "./config";
import { UserMetadata } from "./calculators/ICalculator";
import { PERIODS, POOLS } from "./calculators/TELxRewardsCalculator";
import {
  AccountingError,
  assertWithinBudget,
  buildStubSetupBatch,
  buildTanBatches,
  chunkRewards,
  NEW_TEL,
  OLD_TEL,
  OLD_TO_NEW_TEL_SCALE,
  parsePeriod,
  parseTanRewards,
  RECORD_ONLY_PLUGIN,
  SafeBatch,
  selectPolygonRange,
  TAN_BUDGET,
  TAN_SAFE,
  toSafeTxBuilderJson,
  verifyTanBatches,
} from "./newTelDistribution";
import { BatchFile, reload, render, writeVerified } from "./newTelBatchFiles";
import {
  ContractReader,
  PreflightError,
  preflightStubSetup,
  preflightTan,
} from "./newTelPreflight";

// interface for the incentives output JSON file, eg `staker_incentives.json`
export interface IncentivesJson {
  blockRanges: NetworkConfig[];
  stakerIncentives: StakerIncentive[];
}

// interface for the `address => incentive` map entries (`stakerIncentives`) within an output file
export interface StakerIncentive {
  address: Address;
  reward: bigint;
  metadata?: UserMetadata; // informational; not used for distribution
}

// TELx specific data structures
interface LpData {
  reward: string;
  periodFeesCurrency1?: string; // unused
  periodFeesCurrency0?: string; // unused
  totalFeesCommonDenominator?: string; // unused
}
type LpDataEntry = [Address, LpData];
export interface TelxIncentivesJson {
  lpData: LpDataEntry[];
}

type CliArgs =
  | { mode: "tan"; period: number; check: boolean }
  | { mode: "telx"; period: number }
  | { mode: "setup"; stub: Address; check: boolean };

type TanOutput = Array<[string, string]>;
type TelxOutput = {
  wallets: string[];
  amounts: string[];
};

const OUTPUT_DIR = path.join(__dirname, "temp");
const TEL_DECIMALS = 10n ** config.telToken[ChainId.Polygon].decimals;

const fmtOld = (amount: bigint) =>
  formatUnits(amount, Number(OLD_TEL.decimals));

/// one client per run; the latest block number is read once and every preflight read is pinned to it
async function pinnedPolygon(): Promise<{ reader: ContractReader; atBlock: bigint }> {
  const client = createRpcClient(ChainId.Polygon);
  return { reader: client as unknown as ContractReader, atBlock: await client.getBlockNumber() };
}

function printPreflight(passed: string[], atBlock: bigint) {
  console.log(`\nPreflight (onchain, every read pinned to Polygon block ${atBlock}):`);
  passed.forEach((check) => console.log(`  OK  ${check}`));
}

/**
 * TAN: builds Safe{Wallet} Transaction Builder batch files for post-migration distributions.
 * Rewards files stay in old-TEL (2 decimal) units; payouts are new TEL (18 decimals) at 1:1.
 * TELx: unchanged pre-migration `PositionRegistry::addRewards` parameter chunks.
 *
 * usage:
 *   yarn ts-node backend/safeTxArrayBuilder.ts --setup-stub <RecordOnlyPlugin address>   (TAN, once)
 *   yarn ts-node backend/safeTxArrayBuilder.ts --period 51 --tan
 *   add --check to a TAN or setup run to run every check and print sha256s without writing files
 *   yarn ts-node backend/safeTxArrayBuilder.ts --period 0 --telx
 */
async function main() {
  try {
    const args = parseCliArgs();
    if (args.mode === "setup") await buildSetup(args.stub, args.check);
    else if (args.mode === "tan") await buildTan(args.period, args.check);
    else await buildTelx(args.period);
  } catch (err) {
    // expected refusals print without a stack trace
    if (err instanceof PreflightError || err instanceof AccountingError)
      console.error(`\nRefusing to build batch files. ${err.message}`);
    else console.error("Error building Safe transaction batches", err);
    process.exitCode = 1;
  }
}

main();

/**
 * Parses command-line arguments to discern the one-time TAN setup, TAN, or TELx runs
 */
function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  const check = args.includes("--check");

  const stubIndex = args.indexOf("--setup-stub");
  if (stubIndex !== -1) {
    const stub = args[stubIndex + 1];
    if (!stub || !isAddress(stub))
      throw new Error("Error: --setup-stub must be followed by an address.");
    return { mode: "setup", stub: getAddress(stub), check };
  }

  const periodIndex = args.indexOf("--period");
  if (periodIndex === -1 || periodIndex + 1 >= args.length) {
    throw new Error(
      "Error: --period must be specified and followed by a number."
    );
  }
  const period = parsePeriod(args[periodIndex + 1]);

  const hasTan = args.includes("--tan");
  const hasTelx = args.includes("--telx");

  if (hasTan && hasTelx) {
    throw new Error("Error: Please specify either --tan or --telx, not both.");
  }
  if (!hasTan && !hasTelx) {
    throw new Error("Error: Must specify either --tan or --telx.");
  }

  if (hasTelx) {
    if (check) throw new Error("Error: --check applies to TAN runs only.");
    return { mode: "telx", period };
  }
  return { mode: "tan", period, check };
}

async function buildSetup(stub: Address, check: boolean) {
  const { reader, atBlock } = await pinnedPolygon();
  const passed = await preflightStubSetup(reader, stub, atBlock);

  const batch = buildStubSetupBatch(stub);
  const file: BatchFile = {
    chainId: ChainId.Polygon,
    safeAddress: TAN_SAFE,
    filePath: path.join(OUTPUT_DIR, "safe_batch_tan_setup_record_only_plugin.json"),
    json: toSafeTxBuilderJson(batch, {
      name: "TAN: switch TANIssuanceHistory to RecordOnlyPlugin",
      description: `TANIssuanceHistory.setTanIssuancePlugin(${stub})`,
      safeAddress: TAN_SAFE,
    }),
  };
  const verifySetup = ([reloaded]: SafeBatch[]) => {
    if (JSON.stringify(reloaded) !== JSON.stringify(batch))
      throw new AccountingError("Setup batch file does not match the setTanIssuancePlugin call");
  };
  const [hash] = check
    ? (() => {
        const { batches, hashes } = reload([file], [render(file)]);
        verifySetup(batches);
        return hashes;
      })()
    : await writeVerified(OUTPUT_DIR, [file], null, verifySetup);

  console.log(`
=== TAN one-time setup: record-only plugin${check ? " (check only, no file written)" : ""} ===`);
  printPreflight(passed, atBlock);
  console.log(`
Before importing, also confirm ${stub} is the verified RecordOnlyPlugin source on Polygonscan
(deployed by script/DeployRecordOnlyPlugin.s.sol).

Safe batch (TAN Safe ${TAN_SAFE}, Polygon):
  ${file.filePath}
    sha256 ${hash}
    tx 1  TANIssuanceHistory.setTanIssuancePlugin(${stub})

After execution, TANIssuanceHistory.tanIssuancePlugin() must return ${stub},
then set RECORD_ONLY_PLUGIN = "${stub}" in backend/newTelDistribution.ts so TAN runs can build.
Existing claimable balances on the original SimplePlugin are unaffected.
Rolling back with setTanIssuancePlugin(<original SimplePlugin>) restores the pre-migration flow,
which again requires funding the history with old TEL every period.
`);
}

async function buildTan(period: number, check: boolean) {
  const fileName = `rewards/staker_rewards_period_${period}.json`;
  console.log(`Reading TAN rewards file: ${fileName}`);
  const json = JSON.parse(await fs.readFile(fileName, "utf-8")) as IncentivesJson;

  const rewards = parseTanRewards(json);
  const { startBlock, endBlock } = selectPolygonRange(json.blockRanges);
  assertWithinBudget(`TAN period ${period}`, rewards, TAN_BUDGET);

  const chunks = chunkRewards(rewards);
  const { reader, atBlock } = await pinnedPolygon();
  const { passed, pendingChunks } = await preflightTan(reader, {
    atBlock,
    startBlock,
    endBlock,
    chunks,
    recordOnlyPlugin: RECORD_ONLY_PLUGIN,
  });

  const allBatches = buildTanBatches(rewards, endBlock);
  verifyTanBatches(rewards, endBlock, allBatches);
  const executedChunks = chunks.flatMap((_, i) => (pendingChunks.includes(i) ? [] : [i]));

  if (pendingChunks.length === 0) {
    console.log(`\n=== TAN period ${period}: every chunk is already recorded onchain; nothing to build ===`);
    printPreflight(passed, atBlock);
    return;
  }

  const pendingRewards = pendingChunks.flatMap((i) => chunks[i]);
  const files: BatchFile[] = pendingChunks.map((i) => ({
    chainId: ChainId.Polygon,
    safeAddress: TAN_SAFE,
    filePath: path.join(OUTPUT_DIR, `safe_batch_period_${period}_tan_${i}.json`),
    json: toSafeTxBuilderJson(allBatches[i], {
      name: `TAN period ${period} batch ${i + 1}/${allBatches.length}`,
      description: `Record ${chunks[i].length} rewards on TANIssuanceHistory (old TEL units, endBlock ${endBlock}) and pay them in new TEL`,
      safeAddress: TAN_SAFE,
    }),
  }));

  const verifyPending = (batches: SafeBatch[]) =>
    verifyTanBatches(pendingRewards, endBlock, batches);
  let hashes: string[];
  if (check) {
    const reloaded = reload(files, files.map(render));
    verifyPending(reloaded.batches);
    hashes = reloaded.hashes;
  } else {
    hashes = await writeVerified(OUTPUT_DIR, files, period, verifyPending);
  }
  const report = verifyTanBatches(
    pendingRewards,
    endBlock,
    pendingChunks.map((i) => allBatches[i])
  );

  console.log(`
=== TAN period ${period}: record old TEL, pay new TEL${check ? " (check only, no files written)" : ""} ===

Accounting check (decoded from the ${check ? "rendered" : "written"} batch files):
  rewardees in these files  ${report.recipients} of ${rewards.length}
  recorded     (old TEL)    ${fmtOld(report.recordedOldTotal)} TEL   raw ${report.recordedOldTotal} (${OLD_TEL.decimals} decimals)
  paid         (new TEL)    ${report.newTotalFormatted} TEL   raw ${report.transferredNewTotal} (${NEW_TEL.decimals} decimals)
  period total (old TEL)    ${fmtOld(rewards.reduce((acc, r) => acc + r.amount, 0n))} TEL, budget ${fmtOld(TAN_BUDGET)} TEL
  OK: records == rewards file; each batch's transfers == its records x ${OLD_TO_NEW_TEL_SCALE}; totals agree; within budget`);
  printPreflight(passed, atBlock);
  if (executedChunks.length > 0)
    console.log(`
Already recorded onchain (not rebuilt): chunk ${executedChunks.join(", ")}`);
  console.log(`
Before signing:
  - Each file pays every time it executes. Execute each exactly once.
  - Never queue a file of this period twice. Building again (or by another signer) produces identical
    files with the same sha256; if one is already queued in the Safe, do not propose it again.
  - If time has passed since building, re-run with --check (writes nothing) and confirm the same chunks
    are still pending before executing.
  - The preflight saw chain state at block ${atBlock}. Anything executed after that block is not reflected:
    confirm that block is later than this period's most recent Safe execution.
  - Do NOT transfer old TEL to TANIssuanceHistory (the pre-migration funding step). Nothing pulls it now.

Safe batches (TAN Safe ${TAN_SAFE}, Polygon). Execute in order, one Safe tx per file:`);
  pendingChunks.forEach((chunkIndex, i) => {
    const batch = allBatches[chunkIndex];
    const batchReport = verifyTanBatches(chunks[chunkIndex], endBlock, [batch]);
    const n = batch.transactions.length;
    console.log(`
  [chunk ${chunkIndex + 1}/${allBatches.length}] ${files[i].filePath}
    sha256 ${hashes[i]}
    tx 1        TANIssuanceHistory.increaseClaimableByBatch(${chunks[chunkIndex].length} rewards, endBlock ${endBlock})
                records ${batchReport.oldTotalFormatted} old TEL; moves no tokens
    tx 2-${n}${" ".repeat(Math.max(1, 7 - String(n).length))}newTEL.transfer x ${n - 1}
                pays ${batchReport.newTotalFormatted} new TEL`);
  });
  console.log(`
Each file is self-contained: its record call and transfers cover the same rewardees, so a partially
executed set never leaves rewards recorded but unpaid (or the reverse). In the Safe simulation check
that no old TEL moves and the Safe's new TEL balance drops by exactly the file's "pays" amount.
`);
}

/// TELx distribution is unchanged by the TEL migration and not built here: pre-migration PositionRegistry flow
async function buildTelx(period: number) {
  const poolConfigs = POOLS.map((pool) => ({
    fileName: `backend/checkpoints/${pool.name}-${period}.json`,
    poolIdentifier: `${pool.name}`,
  }));
  console.log("Reading TELx reward files...");

  for (const config of poolConfigs) {
    try {
      console.log(`\nProcessing pool: ${config.poolIdentifier}`);

      const rawData = await fs.readFile(config.fileName, "utf-8");
      const jsonData = JSON.parse(rawData) as TelxIncentivesJson;

      if (!jsonData.lpData || jsonData.lpData.length === 0)
        throw new Error(`No rewards in ${config.fileName}`);

      const outputData = processTelxRewards(jsonData as TelxIncentivesJson);
      // write pool's output file passing the unique identifier to determine destination dir
      await writeTelxOutputFiles(outputData, period, config.poolIdentifier);
    } catch (err) {
      throw new Error(
        `Could not process file for pool ${config.poolIdentifier}`
      );
    }
  }
}

/**
 * Processes rewards data for the TELx project.
 * @param {TelxIncentivesJson} jsonData The parsed JSON data from the TELx rewards file.
 * @returns {TelxOutput} An object containing two arrays: `wallets` and `amounts`.
 */
function processTelxRewards(jsonData: TelxIncentivesJson): TelxOutput {
  console.log("Processing rewards for TELx...");
  const wallets: string[] = [];
  const amounts: string[] = [];
  let totalAmount = 0n;

  for (const [address, data] of jsonData.lpData) {
    const reward = BigInt(data.reward.slice(0, -1));
    if (reward === 0n) continue;

    totalAmount += reward;
    wallets.push(address);
    amounts.push(reward.toString());
  }

  console.log(
    `\nTotal TELx amount to distribute via PositionRegistry:
    - ${totalAmount / TEL_DECIMALS} ERC20 TEL (decimals applied)
    - ${totalAmount} native/wrapped TEL (no decimals)`
  );
  console.log(
    "\nThis output is formatted for the PositionRegistry::addRewards(address[], uint256[]) function."
  );

  return { wallets, amounts };
}

/**
 * Chunks TELx data and writes it to JSON files in a temporary directory.
 * @param {TelxOutput} data The processed rewards data.
 * @param {number} period The rewards period number.
 * @param {string} poolIdentifier Used to divert the output file target path.
 */
async function writeTelxOutputFiles(
  data: TelxOutput,
  period: number,
  poolIdentifier: string
) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const chunkSize = 600;
  const { wallets, amounts } = data;
  let chunkIndex = 0;
  for (let i = 0; i < wallets.length; i += chunkSize) {
    const walletChunk = wallets.slice(i, i + chunkSize);
    const amountChunk = amounts.slice(i, i + chunkSize);

    // For `PositionRegistry::addRewards(address[], uint256[])`, this is `[wallets_array, amounts_array]`.
    const outputData = [walletChunk, amountChunk];
    const outputFilePath = path.join(
      OUTPUT_DIR,
      `safe_param_period_${period}_telx_${poolIdentifier}_chunk_${chunkIndex}.json`
    );
    await fs.writeFile(outputFilePath, JSON.stringify(outputData, null, 2));
    console.log(
      `\nPeriod ${period} TELx ${poolIdentifier} chunk ${chunkIndex} written to:\n  ${outputFilePath}`
    );
    chunkIndex++;
  }
}

/**
 * @dev Utility to sum all rewards across rewards files for specified periods
 * @todo This is a utility function, not part of the main flow. It can be invoked manually when necessary
 */
async function sumMultiplePeriods(periods: number[], project: "tan" | "telx") {
  // parse reward arrays and sum into aggregate map of address => totalReward
  const aggregateMap: Map<string, bigint> = new Map();
  for (const period of periods) {
    if (project === "tan") {
      // fetch content of each specified period's file as array
      const fileName = `rewards/staker_rewards_period_${period}.json`;
      console.log(`Reading TAN rewards file: ${fileName}`);
      try {
        const rawData = await fs.readFile(fileName, "utf-8");
        const jsonData = JSON.parse(rawData) as IncentivesJson;

        // sum into map
        for (const stakerIncentive of jsonData.stakerIncentives) {
          const rewardee = stakerIncentive.address;
          const reward = BigInt(stakerIncentive.reward);
          if (reward === 0n) continue;

          const currentTotal = aggregateMap.get(rewardee) || 0n;
          aggregateMap.set(rewardee, currentTotal + reward);
        }
      } catch (err) {
        console.error(`Unable to parse file at ${fileName}`);
        throw err;
      }
    } else {
      // project === "telx"
      const poolConfigs = POOLS.map((pool) => ({
        fileName: `backend/checkpoints/${pool.name}-${period}.json`,
        poolIdentifier: `${pool.name}`,
      }));
      console.log(`Reading TELx reward files for period ${period}`);

      for (const config of poolConfigs) {
        try {
          console.log(`\nProcessing pool: ${config.poolIdentifier}`);

          // fetch content of each specified period's file as array
          const rawData = await fs.readFile(config.fileName, "utf-8");
          const jsonData = JSON.parse(rawData) as TelxIncentivesJson;

          if (!jsonData.lpData || jsonData.lpData.length === 0)
            throw new Error(`No rewards in ${config.fileName}`);

          for (const [address, data] of jsonData.lpData) {
            const reward = BigInt(data.reward.slice(0, -1));
            if (reward === 0n) continue;
            const currentTotal = aggregateMap.get(address) || 0n;
            aggregateMap.set(address, currentTotal + reward);
          }
        } catch (err) {
          throw new Error(
            `Could not process file for pool ${config.poolIdentifier}`
          );
        }
      }
    }
  }

  // convert map back to output format and write to file
  let totalAmount = 0n;
  if (project === "tan") {
    const issuanceRewards: TanOutput = [];
    for (const [address, totalReward] of aggregateMap) {
      totalAmount += totalReward;
      issuanceRewards.push([address, totalReward.toString()]);
    }
    // write to file
    const outputFilePath = path.join(
      __dirname,
      "temp",
      `safe_param_periods_${periods.join("_")}_tan_aggregate.json`
    );
    await fs.writeFile(
      outputFilePath,
      JSON.stringify(issuanceRewards, null, 2)
    );
    console.log(
      `\nAggregate TAN rewards for periods ${periods.join(
        ", "
      )} written to:\n  ${outputFilePath}`
    );

    return issuanceRewards;
  } else {
    // project === 'telx'
    const wallets: string[] = [];
    const amounts: string[] = [];

    for (const [address, reward] of aggregateMap) {
      totalAmount += reward;
      wallets.push(address);
      amounts.push(reward.toString());
    }
    console.log(
      `Total amount of TEL in raw EVM value to approve (no decimals applied): ${totalAmount}`
    );
    const outputFilePath = path.join(
      __dirname,
      "temp",
      `safe_param_periods_${periods.join("_")}_telx_aggregate.json`
    );
    const outputData = { wallets, amounts };
    await fs.writeFile(outputFilePath, JSON.stringify(outputData, null, 2));
    console.log(
      `\nAggregate TELx rewards for periods ${periods.join(
        ", "
      )} written to:\n  ${outputFilePath}`
    );

    return outputData;
  }
}
