import { Address } from "viem";

export type UserRewardEntry = {
  reward: bigint;
  metadata: UserMetadata;
};

export type UserMetadata = {
  uncappedAmount?: bigint;
  fees: bigint; // total trading fees paid by staker
  refereeFees: bigint; // total trading fees paid by staker's referees
};

export interface ICalculator<T = UserRewardEntry> {
  calculate(): Promise<Map<Address, T>>;
}
