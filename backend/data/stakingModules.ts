import { Abi, Address } from "abitype";
import { ChainId } from "../config";
import { getAddress } from "viem";
import { StakingModuleAbi } from "../abi/abi";
import {
  isDeployed,
  polygonDeployments,
  sepoliaDeployments,
} from "./addressBooks";

export type StakingModule = {
  chain: ChainId;
  address: Address;
  abi: Abi;
};

export const stakingModules = [
  {
    // prod polygon V3 StakingModule proxy, the sTEL ERC20 whose vote checkpoints carry stake history
    chain: ChainId.Polygon,
    address: polygonDeployments.StakingModule,
    abi: StakingModuleAbi,
  },
  // V3 StakingModule on Ethereum Sepolia. It is itself the sTEL ERC20, so per-account stake history
  // is read from its ERC20Votes checkpoints rather than from stake events.
  ...(isDeployed(sepoliaDeployments.StakingModule)
    ? [
        {
          chain: ChainId.EthSepolia,
          address: sepoliaDeployments.StakingModule,
          abi: StakingModuleAbi,
        },
      ]
    : []),
].map((stakingModule) => {
  return {
    ...stakingModule,
    address: getAddress(stakingModule.address),
  };
});
