import { Address } from "viem";

export type UserRewardEntry = {
  reward: bigint;
  uncappedAmount: bigint;
};

export interface ICalculator<T = UserRewardEntry> {
  calculate(): Promise<Map<Address, T>>;
}
