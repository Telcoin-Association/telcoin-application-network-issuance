import * as dotenv from "dotenv";
dotenv.config();

import { Address, getAddress, zeroAddress } from "viem";
import { base, mainnet, polygon, sepolia } from "viem/chains";

/**
 * TelcoinV3 on Polygon, the reward token TAN issuance settles in after the V3 cutover.
 *
 * Deployed at the same address on every chain tel-v3 targets; see `deployments/polygon.json` in
 * tel-v3.
 */
const POLYGON_TEL_V3: Address = getAddress(
  "0x7E13B43065380aCdeC1c2d138c579cbBbafA0731",
);

/**
 * Legacy 2-decimal TEL on Polygon.
 *
 * The live AmirX contracts hardcode this token as `TELCOIN`, so it is still what user fees arrive
 * in even though rewards settle in TelcoinV3. Fee volume is detected against `config.feeToken`, which
 * points here until AmirX is upgraded to collect TelcoinV3.
 */
const POLYGON_TEL_V2: Address = getAddress(
  "0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32",
);

/**
 * TelcoinV3 on Ethereum Sepolia.
 *
 * Sepolia carries a full V3 `StakingModule` and `SimplePlugin` stack with a history we own, so it is
 * where the V3 issuance path is rehearsed ahead of Polygon. See `deployments/eth-sepolia.json`.
 */
const ETH_SEPOLIA_TEL_V3: Address = getAddress(
  "0x6B46d2f2a27f16dC1ef29a71C38A7E274132C7E7",
);

// TODO: add Telcoin Network to the list of supported chains and to the ChainId enum
// see: https://viem.sh/docs/clients/chains.html#build-your-own
export enum ChainId {
  Polygon = 137,
  Mainnet = 1,
  Base = 8453,
  EthSepolia = 11155111,
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
    [ChainId.EthSepolia]: 64n,
  },
  blocksSyncTimer: 10000, // 10 seconds
  chains: [polygon, mainnet, base, sepolia], // TODO: add Telcoin Network to the list of supported chains (mainnet can be replaced, tests require >=2 chains)
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
    // `SimplePlugin_AMIRX`, the V3 referral plugin. The datasource decodes the V3
    // `ClaimableIncreased(address,uint256)` event and scales by the 18-decimal reward token, so only
    // V3 plugins belong here.
    [ChainId.Polygon]: [
      getAddress("0x5731ab138f5eb41dd62C722AeF8Bf3BE26cafEe5"),
    ],
    // the single V3 plugin registered on the Sepolia StakingModule
    [ChainId.EthSepolia]: [
      getAddress("0xEBeca686a6B7CAb725C75C3b7A2b49b839Ecd416"),
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
    [ChainId.EthSepolia]: process.env.ETH_SEPOLIA_RPC_URL,
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
    [ChainId.EthSepolia]: {
      address: ETH_SEPOLIA_TEL_V3,
      decimals: 18n,
      chain: ChainId.EthSepolia,
    },
    /*
    [ChainId.TelcoinNetwork]: {
      address: getAddress(""), // use WTEL
      decimals: 2n,
      chain: ChainId.TelcoinNetwork,
    },
   */
  },
  /**
   * The token AmirX collects user fees in, per chain. Fee volume is detected as transfers of this
   * token into AmirX.
   *
   * This is kept apart from `telToken` because the two move independently: rewards settle in
   * TelcoinV3 as soon as the V3 plugin is live, while fees stay in whatever token the deployed AmirX
   * hardcodes until AmirX itself is upgraded. Staker rewards are a share of fee volume, so the fee
   * token's decimals cancel out of the reward math.
   */
  feeToken: {
    [ChainId.Polygon]: {
      address: POLYGON_TEL_V2,
      decimals: 2n,
      chain: ChainId.Polygon,
    },
    [ChainId.Mainnet]: {
      address: getAddress("0x467Bccd9d29f223BcE8043b84E8C8B282827790F"),
      decimals: 2n,
      chain: ChainId.Mainnet,
    },
    // the rehearsal's MockAmirX moves TelcoinV3, so fees and rewards share a token there
    [ChainId.EthSepolia]: {
      address: ETH_SEPOLIA_TEL_V3,
      decimals: 18n,
      chain: ChainId.EthSepolia,
    },
  },
} as const;

/**
 * The TEL reward token for a chain, or a thrown error if that chain has none configured.
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
 * The token AmirX collects user fees in on a chain, or a thrown error if that chain has none.
 */
export function feeTokenFor(chain: ChainId): Token {
  const token = (config.feeToken as Partial<Record<ChainId, Token>>)[chain];
  if (token === undefined) {
    throw new Error(`No fee token is configured for chain ${chain}`);
  }

  return token;
}

/**
 * Throws unless both the reward token and the fee token for every chain in `chains` have a real
 * address behind them.
 *
 * Called at the start of a period run so that an unconfigured deployment fails immediately rather
 * than silently matching zero transfers and producing an empty reward set. Scoped to the chains the
 * run actually touches, so a chain still awaiting its V3 deployment does not block a run elsewhere.
 */
export function assertTelTokensConfigured(chains: ChainId[]): void {
  for (const chain of chains) {
    for (const [role, token] of [
      ["TEL reward token", telTokenFor(chain)],
      ["fee token", feeTokenFor(chain)],
    ] as const) {
      if (token.address === zeroAddress) {
        throw new Error(
          `The ${role} address for chain ${token.chain} is unset. ` +
            `Populate it in backend/config.ts from the deployment before running a period.`,
        );
      }
    }
  }
}

/**
 * Maps a `network=start:end` CLI network name onto its `ChainId`.
 *
 * Accepted names are the viem chain names in `config.chains`, lowercased, plus the aliases below.
 * `mainnet` is an alias because viem names chain 1 "Ethereum" while this repo has always called it
 * mainnet, and `eth-sepolia` matches the naming the staking deployments use.
 */
export function chainIdForNetwork(network: string): ChainId | undefined {
  const normalized = network.toLowerCase();

  const aliases: Record<string, ChainId> = {
    mainnet: ChainId.Mainnet,
    "eth-sepolia": ChainId.EthSepolia,
  };
  if (normalized in aliases) return aliases[normalized];

  const chain = config.chains.find(
    (candidate) => candidate.name.toLowerCase() === normalized,
  );

  return chain?.id as ChainId | undefined;
}

/**
 * The block a chain's first TANIP-1 period opened at.
 *
 * `validateStartAndEndBlocks` accepts a run starting here as well as one continuing from the history
 * contract's `lastSettlementBlock`, which is what lets a fresh deployment be settled from scratch.
 */
export const period0StartBlocks: Partial<Record<ChainId, bigint>> = {
  [ChainId.Polygon]: 68_093_124n,
  // TANIP-1 is not live on mainnet
  [ChainId.Mainnet]: 0n,
  // the Sepolia rehearsal history is deployed fresh, so its first period opens wherever we choose
  [ChainId.EthSepolia]: 0n,
};
