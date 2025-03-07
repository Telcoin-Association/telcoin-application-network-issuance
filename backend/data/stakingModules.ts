import { Abi, Address } from "abitype";
import { ChainId } from "../config";
import { getAddress } from "viem";
import { StakingModuleAbi } from "../abi/abi";

export type StakingModule = {
  chain: ChainId;
  address: Address;
  abi: Abi;
};

export const stakingModules = [
  {
    // prod polygon StakingModule
    chain: ChainId.Polygon,
    address: "0x92e43Aec69207755CB1E6A8Dc589aAE630476330",
    abi: StakingModuleAbi,
  },
].map((stakingModule) => {
  return {
    ...stakingModule,
    address: getAddress(stakingModule.address),
  };
});
