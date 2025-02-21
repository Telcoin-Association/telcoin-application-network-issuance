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
    chain: ChainId.Polygon,
    address: "0xfAf4E75BF9CD392e56Bffb574820126ce4212744",
    abi: TanIssuanceHistoryAbi,
  },
].map((tanIssuanceHistory) => {
  return {
    ...tanIssuanceHistory,
    address: getAddress(tanIssuanceHistory.address),
  };
});
