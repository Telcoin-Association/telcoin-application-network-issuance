import { Address } from "abitype";
import { ChainId } from "../config";
import { getAddress } from "viem";

export type AmirX = {
  chain: ChainId;
  address: Address;
};

export const amirXs = [
  {
    chain: ChainId.Polygon,
    address: "0x4eB4A35257458C1a87A4124CE02B3329Ed6b8D5a",
  },
  {
    chain: ChainId.Polygon,
    address: "0x5c4Bb7067199f91a432Ae5F90C742967CfDF7E50",
  },
  {
    chain: ChainId.Polygon,
    address: "0xfBBB07E82c771489f2256f82060CAB17DB14c18f",
  },
].map((amirX) => {
  return {
    chain: amirX.chain,
    address: getAddress(amirX.address),
  };
});
