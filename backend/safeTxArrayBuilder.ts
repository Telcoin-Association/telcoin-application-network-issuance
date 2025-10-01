import { Address } from "viem";
import * as fs from "fs/promises";
import * as path from "path";
import { NetworkConfig } from "./helpers";
import { ChainId, config } from "./config";
import { UserMetadata } from "./calculators/ICalculator";
import { POOLS } from "./calculators/TELxRewardsCalculator";
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

interface CliArgs {
  period: string;
  project: "tan" | "telx";
}

type TanOutput = Array<[string, string]>;
type TelxOutput = {
  wallets: string[];
  amounts: string[];
};

const TEL_DECIMALS = 10n ** config.telToken[ChainId.Polygon].decimals;

// usage example: `yarn ts-node backend/safeTxArrayBuilder.ts --period 0 --telx`
async function main() {
  try {
    const { period, project } = parseCliArgs();
    let outputData: TanOutput | TelxOutput;

    if (project === "tan") {
      const fileName = `rewards/staker_rewards_period_${period}.json`;
      console.log(`Reading TAN rewards file: ${fileName}`);
      try {
        const rawData = await fs.readFile(fileName, "utf-8");
        const jsonData = JSON.parse(rawData);
        outputData = processTanRewards(jsonData as IncentivesJson);
        await writeOutputFiles(outputData, period, project);
      } catch (err) {
        console.error(
          `Unable to parse file at ${fileName}, did you provide correct value to --period flag?`
        );
        throw err;
      }
    } else {
      // project === "telx"
      const poolConfigs = POOLS.map((pool) => ({
        fileName: `backend/checkpoints/${pool.network}-${pool.name}-${period}.json`,
        poolIdentifier: `${pool.network}-${pool.name}`,
      }));
      console.log("Reading TELx reward files...");

      for (const config of poolConfigs) {
        try {
          console.log(`\nProcessing pool: ${config.poolIdentifier}`);

          const rawData = await fs.readFile(config.fileName, "utf-8");
          const jsonData = JSON.parse(rawData) as TelxIncentivesJson;

          if (!jsonData.lpData || jsonData.lpData.length === 0)
            throw new Error(`No rewards in ${config.fileName}`);

          outputData = processTelxRewards(jsonData as TelxIncentivesJson);
          // write pool's output file passing the unique identifier to determine destination dir
          await writeOutputFiles(
            outputData,
            period,
            project,
            config.poolIdentifier
          );
        } catch (err) {
          throw new Error(
            `Could not process file for pool ${config.poolIdentifier}`
          );
        }
      }
    }
  } catch (err) {
    console.error("Error building arrays for Safe UI transactions", err);
  }
}

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

main();

/**
 * Parses command-line arguments to get the period and discern TAN vs TELx runs
 * @returns {CliArgs} The parsed period number and project type ('tan' or 'telx').
 */
function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);

  const periodIndex = args.indexOf("--period");
  if (periodIndex === -1 || periodIndex + 1 >= args.length) {
    throw new Error(
      "Error: --period must be specified and followed by a number."
    );
  }
  const period = args[periodIndex + 1];

  const hasTan = args.includes("--tan");
  const hasTelx = args.includes("--telx");

  if (hasTan && hasTelx) {
    throw new Error("Error: Please specify either --tan or --telx, not both.");
  }
  if (!hasTan && !hasTelx) {
    throw new Error("Error: Must specify either --tan or --telx.");
  }

  const project = hasTan ? "tan" : "telx";
  return { period, project };
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
    `\nTotal TELx amount to transfer via CryptoBatcher:
    - ${totalAmount / TEL_DECIMALS} ERC20 TEL (decimals applied)
    - ${totalAmount} native/wrapped TEL (no decimals)`
  );
  console.log(
    "\nThis output is formatted for the CryptoBatcher::batchTEL(address[], uint256[]) function."
  );

  return { wallets, amounts };
}

/**
 * Processes rewards data for TANIP projects intended for the TANIssuanceHistory contract
 * @param {IncentivesJson} jsonData The parsed JSON data from the TAN rewards file generated by TANIP calculators
 * @returns {TanOutput} An array of [address, reward] tuples
 */
function processTanRewards(jsonData: IncentivesJson): TanOutput {
  console.log("Processing rewards for TAN...");
  // distribution must include a transfer of the total TEL rewards to increaser (TANIssuanceHistory)
  let totalAmount = 0n;
  // build array of `TANIssuanceHistory::IssuanceReward` structs, to be JSON.stringified for Safe UI
  const issuanceRewards: TanOutput = [];

  for (const stakerIncentive of jsonData.stakerIncentives) {
    const rewardee = stakerIncentive.address;
    const reward = BigInt(stakerIncentive.reward);

    if (reward === 0n) continue;

    totalAmount += reward;
    issuanceRewards.push([rewardee, reward.toString()]);
  }

  console.log(
    `\nTotal TAN amount to transfer to TANIssuanceHistory:
    - ${totalAmount / TEL_DECIMALS} ERC20 TEL (decimals applied)
    - ${totalAmount} native/wrapped TEL (no decimals)`
  );
  console.log(
    "Polygon TEL Token address: 0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32"
  );
  console.log(
    "Polygon TANIssuanceHistory address: 0xe533911f00f1c3b58bb8d821131c9b6e2452fc27\n"
  );
  // relevant endBlock must be used in settlement transaction on the settlement chain
  console.log(
    "Select the `endBlock` for the settlement chain and pass to TANIssuanceHistory::increaseClaimableByBatched()"
  );
  jsonData.blockRanges.forEach((config) => {
    console.log(`  - ${config.network} endBlock: ${config.endBlock}`);
  });

  return issuanceRewards;
}

/**
 * Chunks data and writes it to JSON files in a temporary directory.
 * @param {TanOutput | TelxOutput} data The processed rewards data.
 * @param {string} period The rewards period number.
 * @param {'tan' | 'telx'} project The project type.
 * @param {number} chunkSize The number of records per output file.
 */
async function writeOutputFiles(
  data: TanOutput | TelxOutput,
  period: string,
  project: "tan" | "telx",
  poolIdentifier: string = "" // optional, used only for TELx
) {
  const outputDir = path.join(__dirname, "temp");
  await fs.mkdir(outputDir, { recursive: true });

  let chunkSize: number;
  if (project === "tan") {
    chunkSize = 300;
    const chunks = chunkArray(data as TanOutput, chunkSize);
    for (let i = 0; i < chunks.length; i++) {
      const outputFilePath = path.join(
        outputDir,
        `safe_param_period_${period}_tan_chunk_${i}.json`
      );
      await fs.writeFile(outputFilePath, JSON.stringify(chunks[i], null, 2));
      console.log(
        `\nPeriod ${period} TAN chunk ${i} written to:\n  ${outputFilePath}`
      );
    }
  } else {
    // project === 'telx'
    if (!poolIdentifier) throw new Error("No pool identifier for telx run");

    chunkSize = 600;
    const { wallets, amounts } = data as TelxOutput;
    let chunkIndex = 0;
    for (let i = 0; i < wallets.length; i += chunkSize) {
      const walletChunk = wallets.slice(i, i + chunkSize);
      const amountChunk = amounts.slice(i, i + chunkSize);

      // For `CryptoBatcher::batchTEL(address[], uint256[])`, this is `[wallets_array, amounts_array]`.
      const outputData = [walletChunk, amountChunk];
      // use pool identifier to divert output file target path
      const outputFilePath = path.join(
        outputDir,
        `safe_param_period_${period}_telx__${poolIdentifier}_chunk_${chunkIndex}.json`
      );
      await fs.writeFile(outputFilePath, JSON.stringify(outputData, null, 2));
      console.log(
        `\nPeriod ${period} TELx ${poolIdentifier} chunk ${chunkIndex} written to:\n  ${outputFilePath}`
      );
      chunkIndex++;
    }
  }
}
