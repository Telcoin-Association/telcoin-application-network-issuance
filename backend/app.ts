import * as dotenv from "dotenv";
dotenv.config();

import { existsSync } from "fs";
import { LocalFileExecutorRegistry } from "./datasources/ExecutorRegistry";
import { BlocksDatabase } from "./datasources/persistent/BlocksDatabase";
import { ChainId, config } from "./config";
import {
  parseAndSanitizeCLIArgs,
  validateStartAndEndBlocks,
  writeIncentivesToExcel,
  writeIncentivesToFile,
} from "./helpers";
import { SimplePlugin } from "./datasources/SimplePlugin";
import { TokenTransferHistory } from "./datasources/TokenTransferHistory";
import { StakerIncentivesCalculator } from "./calculators/StakerIncentivesCalculator";
import { amirXs } from "./data/amirXs";
import { stakingModules } from "./data/stakingModules";
import { tanIssuanceHistories } from "./data/tanIssuanceHistories";
import { Address, createPublicClient, http } from "viem";
import { polygon } from "viem/chains";
import { UserRewardEntry } from "calculators/ICalculator";

// Track active database connections
let activeBlocksDatabases: BlocksDatabase[] = [];

/**
 * @notice This is the main entrypoint for the application.
 * @dev We initialize datasources and pass them to calculators.
 * @dev Then run the calculators.
 */
async function main() {
  const { period, rerun, networkArgs } = parseAppCLIArgs(
    process.argv.slice(2),
  );
  // Build output path early so we can fail fast before doing any RPC work
  // if the period would clobber an already-published rewards file.
  const rewardsFilePath = `./rewards/staker_rewards_period_${period}${
    rerun ? ".rerun" : ""
  }.json`;
  if (!rerun && existsSync(rewardsFilePath)) {
    console.error(
      `Aborting: ${rewardsFilePath} already exists.\n` +
        `  - Pass --rerun to write to ${rewardsFilePath.replace(
          ".json",
          ".rerun.json",
        )} instead.\n` +
        `  - Or use a different --period if you meant a different week.`,
    );
    process.exit(1);
  }

  const networks = parseAndSanitizeCLIArgs(networkArgs);
  await validateStartAndEndBlocks(networks);
  const polygonConfig = networks.find(
    (networkConfig) => networkConfig.network === "polygon"
  );

  /**
   * @dev Initialize Datasources
   */

  // the executor registry keeps track of each developer's executors
  console.log("Initializing executor registry...");
  const executorRegistry = new LocalFileExecutorRegistry();

  // TokenTransferHistory fetches and stores ERC20 transfer events
  console.log("Initializing token transfer history...");
  const optimizededPublicClient = createPublicClient({
    batch: { multicall: true },
    chain: polygon,
    transport: http(config.rpcUrls[ChainId.Polygon], { batch: true }),
  });
  const polygonTokenTransferHistory = new TokenTransferHistory(
    config.telToken[ChainId.Polygon],
    polygonConfig!.startBlock,
    polygonConfig!.endBlock,
    optimizededPublicClient
  );

  console.log("Fetching token transfers...");
  await polygonTokenTransferHistory.init();

  // SimplePlugin fetches claimableIncreased events from a SimplePlugin contract for the referral calculator
  console.log("Initializing simple plugins...");
  const polygonSimplePlugins = config.simplePlugins[ChainId.Polygon].map(
    (address) =>
      new SimplePlugin(
        ChainId.Polygon,
        address,
        polygonConfig!.startBlock,
        polygonConfig!.endBlock
      )
  );
  await Promise.all(polygonSimplePlugins.map((plugin) => plugin.init()));

  /**
   * @dev Initialize Calculators
   */

  // StakerIncentivesCalculator
  // This calculator calculates the referrals incentives for each staker
  console.log("Initializing stakers incentives calculator...");
  const polygonStakerIncentivesCalculator = new StakerIncentivesCalculator(
    [polygonTokenTransferHistory],
    stakingModules,
    tanIssuanceHistories,
    amirXs,
    executorRegistry,
    config.incentivesAmounts.stakerIncentivesAmount,
    {
      [ChainId.Polygon]: polygonConfig!.startBlock,
    },
    {
      [ChainId.Polygon]: polygonConfig!.endBlock,
    }
  );

  /**
   * @dev Run Calculators
   */

  console.log("Calculating staker referrals incentives...");
  const polygonStakerIncentives =
    await polygonStakerIncentivesCalculator.calculate();

  const totalIssuance = Array.from(polygonStakerIncentives.values()).reduce(
    (accumulator: bigint, currentEntry: UserRewardEntry) => {
      return accumulator + currentEntry.reward;
    },
    0n
  );
  console.log(
    `Total issuance amount for this period after applying rewards caps: ${totalIssuance}`
  );

  // write incentives to `./rewards/staker_rewards_period_<n>.json`
  await writeIncentivesToFile(
    polygonStakerIncentives,
    networks,
    rewardsFilePath
  );

  // write incentives to `./staker_incentives.xlsx` (sheet keyed by block range)
  writeIncentivesToExcel(
    polygonStakerIncentives,
    networks,
    "staker_incentives.xlsx"
  );
}

/**
 * Splits CLI args into the staker-calculator's flags (`--period`, `--rerun`)
 * and the remaining `network=start:end` args consumed by `parseAndSanitizeCLIArgs`.
 */
function parseAppCLIArgs(args: string[]): {
  period: number;
  rerun: boolean;
  networkArgs: string[];
} {
  let period: number | undefined;
  let rerun = false;
  const networkArgs: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("--period=")) {
      const value = arg.slice("--period=".length);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        console.error(`Invalid --period value: '${value}'`);
        process.exit(1);
      }
      period = parsed;
    } else if (arg === "--rerun") {
      rerun = true;
    } else {
      networkArgs.push(arg);
    }
  }

  if (period === undefined) {
    console.error(
      "Missing required --period=<n> flag.\n" +
        "Example: `yarn start polygon=85847979:86150378 --period=29`",
    );
    process.exit(1);
  }

  return { period, rerun, networkArgs };
}

/**
 * Not currently used but kept for future use of BlocksDBs
 * Handles graceful shutdown of the application
 * Ensures all database connections are closed
 * and pending operations are complete
 */
async function gracefulShutdown(signal: string) {
  console.log(`\nReceived ${signal}. Starting graceful shutdown...`);

  try {
    // Close all BlocksDatabase connections
    if (activeBlocksDatabases.length > 0) {
      console.log("Closing blocks databases...");
      await Promise.all(activeBlocksDatabases.map((db) => db.close()));
      console.log("Successfully closed blocks databases");
    }

    console.log("Shutdown complete. Exiting...");
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

main().catch(async (error) => {
  console.error("error:", error);
  await gracefulShutdown("ERROR");
});
