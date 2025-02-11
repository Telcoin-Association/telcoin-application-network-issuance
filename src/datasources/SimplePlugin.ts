import {
  Address,
  GetLogsReturnType,
  Hash,
  createPublicClient,
  getAbiItem,
  getAddress,
  http,
} from "viem";
import { SimplePluginAbi } from "../abi/abi";
import { DeepReadonly } from "../helpers";
import { ChainId, config } from "../config";
import { mainnet, polygon } from "viem/chains";

export type ClaimableIncreasedEvent = {
  txHash: Hash;
  account: Address;
  oldClaimable: bigint;
  newClaimable: bigint;
};

/**
 * This class represents a simple plugin.
 *
 * It fetches and keeps track of `ClaimableIncreased` events for a given plugin and block range.
 */
export abstract class BaseSimplePlugin {
  private _initialized = false;

  private _claimableIncreasedEvents: ClaimableIncreasedEvent[] = [];

  constructor(readonly chain: ChainId) {}

  get initialized() {
    return this._initialized;
  }

  get claimableIncreasedEvents(): DeepReadonly<ClaimableIncreasedEvent[]> {
    this.whenInitialized();
    return this._claimableIncreasedEvents;
  }

  private whenInitialized() {
    if (!this._initialized) {
      throw new Error("Not Initialized");
    }
  }

  async init() {
    if (this._initialized) {
      return;
    }

    this._claimableIncreasedEvents = await this.fetchClaimableIncreasedEvents();

    this._initialized = true;
  }

  getEventsCorrespondingToTxHashSet(
    txHashes: Set<Hash>
  ): DeepReadonly<ClaimableIncreasedEvent[]> {
    this.whenInitialized();
    const events: ClaimableIncreasedEvent[] = [];

    for (const event of this.claimableIncreasedEvents) {
      if (txHashes.has(event.txHash)) {
        events.push(event);
      }
    }

    return events;
  }

  abstract fetchClaimableIncreasedEvents(): Promise<ClaimableIncreasedEvent[]>;
}

/**
 * This class retreives events from a simple plugin and stores them in memory.
 */
export class SimplePlugin extends BaseSimplePlugin {
  private readonly claimableIncreasedEvent = getAbiItem({
    abi: SimplePluginAbi,
    name: "ClaimableIncreased",
  });

  showLogs = false;

  constructor(
    chain: ChainId,
    readonly pluginAddress: Address,
    readonly startBlock: bigint,
    readonly endBlock: bigint
  ) {
    super(chain);
  }

  async fetchClaimableIncreasedEvents(): Promise<ClaimableIncreasedEvent[]> {
    const currentChain = this.chain === ChainId.Polygon ? polygon : mainnet;
    const publicClient = createPublicClient({
      chain: currentChain,
      transport: http(config.rpcUrls[this.chain]),
    });
    const logs = await publicClient.getLogs({
      address: this.pluginAddress,
      event: this.claimableIncreasedEvent,
      // },
      // this.chain,
      fromBlock: this.startBlock,
      toBlock: this.endBlock,
      // this.showLogs
    });

    return logs.map((log) => ({
      txHash: log.transactionHash!,
      account: getAddress(log.args.account!),
      oldClaimable: log.args.oldClaimable!,
      newClaimable: log.args.newClaimable!,
    }));
  }
}
