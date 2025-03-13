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
import { UserRewardEntry } from "calculators/ICalculator";
import { addressResolverAbi } from "viem/_types/constants/abis";

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
  startBlock: bigint;
  endBlock: bigint;
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
    if (!blockRange) {
      console.error(
        `Invalid blockRange specified for ${network}: ${blockRange}`
      );
    }

    let startBlock: bigint | undefined;
    let endBlock: bigint | undefined;
    const [startBlockStr, endBlockStr] = blockRange.split(":");

    if (startBlockStr && !isNaN(Number(startBlockStr))) {
      startBlock = BigInt(startBlockStr);
    } else {
      console.error(
        `Invalid start block specified for ${network}: ${blockRange}`
      );
      process.exit(1);
    }

    if (endBlockStr && !isNaN(Number(endBlockStr))) {
      endBlock = BigInt(endBlockStr);
    } else {
      console.error(
        `Invalid end block specified for ${network}: ${blockRange}`
      );
      process.exit(1);
    }

    networkConfigs.push({ network: networkLowerCase, startBlock, endBlock });
  });

  if (networkConfigs.length === 0) {
    console.log(
      "Enter network configurations in the format `network=startBlock:endBlock` and separate multiple networks by space. Eg usage: `yarn start polygon=666000:667000` or `yarn start polygon=666000:667000 mainnet=100000:110000`"
    );

    process.exit(1);
  }

  return networkConfigs;
}

export async function validateStartAndEndBlocks(
  networkConfigs: NetworkConfig[]
) {
  for (const networkConfig of networkConfigs) {
    let chainId;
    let period0StartBlock;

    if (networkConfig.network === "polygon") {
      chainId = ChainId.Polygon;
      period0StartBlock = 68093124n;
    } else if (networkConfig.network === "mainnet") {
      chainId = ChainId.Mainnet;
      // TANIP-1 is not currently live on mainnet
      period0StartBlock = 0n;
    } else {
      console.error(`Unsupported network: ${networkConfig.network}`);
      process.exit(1);
    }

    const [lastSettlementBlock, latestBlock] =
      await getLastSettlementBlockAndLatestBlock(chainId);

    // startBlock must match history contract's lastSettlementBlock + 1 or period 0 startBlock
    if (
      networkConfig.startBlock !== lastSettlementBlock + 1n &&
      networkConfig.startBlock !== period0StartBlock
    ) {
      console.error(
        `${networkConfig.network} startBlock ${networkConfig.network} must be last settlement block + 1 or period 0 block`
      );
      process.exit(1);
    }
    // endBlock must be deeper than reorgSafeDepth
    if (networkConfig.endBlock > latestBlock - config.reorgSafeDepth[chainId]) {
      console.error("Polygon endBlock must be reorg safe");
      process.exit(1);
    }
  }
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
  stakerIncentives: Map<Address, UserRewardEntry>,
  blockRanges: NetworkConfig[],
  filePath: string
) {
  // serialize UserRewardEntrys
  const incentivesArray = Array.from(stakerIncentives.entries()).map(
    ([address, userRewardEntry]) => ({
      address,
      reward: userRewardEntry.reward.toString(),
      metadata: {
        uncappedAmount: userRewardEntry.metadata.uncappedAmount!.toString(),
        fees: userRewardEntry.metadata.fees.toString(),
        refereeFees: userRewardEntry.metadata.refereeFees.toString(),
      },
    })
  );

  // convert block numbers to string for JSON serialization
  const blockRangesForJson = blockRanges.map(
    ({ network, startBlock, endBlock }) => ({
      network,
      startBlock: startBlock.toString(),
      endBlock: endBlock.toString(),
    })
  );

  const data = {
    blockRanges: blockRangesForJson,
    stakerIncentives: incentivesArray,
  };
  const json = JSON.stringify(data, null, 2) + "\n";

  try {
    await writeFile(filePath, json, "utf8");
    console.log(`Incentives written to ${filePath}`);
  } catch (err) {
    console.error(`Error writing to file: ${err}`);
  }
}

export function writeIncentivesToExcel(
  stakerIncentives: Map<Address, UserRewardEntry>,
  blockRanges: NetworkConfig[],
  filePath: string
) {
  // Process data to include the new column with formatted values
  const data = Array.from(stakerIncentives.entries()).map(
    ([address, userRewardEntry]) => ({
      "Staker Address": address,
      "Reward (ERC20 TEL)": (
        Number(userRewardEntry.reward) / 100
      ).toLocaleString(),
      "Uncapped Reward (ERC20 TEL)": (
        Number(userRewardEntry.metadata.uncappedAmount) / 100
      ).toLocaleString(),
      "Staker Fees": (
        Number(userRewardEntry.metadata.fees) / 100
      ).toLocaleString(),
      "Referee Fees": (
        Number(userRewardEntry.metadata.refereeFees) / 100
      ).toLocaleString(),
    })
  );

  const totals = data.reduce(
    (accumulator: any, entry: any) => {
      accumulator.totalRewardERC20 += Number(
        entry["Reward (ERC20 TEL)"].replace(/,/g, "")
      );
      accumulator.totalUncappedIssuance += Number(
        entry["Uncapped Reward (ERC20 TEL)"].replace(/,/g, "")
      );
      accumulator.totalFees += Number(entry["Staker Fees"].replace(/,/g, ""));
      accumulator.totalRefereeFees += Number(
        entry["Referee Fees"].replace(/,/g, "")
      );
      return accumulator;
    },
    {
      totalRewardERC20: 0,
      totalUncappedIssuance: 0,
      totalFees: 0,
      totalRefereeFees: 0,
    }
  );

  // Add total row
  data.push({
    "Staker Address": "Total" as `0x${string}`,
    "Reward (ERC20 TEL)": totals.totalRewardERC20.toLocaleString(),
    "Uncapped Reward (ERC20 TEL)":
      totals.totalUncappedIssuance.toLocaleString(),
    "Staker Fees": totals.totalFees.toLocaleString(),
    "Referee Fees": totals.totalRefereeFees.toLocaleString(),
  });

  // Convert processed data to worksheet
  const stakerIncentivesSheet = xlsx.utils.json_to_sheet(data);
  // Adjust column widths for better readability
  const cols = [
    { wch: 20 }, // Staker Address
    { wch: 15 }, // Reward (ERC20 TEL)
    { wch: 20 }, // Uncapped Reward (ERC20 TEL)
    { wch: 10 }, // Staker Fees
    { wch: 15 }, // Referee Fees
  ];
  stakerIncentivesSheet["!cols"] = cols;

  // Check if file exists and load it, otherwise create a new workbook
  let workbook;
  if (fs.existsSync(filePath)) {
    workbook = xlsx.readFile(filePath);
  } else {
    workbook = xlsx.utils.book_new();
  }

  // Generate sheet name based on block range. Not currently configured for multichain block ranges
  const sheetName = `Blocks ${blockRanges[0].startBlock} - ${blockRanges[0].endBlock}`;

  // Remove existing sheet if it exists
  if (workbook.Sheets[sheetName]) {
    delete workbook.Sheets[sheetName];
    workbook.SheetNames = workbook.SheetNames.filter(
      (name: string) => name !== sheetName
    );
  }

  // Append new sheet
  xlsx.utils.book_append_sheet(workbook, stakerIncentivesSheet, sheetName);

  // Save workbook
  xlsx.writeFile(workbook, filePath);

  console.log(`Excel file updated/saved as ${filePath}`);
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
