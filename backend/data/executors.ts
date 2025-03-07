import { getAddress } from "viem";
import { Executor } from "../datasources/ExecutorRegistry";
import { DeepReadonly } from "../helpers";

export const executors = [
  {
    developerName: "Telcoin",
    developerAddress: "0x000000000000000000000000000000000000dead",
    address: "0x0082CaF47363bD42917947d81f4d4E0395257267",
  },
  {
    developerName: "Telcoin",
    developerAddress: "0x000000000000000000000000000000000000dead",
    address: "0xA64B745351EC40bdb3147FF99db2ae21cf93E6E3",
  },
].map((executor) => {
  return {
    developerName: executor.developerAddress,
    address: getAddress(executor.address),
    developerAddress: getAddress(executor.developerAddress),
  };
}) satisfies DeepReadonly<Executor[]>;
