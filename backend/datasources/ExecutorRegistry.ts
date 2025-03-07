import { Address } from "viem";
import { DeepReadonly } from "../helpers";

export type Executor = {
  address: Address;
  developerName: string;
  developerAddress: Address;
};

/**
 * This class represents a registry of executors.
 */
export abstract class BaseExecutorRegistry {
  private _executors: DeepReadonly<Executor[]> = [];
  private _executorAddressToExecutor = new Map<Address, Executor>();
  private _developerAddressToExecutors = new Map<Address, Executor[]>();

  get executors(): DeepReadonly<Executor[]> {
    return this._executors;
  }

  protected setExecutors(executors: DeepReadonly<Executor[]>) {
    this._executors = executors;
    this._syncMaps();
  }

  private _syncMaps() {
    this._executorAddressToExecutor = new Map();

    for (const executor of this._executors) {
      this._executorAddressToExecutor.set(executor.address, executor);
      if (!this._developerAddressToExecutors.has(executor.developerAddress)) {
        this._developerAddressToExecutors.set(executor.developerAddress, []);
      }
      this._developerAddressToExecutors
        .get(executor.developerAddress)
        ?.push(executor);
    }
  }

  getExecutorsForDeveloper(
    developerAddress: Address
  ): DeepReadonly<Executor[]> {
    if (!this._developerAddressToExecutors.has(developerAddress)) {
      throw new Error("Developer Address Not Found in Executor Registry");
    }
    return this._developerAddressToExecutors.get(developerAddress)!;
  }

  getExecutorFromAddress(addr: Address): DeepReadonly<Executor> {
    if (!this._executorAddressToExecutor.has(addr)) {
      throw new Error("Executor Address Not Found in Executor Registry");
    }
    return this._executorAddressToExecutor.get(addr)!;
  }
}

import { executors } from "../data/executors";
export class LocalFileExecutorRegistry extends BaseExecutorRegistry {
  constructor() {
    super();
    this.setExecutors(executors);
  }
}
