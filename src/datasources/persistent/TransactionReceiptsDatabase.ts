import { Hash, PublicClient, TransactionReceipt } from "viem";
import { BaseDatabase } from "./BaseDatabase";
import { Level } from "level";
import { createRpcClient } from "../../helpers";
import { ChainId } from "../../config";

export abstract class BaseTransactionReceiptsDatabase extends BaseDatabase<
  Hash,
  TransactionReceipt
> {
  constructor(readonly chain: ChainId) {
    super();
  }
}

/**
 * Fetches and stores transaction receipts from the blockchain.
 * Addresses in the receipts are NOT checksummed.
 */
export class TransactionReceiptsDatabase extends BaseTransactionReceiptsDatabase {
  readonly DB_NAME: string;
  private readonly _db: Level<string, string>;
  public client: PublicClient;

  constructor(readonly chain: ChainId, client?: PublicClient) {
    super(chain);
    this.DB_NAME = `db/${this.chain}/transactionReceipts`;
    this._db = new Level(this.DB_NAME, { valueEncoding: "json" });
    this.client = client || createRpcClient(this.chain);
  }

  protected getFromStore(key: string): Promise<string> {
    return this._db.get(key);
  }
  protected putToStore(key: string, val: string): Promise<void> {
    return this._db.put(key, val);
  }
  protected fetchData(txHash: Hash): Promise<TransactionReceipt> {
    return this.client.getTransactionReceipt({ hash: txHash });
  }
}
