import * as dotenv from "dotenv";
import { Observable } from "rxjs";
dotenv.config();

import fs from "fs";
import path from "path";
import * as viem from "viem";
import * as cliProgress from "cli-progress";
import { writeFile } from "fs/promises";
import { ChainId, config } from "./config";
import { Address, getContract, zeroAddress } from "viem";
import { tanIssuanceHistories } from "./data/tanIssuanceHistories";
import { randomInt } from "crypto";
import * as xlsx from "xlsx";

export interface Update<T> {
  progress: number;
  data: T;
}

export type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

export function getStartAndEndTimestampsForWeek(week: bigint) {
  const startTimestamp =
    config.weekZeroStartTimestamp + week * config.secondsPerWeek;
  const endTimestamp = startTimestamp + config.secondsPerWeek;
  return { startTimestamp, endTimestamp };
}

/**
 * Ensures data directory exists and creates it if not
 */
export function ensureDataDirectory(directory: string) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

/**
 * Creates data file if it doesn't exist
 */
export function ensureDataFile(dataFilePath: string, defaultData: any) {
  // create file with default empty array
  if (!fs.existsSync(dataFilePath)) {
    fs.writeFileSync(dataFilePath, JSON.stringify(defaultData, null, 2));
    console.log(`Created default file at ${dataFilePath}`);
  }
}

export function jsonParse(s: string) {
  return JSON.parse(s, (key, value) => {
    if (typeof value === "string" && /^\d+n$/.test(value)) {
      return BigInt(value.substr(0, value.length - 1));
    }
    return value;
  });
}

export function jsonStringify(obj: any) {
  return JSON.stringify(obj, (key, value) =>
    typeof value === "bigint" ? value.toString() + "n" : value
  );
}

export function copyByJson<T>(obj: T): T {
  return jsonParse(jsonStringify(obj));
}

export function getSupportedChain(chainId: string): ChainId {
  const chainIdNumber = parseInt(chainId, 10);

  if (Object.values(ChainId).includes(chainIdNumber)) {
    return chainIdNumber as ChainId;
  }

  throw new Error(`Invalid chainId: ${chainId}`);
}

export function scaleDecimals(
  currentValue: bigint,
  currentDecimals: bigint,
  desiredDecimals: bigint
) {
  if (currentDecimals === desiredDecimals) {
    return currentValue;
  }
  if (currentDecimals < desiredDecimals) {
    return currentValue * 10n ** (desiredDecimals - currentDecimals);
  }
  return currentValue / 10n ** (currentDecimals - desiredDecimals);
}

export function flatten2DArray<T>(arr: T[][]) {
  return arr.reduce((acc, val) => acc.concat(val), []);
}

export function createRpcClient(chain: ChainId) {
  const chainObj = config.chains.find((c) => c.id === chain);
  if (!chainObj) {
    throw new Error(`Unsupported chain: ${chain}`);
  }
  return viem.createPublicClient({
    chain: chainObj,
    transport: viem.http(config.rpcUrls[chain]),
  });
}

export function observableToPromise<T>(obs: Observable<Update<T>>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let data: T;
    obs.subscribe({
      next: (update: Update<T>) => {
        data = update.data;
      },
      complete: () => {
        resolve(data);
      },
      error: (error) => {
        reject(error);
      },
    });
  });
}

export function observableToProgressBar<T>(
  obs: Observable<Update<T>>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let data: T;
    const bar = new cliProgress.SingleBar(
      {},
      cliProgress.Presets.shades_classic
    );
    bar.start(100, 0);
    obs.subscribe({
      next: (update: Update<T>) => {
        bar.update(Math.floor(update.progress * 100 * 100) / 100);
        data = update.data;
      },
      complete: () => {
        bar.stop();
        resolve(data);
      },
      error: (error) => {
        reject(error);
      },
    });
  });
}

export interface NetworkConfig {
  network: string;
  startBlock?: bigint;
  endBlock?: bigint;
}

export function parseAndSanitizeCLIArgs(
  networkArgs: string[]
): NetworkConfig[] {
  const validNetworks: string[] = config.chains.map((chain) =>
    chain.name.toLowerCase()
  );

  const networkConfigs: NetworkConfig[] = [];

  networkArgs.forEach((arg) => {
    const [network, blockRange] = arg.split("=");
    const networkLowerCase = network.toLowerCase();

    if (!validNetworks.includes(networkLowerCase)) {
      console.error(`Invalid network specified: ${network}`);
      process.exit(1);
    }

    let startBlock: bigint | undefined;
    let endBlock: bigint | undefined;

    if (blockRange) {
      const [startBlockStr, endBlockStr] = blockRange.split(":");

      if (startBlockStr && !isNaN(Number(startBlockStr))) {
        startBlock = BigInt(startBlockStr);
      } else if (startBlockStr) {
        console.error(
          `Invalid start block specified for ${network}: ${blockRange}`
        );
        process.exit(1);
      }

      if (endBlockStr && !isNaN(Number(endBlockStr))) {
        endBlock = BigInt(endBlockStr);
      } else if (endBlockStr) {
        console.error(
          `Invalid end block specified for ${network}: ${blockRange}`
        );
        process.exit(1);
      }
    }

    networkConfigs.push({ network: networkLowerCase, startBlock, endBlock });
  });

  if (networkConfigs.length === 0) {
    console.log(
      "Enter network configurations in the format `network`, `network=startBlock`, or `network=startBlock:endBlock` and separate multiple networks by space. Eg usage: `yarn start polygon` or `yarn start polygon=666000:667000 mainnet=100000:110000`"
    );

    process.exit(1);
  }

  return networkConfigs;
}

export async function getStartAndEndBlocks(
  networkConfigs: NetworkConfig[]
): Promise<[bigint, bigint, bigint, bigint]> {
  // initialize to ensure type safety
  let polygonLatestBlock;
  let polygonStartBlock = 0n;
  let polygonEndBlock = 0n;
  let mainnetLatestBlock;
  let mainnetStartBlock = 0n;
  let mainnetEndBlock = 0n;

  for (const { network, startBlock } of networkConfigs) {
    if (network === "polygon") {
      [polygonStartBlock, polygonLatestBlock] =
        await getLastSettlementBlockAndLatestBlock(ChainId.Polygon);
      polygonEndBlock =
        polygonLatestBlock - config.reorgSafeDepth[ChainId.Polygon];
      // overwrite startBlock if specified to prevent starting at block 0 on first runs
      if (startBlock !== undefined) {
        polygonStartBlock = startBlock;
      }
      console.log("Processed Polygon start and end blocks");
    }

    if (network === "mainnet") {
      [mainnetStartBlock, mainnetLatestBlock] =
        await getLastSettlementBlockAndLatestBlock(ChainId.Mainnet);
      mainnetEndBlock =
        mainnetLatestBlock - config.reorgSafeDepth[ChainId.Mainnet];
      // overwrite startBlock if specified to prevent starting at block 0 on first runs
      if (startBlock !== undefined) {
        mainnetStartBlock = startBlock;
      }
      console.log("Processed Mainnet start and end blocks");
    }
  }

  return [
    polygonStartBlock,
    polygonEndBlock,
    mainnetStartBlock,
    mainnetEndBlock,
  ];
}

export async function getLastSettlementBlockAndLatestBlock(
  chain: ChainId
): Promise<[bigint, bigint]> {
  const client = createRpcClient(chain);
  const matchingChainTanIssuanceHistory = tanIssuanceHistories.find(
    (history) => history.chain === chain
  );

  if (!matchingChainTanIssuanceHistory)
    throw new Error(
      "No TanIssuanceHistory was found for the specified chain, update config in src/data/tanIssuanceHistories.ts"
    );

  const lastSettlementBlock = await client.readContract({
    address: matchingChainTanIssuanceHistory!.address,
    abi: matchingChainTanIssuanceHistory!.abi,
    functionName: "lastSettlementBlock",
  });
  const latestBlock = await client.getBlockNumber();

  return [lastSettlementBlock, latestBlock];
}

export async function getBlockByTimestamp(
  chain: ChainId,
  timestamp: bigint
): Promise<bigint> {
  // do a binary search to find the block number
  // we should return the block right before the timestamp (or the block with the timestamp)

  const client = createRpcClient(chain);

  let start = 0n;
  let end = await client.getBlockNumber();

  while (true) {
    const mid = (start + end) / 2n;
    const block = await client.getBlock({ blockNumber: mid });

    if (block.timestamp === timestamp) {
      return mid;
    } else if (block.timestamp < timestamp) {
      start = mid + 1n;
    } else {
      end = mid - 1n;
    }

    if (start > end) {
      return end;
    }
  }
}

export async function writeIncentivesToFile(
  stakerIncentives: Map<Address, bigint>,
  blockRanges: NetworkConfig[],
  filePath: string
) {
  const incentivesArray = Array.from(stakerIncentives.entries()).map(
    ([address, incentive]) => ({ address, incentive: incentive.toString() })
  );

  // convert block numbers to string for JSON serialization
  const blockRangesForJson = blockRanges.map(
    ({ network, startBlock, endBlock }) => ({
      network,
      startBlock: startBlock!.toString(),
      endBlock: endBlock!.toString(),
    })
  );

  const data = {
    blockRanges: blockRangesForJson,
    stakerIncentives: incentivesArray,
  };
  const json = JSON.stringify(data, null, 2);

  try {
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    console.log(`Incentives written to ${filePath}`);
    convertIncentivesFileToExcel(data);
  } catch (err) {
    console.error(`Error writing to file: ${err}`);
  }
}

function convertIncentivesFileToExcel(data: any) {
  // Process data to include the new column with formatted values
  const stakerIncentives = data.stakerIncentives.map(
    (entry: { address: string; incentive: number }) => ({
      address: entry.address,
      "incentive - script output": Number(entry.incentive),
      "incentive (TEL)": Number(entry.incentive) / 100,
    })
  );

  // Calculate totals
  const totalIncentive = stakerIncentives.reduce(
    (sum: number, entry: { [x: string]: number }) =>
      sum + entry["incentive - script output"],
    0
  );
  const totalIncentiveTel = stakerIncentives.reduce(
    (sum: number, entry: { [x: string]: number }) =>
      sum + entry["incentive (TEL)"],
    0
  );

  // Add total row
  stakerIncentives.push({
    address: "Total",
    "incentive - script output": totalIncentive,
    "incentive (TEL)": totalIncentiveTel.toLocaleString(),
  });

  // Convert processed data to worksheet
  const stakerIncentivesSheet = xlsx.utils.json_to_sheet(stakerIncentives);

  // Define output file
  const outputFile = "staker_incentives.xlsx";
  let workbook;

  // Check if file exists and load it, otherwise create a new workbook
  if (fs.existsSync(outputFile)) {
    workbook = xlsx.readFile(outputFile);
  } else {
    workbook = xlsx.utils.book_new();
  }

  // Generate sheet name based on block range
  const sheetName = `Blocks ${data.blockRanges[0].startBlock} - ${data.blockRanges[0].endBlock}`;

  // Remove existing sheet if it exists
  if (workbook.Sheets[sheetName]) {
    delete workbook.Sheets[sheetName];
    workbook.SheetNames = workbook.SheetNames.filter(
      (name) => name !== sheetName
    );
  }

  // Append new sheet
  xlsx.utils.book_append_sheet(workbook, stakerIncentivesSheet, sheetName);

  // Save workbook
  xlsx.writeFile(workbook, outputFile);

  console.log(`Excel file updated/saved as ${outputFile}`);
}

export function calculateIncentivesFromVolumeOrSimilar(
  mapping: Map<viem.Address, bigint>,
  totalIncentive: bigint
) {
  const cappedIncentivesPerAccount = new Map<viem.Address, bigint>();
  const totalVolume = [...mapping.values()].reduce(
    (acc, volume) => acc + volume,
    0n
  );
  for (const [address, volume] of mapping) {
    // identify address's share of the total incentive using its share of volume
    let addressIncentive = (volume / totalVolume) * totalIncentive;

    cappedIncentivesPerAccount.set(address, addressIncentive);
  }
  return cappedIncentivesPerAccount;
}

export function addMaps(mappings: Map<viem.Address, bigint>[]) {
  const newMap = new Map<viem.Address, bigint>();
  for (const mapping of mappings) {
    for (const [address, volume] of mapping) {
      newMap.set(address, (newMap.get(address) ?? 0n) + volume);
    }
  }
  return newMap;
}

export function unorderedArraysEqual<T>(a: T[], b: T[]) {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((item) => b.includes(item));
}

/**
 * test helpers
 */

export function getRandomBigInt(min: number, max: number): bigint {
  if (min > max) {
    throw new Error("min value more than max value");
  }

  const range = max - min;
  const randomValue = randomInt(range + 1); // inclusive of max

  return BigInt(randomValue + min);
}

// can be used to generate random hex types such as `bytes32` or `address`
export function generateMockHex(
  length: number,
  endDigits: number,
  isStaker?: boolean
) {
  const padDigit = isStaker ? "1" : "0";
  return `0x${endDigits.toString(16).padStart(40, padDigit)}` as `0x${string}`;
}

export function generateRandomReferralRelationships(
  users: Address[],
  isStaker?: boolean
): Map<Address, Address[]> {
  const referralRelationships = new Map<Address, Address[]>();
  const availableReferees = new Set(users);

  for (const referrer of users) {
    const referees: Address[] = [];
    const numReferees = Math.floor(Math.random() * (users.length / 2));

    for (let i = 0; i < numReferees; i++) {
      if (availableReferees.size === 0) break;

      const refereeArray = Array.from(availableReferees);
      const referee =
        refereeArray[Math.floor(Math.random() * refereeArray.length)];

      if (referrer !== referee) {
        referees.push(referee);
        availableReferees.delete(referee);
      }
    }

    if (referees.length > 0) {
      referralRelationships.set(referrer, referees);
    }
  }

  return referralRelationships;
}

// mock template for the DefiSwap struct
export const mockDefiSwap = {
  defiSafe: zeroAddress, // not used
  aggregator: zeroAddress, // not used
  plugin: zeroAddress, // not used
  feeToken: zeroAddress, // not used
  referrer: zeroAddress, // will be replaced
  referralFee: 0n, // will be replaced in `calculateRewardsPerUser` e2e test
  walletData: "0x" as `0x${string}`, // not used
  swapData: "0x" as `0x${string}`, // not used
};
