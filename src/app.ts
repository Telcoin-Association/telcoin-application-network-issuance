import * as dotenv from "dotenv";
dotenv.config();

import { LocalFileExecutorRegistry } from "./datasources/ExecutorRegistry";
import { BlocksDatabase } from "./datasources/persistent/BlocksDatabase";
import { ChainId, config } from "./config";
import {
  getLastSettlementBlockAndLatestBlock,
  getStartAndEndBlocks,
  NetworkConfig,
  parseAndSanitizeCLIArgs,
  writeIncentivesToFile,
} from "./helpers";
import { DeveloperIncentivesCalculator } from "./calculators/DeveloperIncentivesCalculator";
import { SimplePlugin } from "./datasources/SimplePlugin";
import { LocalFileUserRegistry } from "./datasources/UserRegistry";
import { TokenTransferHistory } from "./datasources/TokenTransferHistory";
import { StakerIncentivesCalculator } from "./calculators/StakerIncentivesCalculator";
import { aggregators } from "./data/aggregators";
import { amirXs } from "./data/amirXs";
import { stakingModules } from "./data/stakingModules";
import { tanIssuanceHistories } from "./data/tanIssuanceHistories";
import { Address, createPublicClient, http } from "viem";
import { addressResolverAbi } from "viem/_types/constants/abis";
import { polygon } from "viem/chains";

// Track active database connections
let activeBlocksDatabases: BlocksDatabase[] = [];

/**
 * @notice This is the main entrypoint for the application.
 * @dev We initialize datasources and pass them to calculators.
 * @dev Then run the calculators.
 */
async function main() {
  const networkArgs = process.argv.slice(2);
  const networks = parseAndSanitizeCLIArgs(networkArgs);

  const [
    polygonStartBlock,
    polygonEndBlock,
    mainnetStartBlock,
    mainnetEndBlock,
  ] = await getStartAndEndBlocks(networks);

  /**
   * @dev Initialize Datasources
   */

  // the executor registry keeps track of each developer's executors
  console.log("Initializing executor registry...");
  const executorRegistry = new LocalFileExecutorRegistry();

  // blocks databases fetch and store block data on disk
  console.log("Initializing blocks databases...");
  const polygonBlocksDatabase = new BlocksDatabase(ChainId.Polygon);
  // track active database for cleanup
  activeBlocksDatabases.push(polygonBlocksDatabase);

  // TokenTransferHistory fetches and stores ERC20 transfer events
  console.log("Initializing token transfer history...");
  const optimizededPublicClient = createPublicClient({
    batch: { multicall: true },
    chain: polygon,
    transport: http(config.rpcUrls[ChainId.Polygon], { batch: true }),
  });
  const polygonTokenTransferHistory = new TokenTransferHistory(
    config.telToken[ChainId.Polygon],
    polygonStartBlock,
    polygonEndBlock,
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
        polygonStartBlock,
        polygonEndBlock
      )
  );
  await Promise.all(polygonSimplePlugins.map((plugin) => plugin.init()));

  // User registry keeps track of users and their id, type, and addresses
  console.log("Initializing user registry...");
  const userRegistry = new LocalFileUserRegistry();
  await userRegistry.init();

  /**
   * @dev Initialize Calculators
   */

  // StakerIncentivesCalculator
  // This calculator calculates the referrals incentives for each staker
  console.log("Initializing stakers incentives calculator...");
  const polygonStakerIncentivesCalculator = new StakerIncentivesCalculator(
    [polygonBlocksDatabase],
    [polygonTokenTransferHistory],
    aggregators,
    stakingModules,
    tanIssuanceHistories,
    amirXs,
    executorRegistry,
    config.incentivesAmounts.stakerIncentivesAmount,
    {
      [ChainId.Polygon]: polygonStartBlock,
    },
    {
      [ChainId.Polygon]: polygonEndBlock,
    }
  );

  /**
   * @dev Run Calculators
   */

  console.log("Calculating staker referrals incentives...");
  const polygonStakerIncentives =
    await polygonStakerIncentivesCalculator.calculate();

  // log and store incentives in `./staker_incentives.json`
  await writeIncentivesToFile(
    polygonStakerIncentives,
    networks,
    "./staker_incentives.json"
  );
}

/**
 * Handles graceful shutdown of the application
 * Ensures all database connections are closed
 * and pending operations are complete
 */
async function gracefulShutdown(signal: string) {
  console.log(`\nReceived ${signal}. Starting graceful shutdown...`);

  try {
    // Close all BlocksDatabase connections
    if (activeBlocksDatabases.length > 0) {
      console.log('Closing blocks databases...');
      await Promise.all(activeBlocksDatabases.map(db => db.close()));
      console.log('Successfully closed blocks databases');
    }

    console.log('Shutdown complete. Exiting...');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

main().catch(async (error) => {
  console.error('error:', error);
  await gracefulShutdown('ERROR');
});
