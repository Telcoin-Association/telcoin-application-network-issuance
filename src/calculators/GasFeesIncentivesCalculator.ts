// this calculator is used to calculate the Telcoin Network gas fees incentives for developers

import { Address } from "viem";
import { BaseExecutorRegistry } from "../datasources/ExecutorRegistry";
import { ICalculator } from "./ICalculator";
import { BaseBlocksDatabase } from "../datasources/persistent/BlocksDatabase";
import { BaseTransactionReceiptsDatabase } from "../datasources/persistent/TransactionReceiptsDatabase";
import { calculateIncentivesFromVolumeOrSimilar } from "../helpers";

/**
 * This calculator is used to calculate the Telcoin Network gas fees incentives for developers
 * Each developer gets a share of the total incentives based on the amount of gas fees paid by their executors
 * It is not relevant at the moment as Telcoin Network has not yet launched mainnet but kept here for future use
 */

/*
  Example instantiation of tx receipts database taken from app.ts
  transaction receipts databases fetch and store transaction receipts on disk.
  This is necessary for calculating the gas fees incentives.

  console.log("Initializing transaction receipts databases...");
  const telcoinNetworkTransactionReceiptsDatabase = new TransactionReceiptsDatabase(ChainId.TelcoinNetwork);`
*/

export class GasFeesIncentivesCalculator implements ICalculator<bigint> {
  /**
   * Constructor
   * @param _executorRegistry Executor registry
   * @param _blocksDb Blocks database
   * @param _transactionReceiptsDb Transaction receipts database
   * @param _totalIncentiveAmount Total amount of incentives to be distributed
   * @param _startBlock Start block (inclusive)
   * @param _endBlock End block (inclusive)
   */
  constructor(
    private readonly _executorRegistry: BaseExecutorRegistry,
    private readonly _blocksDb: BaseBlocksDatabase,
    private readonly _transactionReceiptsDb: BaseTransactionReceiptsDatabase,
    private readonly _totalIncentiveAmount: bigint,
    private readonly _startBlock: bigint,
    private readonly _endBlock: bigint
  ) {}

  /**
   * @returns A map of developer addresses to the amount of gas fees paid by their executors
   */
  async calculateGasPaidPerDeveloper(): Promise<Map<Address, bigint>> {
    // create eoa set
    const eoaSet = new Set(
      this._executorRegistry.executors.map((executor) => executor.address)
    );

    // get transaction hashes for all executors
    const transactions = await this._blocksDb.getTransactionsOfEOASet(
      eoaSet,
      this._startBlock,
      this._endBlock
    );

    // get transaction receipts for all transaction hashes for each executor and total up gas fees paid by each developer
    const gasPaidPerDeveloper = new Map<Address, bigint>();
    for (const [eoa, txs] of transactions) {
      const devAddr =
        this._executorRegistry.getExecutorFromAddress(eoa).developerAddress;

      let totalGasPaid = 0n;
      for (const tx of txs) {
        const receipt = await this._transactionReceiptsDb.getValue(tx.hash);
        totalGasPaid += receipt.gasUsed * receipt.effectiveGasPrice;
      }

      const prevGasPaidByDeveloper = gasPaidPerDeveloper.get(devAddr) ?? 0n;
      gasPaidPerDeveloper.set(devAddr, totalGasPaid + prevGasPaidByDeveloper);
    }

    return gasPaidPerDeveloper;
  }

  /**
   * @returns A map of developer addresses to the amount of incentives they should receive
   */
  async calculate(): Promise<Map<Address, bigint>> {
    return calculateIncentivesFromVolumeOrSimilar(
      await this.calculateGasPaidPerDeveloper(),
      this._totalIncentiveAmount
    );
  }
}
