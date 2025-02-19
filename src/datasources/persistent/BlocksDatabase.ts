import { Level } from "level";
import { Address, Block, PublicClient, Transaction, getAddress } from "viem";
import { createRpcClient, jsonParse, jsonStringify } from "../../helpers";
import { BaseDatabase } from "./BaseDatabase";
import { ChainId } from "../../config";

/**
 * This class represents a database that stores blocks.
 *
 * It can fetch and store blocks from the blockchain.
 *
 * Addresses in the blocks are NOT checksummed.
 */
export abstract class BaseBlocksDatabase extends BaseDatabase<bigint, Block> {
  constructor(readonly chain: ChainId) {
    super();
  }

  /**
   * Fetch and store a range of blocks
   * @param startBlock Start block (inclusive)
   * @param endBlock End block (inclusive)
   */
  async sync(startBlock: bigint, endBlock: bigint) {
    // TODO: this can be optimized by fetching multiple blocks at once.
    for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
      await this.fetchAndStore(blockNum);
    }
  }

  /**
   * @param eoa EOA address; need not be checksummed
   * @param startBlock Start block (inclusive)
   * @param endBlock End block (inclusive)
   * @returns All transactions initiated by the EOA in the given block range
   */
  async getTransactionsOfEOA(
    eoa: Address,
    startBlock: bigint,
    endBlock: bigint
  ) {
    // handle eoa address checksum
    eoa = getAddress(eoa);
    const transactions: Transaction[] = [];
    for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
      const block = await this.getValue(blockNum);
      for (const tx of block.transactions as Transaction[]) {
        if (getAddress(tx.from) === eoa) {
          transactions.push(tx);
        }
      }
    }
    return transactions;
  }

  /**
   * @param eoas Set of EOA addresses; need not be checksummed
   * @param startBlock Start block (inclusive)
   * @param endBlock End block (inclusive)
   * @returns A map of EOA addresses to all transactions initiated by them in the given block range
   */
  async getTransactionsOfEOASet(
    eoas: Set<Address>,
    startBlock: bigint,
    endBlock: bigint
  ): Promise<Map<Address, Transaction[]>> {
    // handle checksumming of provided addresses
    const checksummedEOAs = new Set<Address>();
    for (const eoa of eoas) {
      checksummedEOAs.add(getAddress(eoa));
    }
    eoas = checksummedEOAs;

    const transactions = new Map<Address, Transaction[]>();
    for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
      const block = await this.getValue(blockNum);
      for (const tx of block.transactions as Transaction[]) {
        const from = getAddress(tx.from);
        if (eoas.has(from)) {
          // initialize empty map value for matching `tx.from` if it doesn't yet exist
          if (!transactions.has(from)) {
            transactions.set(from, []);
          }
          // push relevant tx to (now existing) map value
          transactions.get(from)!.push(tx);
        }
      }
    }

    return transactions;
  }
}

/**
 * Fetches and stores blocks from the blockchain.
 *
 * Addresses in the blocks are NOT checksummed.
 */
export class BlocksDatabase extends BaseBlocksDatabase {
  readonly DB_NAME: string;
  private readonly _db: Level<string, string>;
  public client: PublicClient;

  constructor(readonly chain: ChainId, client?: PublicClient) {
    super(chain);
    this.DB_NAME = `db/${this.chain}/blocks`;
    this._db = new Level(this.DB_NAME, { valueEncoding: "json" });
    this.client = client || createRpcClient(this.chain);
  }

  protected getFromStore(key: string): Promise<string> {
    return this._db.get(key);
  }
  protected putToStore(key: string, val: string): Promise<void> {
    return this._db.put(key, val);
  }

  /// @dev Used to pull blocks from the blockchain client
  /// @notice Invoked only when the database detects a key it does not have, ie a newer block number
  protected fetchData(blockNumber: bigint): Promise<Block> {
    return this.client.getBlock({ blockNumber, includeTransactions: true });
  }

  /// Close the database connection.
  async close(): Promise<void> {
    try {
      await this._db.close();
    } catch (error) {
      console.error(`Error closing blocks database for chain ${this.chain}:`, error);
      throw error;
    }
  }
}
