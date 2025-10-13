import { Address, Hash, Transaction } from "viem";
import { ICalculator } from "./ICalculator";
import { BaseBlocksDatabase } from "../datasources/persistent/BlocksDatabase";
import {
  BaseSimplePlugin,
  ClaimableIncreasedEvent,
} from "../datasources/SimplePlugin";
import { BaseExecutorRegistry } from "../datasources/ExecutorRegistry";
import {
  addMaps,
  calculateIncentivesFromVolumeOrSimilar,
  scaleDecimals,
  unorderedArraysEqual,
} from "../helpers";
import { ChainId, config } from "../config";

function getTelTokenDecimals(chain: ChainId): bigint {
  const telTokens = config.telToken as Record<number, { decimals: bigint }>;
  const entry = telTokens[chain];
  if (!entry) {
    throw new Error(`TEL token decimals not configured for chain ${chain}`);
  }
  return entry.decimals;
}

/**
 * This class calculates TAN developers' referrals incentives.
 *
 * If an executor of a developer initiates a transaction that increases the claimable amount of any staker,
 * it counts toward the referrals incentives of the developer.
 *
 * This class works across multiple chains.
 */
export class DeveloperIncentivesCalculator implements ICalculator<bigint> {
  /**
   * Constructor
   * @param _blocksDbs Blocks databases for each chain
   * @param _simplePlugins Simple plugins
   * @param _executorRegistry Executor registry
   * @param _totalIncentiveAmount Total amount of incentives to be distributed
   * @param _startBlocks Start blocks per chain (inclusive)
   * @param _endBlocks End blocks per chain (inclusive)
   */
  constructor(
    private readonly _blocksDbs: BaseBlocksDatabase[],
    private readonly _simplePlugins: BaseSimplePlugin[],
    private readonly _executorRegistry: BaseExecutorRegistry,
    private readonly _totalIncentiveAmount: bigint,
    private readonly _startBlocks: Partial<{ [chain in ChainId]: bigint }>,
    private readonly _endBlocks: Partial<{ [chain in ChainId]: bigint }>
  ) {
    const blocksChains = _blocksDbs.map((db) => db.chain);
    const simplePluginsChains = _simplePlugins.map((plugin) => plugin.chain);
    if (!simplePluginsChains.every((chain) => blocksChains.includes(chain)))
      throw new Error(
        "Blocks databases and simple plugins must be for the same chains"
      );

    // make sure there are start and end blocks for each block database
    if (Object.keys(_startBlocks).length !== _blocksDbs.length)
      throw new Error("Start blocks must be specified for each block database");
    if (!blocksChains.every((chain) => _startBlocks[chain] !== undefined))
      throw new Error("Start blocks must be specified for each block database");
  }

  /**
   * @returns A map of developer addresses to the amount of referrals paid in transactions initiated by their executors
   * @dev First identifies the set of executor addresses from `ExecutorRegistry`
   * @dev Then fetches all executors' transactions within `[startBlock:endBlock]` range
   * @dev Maps each executor address to its `Transaction`s
   * @dev Also maps each `Transaction` hash to its executor address (`== tx.origin`)
   * @dev Fetches `SimplePlugin::claimableIncreased` events to get referrals and amounts (`newClaimable - oldClaimable`)
   * @dev Finally maps each developer to its number of referrals
   * @returns `referralsPerDeveloper` Intended to be passed to `calculateIncentivesFromVolumeOrSimilar()`
   */
  async calculateReferralsPerDeveloper(): Promise<Map<Address, bigint>> {
    // fetch set of executor addresses from the executor registry
    const executorSet = new Set<Address>(
      this._executorRegistry.executors.map((executor) => executor.address)
    );

    // get all tx hashes of all executor EOAs
    const txsPerEOA = new Map<Address, Transaction[]>();
    for (const db of this._blocksDbs) {
      // fetch all executors' transactions within `[startBlock:endBlock]` range
      const txMap = await db.getTransactionsOfEOASet(
        executorSet,
        this._startBlocks[db.chain]!,
        this._endBlocks[db.chain]!
      );

      // populate `txsPerEOA` by mapping each EOA to all its transactions
      for (const [eoa, txs] of txMap.entries()) {
        if (!txsPerEOA.has(eoa)) {
          txsPerEOA.set(eoa, []);
        }
        txsPerEOA.get(eoa)!.push(...txs);
      }
    }

    // pull all tx hashes from `txsPerEOA` into separate set
    const txHashes = new Set<Hash>();
    txsPerEOA.forEach((txs) => txs.forEach((tx) => txHashes.add(tx.hash)));

    // make a map of txHash to executor address
    const txHashToExecutorAddr = new Map<Hash, Address>();
    for (const [executorAddr, txs] of txsPerEOA.entries()) {
      for (const tx of txs) {
        txHashToExecutorAddr.set(tx.hash, executorAddr);
      }
    }

    // map each developer to its number of referrals this week
    const referralsPerDeveloper = new Map<Address, bigint>();
    for (const plugin of this._simplePlugins) {
      await plugin.init();

      // get all claimable increased events (referrals) with tx hashes in txHashes
      const claimableIncreasedEvents =
        plugin.getEventsCorrespondingToTxHashSet(txHashes);

      // process each event to identify claimable amount delta in referrals
      for (const event of claimableIncreasedEvents) {
        const telTokenDecimals = getTelTokenDecimals(plugin.chain);
        const amount = scaleDecimals(
          event.newClaimable - event.oldClaimable,
          telTokenDecimals,
          config.canonicalDecimals
        );

        const executorAddr = txHashToExecutorAddr.get(event.txHash);
        if (executorAddr === undefined)
          throw new Error(
            `txHash ${event.txHash} not found in txHashToExecutorAddr`
          );

        const developerAddress =
          this._executorRegistry.getExecutorFromAddress(
            executorAddr
          ).developerAddress;
        const prevReferrals = referralsPerDeveloper.get(developerAddress) ?? 0n;

        // set new referral amount
        referralsPerDeveloper.set(developerAddress, prevReferrals + amount);
      }
    }

    return referralsPerDeveloper;
  }

  /**
   * @returns A map of developer addresses to the amount of incentives they should receive
   */
  async calculate(): Promise<Map<Address, bigint>> {
    return calculateIncentivesFromVolumeOrSimilar(
      await this.calculateReferralsPerDeveloper(),
      this._totalIncentiveAmount
    );
  }
}
