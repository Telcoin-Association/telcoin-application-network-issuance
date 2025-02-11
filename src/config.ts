import * as dotenv from "dotenv";
dotenv.config();

import { Address, getAddress } from "viem";
import { mainnet, polygon } from "viem/chains";

// TODO: add Telcoin Network to the list of supported chains and to the ChainId enum
// see: https://viem.sh/docs/clients/chains.html#build-your-own
export enum ChainId {
  Polygon = 137,
  Mainnet = 1,
}

export type Token = {
  address: Address;
  decimals: bigint;
  chain: ChainId;
};

export const config = {
  reorgSafeDepth: { [ChainId.Polygon]: 500n, [ChainId.Mainnet]: 64n },
  blocksSyncTimer: 10000, // 10 seconds
  chains: [polygon, mainnet], // TODO: add Telcoin Network to the list of supported chains (mainnet can be replaced, tests require >=2 chains)
  canonicalDecimals: 18n, // Amounts are scaled to this number of decimals
  blocksSyncBatchSize: 50, // number of blocks to sync in each batch in sync.ts
  weekZeroStartTimestamp: 1684348360n, // timestamp of the start of week zero
  secondsPerWeek: 604800n, // number of seconds in a week
  incentivesAmounts: {
    telcoinNetworkGasFeesIncentivesAmount: 100000000n,
    developerIncentivesAmount: 100000000n,
    stakerIncentivesAmount: 320512820n,
  },
  simplePlugins: {
    // list of SimplePlugins, for use with the DeveloperIncentivesCalculator
    [ChainId.Polygon]: [
      getAddress("0xe24f8d36405704e85945a639fdaCEc47bA2a7c88"),
      getAddress("0x2f3378850a8fD5a0428a3967c2Ef6aAA025a4E1D"),
    ],
  },
  rpcUrls: {
    [ChainId.Polygon]:
      process.env.POLYGON_RPC_URL ||
      (() => {
        throw new Error("POLYGON_RPC_URL environment variable is not set");
      })(),
    [ChainId.Mainnet]:
      process.env.MAINNET_RPC_URL ||
      (() => {
        throw new Error("MAINNET_RPC_URL environment variable is not set");
      })(),
    // [ChainId.TelcoinNetwork]: ...
  },
  telToken: {
    [ChainId.Polygon]: {
      address: getAddress("0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32"),
      decimals: 2n,
      chain: ChainId.Polygon,
    },
    [ChainId.Mainnet]: {
      address: getAddress("0x467Bccd9d29f223BcE8043b84E8C8B282827790F"),
      decimals: 2n,
      chain: ChainId.Mainnet,
    },
    /*
    [ChainId.TelcoinNetwork]: {
      address: getAddress(""), // use WTEL
      decimals: 2n,
      chain: ChainId.TelcoinNetwork,
    }, 
   */
  },
} as const;
