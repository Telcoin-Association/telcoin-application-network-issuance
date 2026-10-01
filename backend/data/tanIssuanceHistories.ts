import { Address } from "abitype";
import { ChainId } from "../config";
import { Abi, getAddress } from "viem";
import { TanIssuanceHistoryAbi } from "../abi/abi";
import { isDeployed, sepoliaDeployments } from "./sepoliaDeployments";

export type TanIssuanceHistory = {
  chain: ChainId;
  address: Address;
  abi: Abi;
};

export const tanIssuanceHistories = [
  {
    chain: ChainId.Polygon,
    address: "0xE533911F00f1C3B58BB8D821131C9B6E2452Fc27",
    abi: TanIssuanceHistoryAbi,
  },
  // Sepolia rehearsal history, absent from this list until the deploy script fills its slot in
  ...(isDeployed(sepoliaDeployments.TANIssuanceHistory)
    ? [
        {
          chain: ChainId.EthSepolia,
          address: sepoliaDeployments.TANIssuanceHistory,
          abi: TanIssuanceHistoryAbi,
        },
      ]
    : []),
].map((tanIssuanceHistory) => {
  return {
    ...tanIssuanceHistory,
    address: getAddress(tanIssuanceHistory.address),
  };
});
