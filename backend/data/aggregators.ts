import { Address } from "abitype";
import { ChainId } from "../config";
import { getAddress } from "viem";

export type Aggregator = {
  aggregatorName: string;
  chain: ChainId;
  address: Address;
};

export const aggregators = [
  {
    aggregatorName: "1Inch",
    chain: ChainId.Polygon,
    address: "0x1380f2f57553ADA04b31ee7b1E039E496939DB3D",
  },
  {
    aggregatorName: "0x",
    chain: ChainId.Polygon,
    address: "0xfF4b330c5BC3811b66d8864CF8078D8F2db20Dd6",
  },
].map((aggregator) => {
  return {
    aggregatorName: aggregator.aggregatorName,
    chain: aggregator.chain,
    address: getAddress(aggregator.address),
  };
});
