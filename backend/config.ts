import * as dotenv from "dotenv";
dotenv.config();

import { Address, getAddress, zeroAddress } from "viem";
import { base, mainnet, polygon } from "viem/chains";

/**
 * TelcoinV3 on Polygon, the reward token TAN issuance settles in after the V3 cutover.
 *
 * TODO: fill in once TelcoinV3 is deployed to Polygon. `assertTelTokensConfigured` rejects a period
 * run while this is unset, so an unconfigured value cannot silently produce an empty reward set.
 */
const POLYGON_TEL_V3: Address = zeroAddress;

// TODO: add Telcoin Network to the list of supported chains and to the ChainId enum
// see: https://viem.sh/docs/clients/chains.html#build-your-own
export enum ChainId {
  Polygon = 137,
  Mainnet = 1,
  Base = 8453,
}

export type Token = {
  address: Address;
  decimals: bigint;
  chain: ChainId;
};

export const config = {
  reorgSafeDepth: {
    [ChainId.Polygon]: 500n,
    [ChainId.Mainnet]: 64n,
    [ChainId.Base]: 300n,
  },
  blocksSyncTimer: 10000, // 10 seconds
  chains: [polygon, mainnet, base], // TODO: add Telcoin Network to the list of supported chains (mainnet can be replaced, tests require >=2 chains)
  canonicalDecimals: 18n, // Amounts are scaled to this number of decimals
  blocksSyncBatchSize: 50, // number of blocks to sync in each batch in sync.ts
  weekZeroStartTimestamp: 1684348360n, // timestamp of the start of week zero
  secondsPerWeek: 604800n, // number of seconds in a week
  incentivesAmounts: {
    telcoinNetworkGasFeesIncentivesAmount: 100000000n,
    developerIncentivesAmount: 100000000n,
    // 3,205,128.20 TEL per period, denominated in the 18-decimal reward token
    stakerIncentivesAmount: 320512820n * 10n ** 16n,
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
    [ChainId.Base]: process.env.BASE_RPC_URL,
  },
  telToken: {
    [ChainId.Polygon]: {
      address: POLYGON_TEL_V3,
      decimals: 18n,
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

/**
 * The TEL token for a chain, or a thrown error if that chain has none configured.
 *
 * `ChainId` covers more chains than TEL is deployed on, so indexing `config.telToken` directly with
 * an arbitrary `ChainId` is not type-safe.
 */
export function telTokenFor(chain: ChainId): Token {
  const token = (config.telToken as Partial<Record<ChainId, Token>>)[chain];
  if (token === undefined) {
    throw new Error(`No TEL token is configured for chain ${chain}`);
  }

  return token;
}

/**
 * Throws unless every configured TEL token has a real address behind it.
 *
 * Called at the start of a period run so that an unconfigured deployment fails immediately rather
 * than silently matching zero transfers and producing an empty reward set.
 */
export function assertTelTokensConfigured(): void {
  for (const token of Object.values(config.telToken) as Token[]) {
    if (token.address === zeroAddress) {
      throw new Error(
        `TEL token address for chain ${token.chain} is unset. ` +
          `Populate it in backend/config.ts from the deployment before running a period.`,
      );
    }
  }
}
