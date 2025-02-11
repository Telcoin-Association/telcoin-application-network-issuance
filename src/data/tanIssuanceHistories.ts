import { Address } from "abitype";
import { ChainId } from "../config";
import { Abi, getAddress } from "viem";
import { TanIssuanceHistoryAbi } from "../abi/abi";

export type TanIssuanceHistory = {
  chain: ChainId;
  address: Address;
  abi: Abi;
};

export const tanIssuanceHistories = [
  {
    //todo: mock polygon TANIssuanceHistory (for testing only, remove and replace with prod deployment)
    chain: ChainId.Polygon,
    address: "0xcAE9a3227C93905418500498F65f5d2baB235511",
    abi: TanIssuanceHistoryAbi,
  },
  // {
  //   // prod polygon TANIssuanceHistory
  //   chain: ChainId.Polygon,
  //   address: "todo: awaiting prod deployment of new plugin to prod StakingModule & increaser role set to TanIssuanceHistory",
  //   abi: TanIssuanceHistoryAbi,
  // },
].map((tanIssuanceHistory) => {
  return {
    ...tanIssuanceHistory,
    address: getAddress(tanIssuanceHistory.address),
  };
});
