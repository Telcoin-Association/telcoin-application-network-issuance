import * as XLSX from "xlsx";
import { promises as fs } from "fs";
import { formatUnits, Address, erc20Abi, zeroAddress, getAddress } from "viem";
import {
  LPData,
  PERIODS,
  PoolConfig,
  POOLS,
  PositionState,
  SupportedChainId,
  TELX_BASE_PATH,
} from "./calculators/TELxRewardsCalculator";
import { createRpcClient, jsonReviver } from "./helpers";

interface PoolData {
  blockRange: {
    network: string;
    startBlock: string;
    endBlock: string;
  };
  poolId: `0x${string}`;
  denominator: `0x${string}`;
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  positions: PositionEntry[];
  lpData: LPDataEntry[];
}
type PositionEntry = [string, PositionState];
type LPDataEntry = [Address, LPData];

const TEL_DECIMALS = 2;

/// @dev Usage: `yarn ts-node backend/telxHumanReadable.ts`
async function processFiles() {
  for (const pool of POOLS) {
    for (const period of PERIODS) {
      const fileNameBase = `${pool.name}-${period}`;
      const inputFile = `${TELX_BASE_PATH}/${fileNameBase}.json`;
      const outputFile = `${TELX_BASE_PATH}/${fileNameBase}.xlsx`;

      try {
        // Check if the file exists before trying to process
        await fs.access(inputFile);

        // Check if the output file already exists
        try {
          await fs.access(outputFile);
          console.log(
            `\n--- Skipping: Output file already exists: ${outputFile} ---`
          );
          continue;
        } catch (error: unknown) {
          // Output file doesn't exist, proceed with conversion
        }

        await convertFile(inputFile, outputFile, pool);
      } catch (error: unknown) {
        if (error && typeof error === "object" && "code" in error) {
          if (error.code === "ENOENT") {
            console.log(`\n--- Skipping: File not found: ${inputFile} ---`);
          } else {
            console.error(
              `\n--- ❌ An error occurred while processing ${inputFile}: ---\n`,
              error
            );
          }
        } else {
          console.error(
            `\n--- ❌ An unexpected error occurred while processing ${inputFile}: ---\n`,
            error
          );
        }
      }
    }
  }
}

async function convertFile(
  inputFile: string,
  outputFile: string,
  poolConfig: PoolConfig
) {
  console.log(`\n--- Processing file: ${inputFile} ---`);

  const client = createRpcClient(poolConfig.network as SupportedChainId);
  const fileContent = await fs.readFile(inputFile, "utf-8");
  const jsonData: PoolData = JSON.parse(fileContent, jsonReviver);

  const {
    blockRange,
    poolId,
    denominator,
    currency0,
    currency1,
    positions,
    lpData,
  } = jsonData;

  if (
    currency0 !== getAddress(poolConfig.currency0) ||
    currency1 !== getAddress(poolConfig.currency1)
  ) {
    throw new Error(
      `  ⚠️ Could not determine currency addresses for ${inputFile}.`
    );
  }

  // Fetch decimals dynamically
  console.log(`  Fetching decimals for ${poolConfig.name}...`);
  const [decimals0, decimals1] = await Promise.all([
    // Handle native token case (like ETH on Base) which has no decimals function
    currency0 === zeroAddress
      ? Promise.resolve(18)
      : client.readContract({
          address: currency0,
          abi: erc20Abi,
          functionName: "decimals",
        }),
    currency1 === zeroAddress
      ? Promise.resolve(18)
      : client.readContract({
          address: currency1,
          abi: erc20Abi,
          functionName: "decimals",
        }),
  ]);

  // Process data into sheets
  const topLevelInfo = [
    { Parameter: "File Name", Value: inputFile },
    { Parameter: "Pool Name", Value: poolConfig.name },
    { Parameter: "Pool ID", Value: poolId },
    { Parameter: "Network", Value: blockRange.network },
    { Parameter: "Start Block", Value: blockRange.startBlock.toString() },
    { Parameter: "End Block", Value: blockRange.endBlock.toString() },
    { Parameter: "Currency 0 Address", Value: currency0 },
    { Parameter: "Currency 1 Address", Value: currency1 },
    { Parameter: "Denominator Token Address", Value: denominator },
  ];
  const positionsSummary = positions.map(([id, data]) => ({
    positionId: formatBigIntString(id, 0),
    lastOwner: data.lastOwner,
    tickLower: data.tickLower,
    tickUpper: data.tickUpper,
    lastLiquidity: formatBigIntString(data.liquidity, 0),
    feeGrowthInsidePeriod0_formatted: formatBigIntString(
      data.feeGrowthInsidePeriod0,
      decimals0
    ),
    feeGrowthInsidePeriod1_formatted: formatBigIntString(
      data.feeGrowthInsidePeriod1,
      decimals1
    ),
  }));
  const liqModifications = positions.flatMap(([id, data]) =>
    data.liquidityModifications.map((mod) => ({
      positionId: formatBigIntString(id, 0),
      blockNumber: mod.blockNumber.toString(),
      newLiquidityAmount: formatBigIntString(mod.newLiquidityAmount, 0),
      owner: mod.owner,
    }))
  );
  const lpRewards = lpData.map(([addr, data]) => ({
    lpAddress: addr,
    periodFeesCurrency0_formatted: formatBigIntString(
      data.periodFeesCurrency0,
      decimals0
    ),
    periodFeesCurrency1_formatted: formatBigIntString(
      data.periodFeesCurrency1,
      decimals1
    ),
    reward_formatted: formatBigIntString(data.reward!, TEL_DECIMALS),
    totalFeesCommonDenominator: data.totalFeesCommonDenominator!.toString(),
  }));

  // create and write XLSX file
  const wb = XLSX.utils.book_new();
  // Create worksheets for all data
  const wsReportInfo = XLSX.utils.json_to_sheet(topLevelInfo);
  const wsPositions = XLSX.utils.json_to_sheet(positionsSummary);
  const wsModifications = XLSX.utils.json_to_sheet(liqModifications);
  const wsLpRewards = XLSX.utils.json_to_sheet(lpRewards);
  XLSX.utils.book_append_sheet(wb, wsReportInfo, "Top Level Info");
  XLSX.utils.book_append_sheet(wb, wsPositions, "Positions");
  XLSX.utils.book_append_sheet(wb, wsModifications, "Liquidity Modifications");
  XLSX.utils.book_append_sheet(wb, wsLpRewards, "LP Rewards");
  XLSX.writeFile(wb, outputFile);

  console.log(`  ✅ Success! Report saved to ${outputFile}`);
}

/**
 * Helper to format bigint strings using the fetched decimal value
 * The value can be a string (from JSON) or bigint (if already converted)
 */
function formatBigIntString(value: bigint | string, decimals: number): string {
  const stringValue = String(value).endsWith("n")
    ? String(value).slice(0, -1)
    : String(value);

  return formatUnits(BigInt(stringValue), decimals);
}

processFiles();
