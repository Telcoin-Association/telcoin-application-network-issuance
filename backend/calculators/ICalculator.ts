import { Address } from "viem";

export type UserRewardEntry = {
  reward: bigint;
  metadata: UserMetadata;
};

export type UserMetadata = {
  uncappedAmount?: bigint;
  stakeCapAmount?: bigint; // stake-based cap: userStake - prevCumulativeRewards
  fees: bigint; // total trading fees paid by staker
  refereeFees: bigint; // total trading fees paid by staker's referees
};

export interface ICalculator<T = UserRewardEntry> {
  calculate(): Promise<Map<Address, T>>;
}
