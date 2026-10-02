import { Address } from "abitype";
import { ChainId } from "../config";
import { Abi, getAddress } from "viem";
import { TanIssuanceHistoryAbi } from "../abi/abi";
import {
  isDeployed,
  polygonDeployments,
  sepoliaDeployments,
} from "./addressBooks";

export type TanIssuanceHistory = {
  chain: ChainId;
  address: Address;
  abi: Abi;
};

export const tanIssuanceHistories = [
  // V3 Polygon history, absent from this list until the deploy script fills its slot in. Until then a
  // Polygon run fails with no history configured, rather than reading caps from the V2 predecessor,
  // which settles in a different token at different decimals.
  ...(isDeployed(polygonDeployments.TANIssuanceHistory)
    ? [
        {
          chain: ChainId.Polygon,
          address: polygonDeployments.TANIssuanceHistory,
          abi: TanIssuanceHistoryAbi,
        },
      ]
    : []),
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
