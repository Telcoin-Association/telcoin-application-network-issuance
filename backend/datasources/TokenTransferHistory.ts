import {
  Address,
  Hash,
  PublicClient,
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  getAbiItem,
  getAddress,
  http,
} from "viem";
import { DeepReadonly, copyByJson, createRpcClient } from "../helpers";
import { ChainId, Token, config } from "../config";
import { ERC20Abi } from "../abi/abi";
import { mainnet, polygon } from "viem/chains";

export type TokenTransfer = {
  token: Token;
  from: Address;
  to: Address;
  amount: bigint;
  txHash: Hash;
  blockNumber: bigint;
};

export interface TokenTransferWithCalldata extends TokenTransfer {
  calldata: `0x${string}`;
}

/**
 * This class fetches and keeps track of transfer events for a given token within a specified block range.
 */
export abstract class BaseTokenTransferHistory {
  private _transfers: TokenTransfer[] = [];

  private _initialized = false;

  constructor(readonly token: DeepReadonly<Token>) {}

  get transfers(): DeepReadonly<TokenTransfer[]> {
    this.whenInitialized();
    return this._transfers;
  }

  get initialized() {
    return this._initialized;
  }

  private whenInitialized() {
    if (!this._initialized) {
      throw new Error("Not initialized");
    }
  }

  async init() {
    if (this._initialized) {
      return;
    }

    this._transfers = await this.fetchTransfers();

    this._initialized = true;
  }

  /**
   * @param address Address to get transfers to or from. (The address must be checksummed)
   * @param direction Optional param to match transfer events' `to` or `from` address
   * @returns All transfer events where the given address is either the sender or receiver
   */
  getTransfersForAddress(
    address: Address,
    direction?: string
  ): TokenTransfer[] {
    this.whenInitialized();
    if (!direction) {
      return this._transfers.filter(
        (transfer) => transfer.from === address || transfer.to === address
      );
    } else {
      if (direction === "to") {
        return this._transfers.filter((transfer) => transfer.to === address);
      }

      if (direction === "from") {
        return this._transfers.filter((transfer) => transfer.from === address);
      }

      throw new Error("Invalid transfer direction");
    }
  }

  abstract fetchTransfers(): Promise<TokenTransfer[]>;
}

/**
 * This class fetches and keeps track of transfer events for a given token within a specified block range.
 *
 * Works only with standard ERC20 tokens.
 */
export class TokenTransferHistory extends BaseTokenTransferHistory {
  showLogs = false;
  private readonly _transferAbiItem = getAbiItem({
    abi: ERC20Abi,
    name: "Transfer",
  });
  public client: PublicClient;

  constructor(
    token: DeepReadonly<Token>,
    readonly startBlock: bigint,
    readonly endBlock: bigint,
    client?: PublicClient
  ) {
    super(token);
    this.client = client || this.createDefaultClient(token.chain);
  }

  async fetchTransfers(): Promise<TokenTransfer[]> {
    const transfers: TokenTransfer[] = [];
    // Alchemy limits unlimited log fetching to a 2k block range
    const blockChunkSize = BigInt(2000);

    let currentStartBlock = this.startBlock;
    while (currentStartBlock <= this.endBlock) {
      const currentStartBlockPlusChunk = currentStartBlock + blockChunkSize;
      const currentEndBlock =
        currentStartBlockPlusChunk > this.endBlock
          ? this.endBlock
          : currentStartBlockPlusChunk;

      const logs = await this.client.getLogs({
        address: this.token.address,
        event: this._transferAbiItem,
        fromBlock: currentStartBlock,
        toBlock: currentEndBlock,
      });

      const chunkTransfers = logs.map((log) => {
        const from = log.args.from!;
        const to = log.args.to!;
        const amount = log.args.value!;
        const txHash = log.transactionHash!;
        const blockNumber = log.blockNumber!;

        return {
          token: copyByJson(this.token) as Token,
          from,
          to,
          amount,
          txHash,
          blockNumber,
        };
      });

      transfers.push(...chunkTransfers);

      // move to next 2k block chunk which is 1 after the end block
      currentStartBlock = currentEndBlock + BigInt(1);
    }

    return transfers;
  }

  private createDefaultClient(chainId: ChainId): PublicClient {
    const currentChain = chainId === ChainId.Polygon ? polygon : mainnet;
    return createPublicClient({
      chain: currentChain,
      transport: http(config.rpcUrls[this.token.chain]),
    });
  }
}
