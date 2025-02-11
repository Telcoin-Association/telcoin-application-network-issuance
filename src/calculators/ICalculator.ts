import { Address } from "viem";

export interface ICalculator {
  calculate(): Promise<Map<Address, bigint>>;
}
