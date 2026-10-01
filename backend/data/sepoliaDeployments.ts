import { readFileSync } from "fs";
import { resolve } from "path";
import { Address, getAddress, isAddress, zeroAddress } from "viem";

/**
 * The Ethereum Sepolia address book, read from the same `deployments/eth-sepolia.json` the Foundry
 * scripts and fork tests read.
 *
 * Sharing one file keeps the backend from drifting out of sync with what was actually deployed:
 * `script/DeployTANIssuanceHistorySepolia.s.sol` writes its addresses back there, and they show up
 * here on the next run without a second edit.
 *
 * The path is resolved against the process working directory rather than `__dirname`, because this
 * module is loaded both from `backend/` under ts-node and from `dist/` after a build, and only the
 * working directory is the repo root in both cases.
 */
export type SepoliaDeployments = {
  MockAmirX: Address;
  SimplePlugin: Address;
  StakingModule: Address;
  TANIssuanceHistory: Address;
  TelV3: Address;
  owner: Address;
  pluginOwner: Address;
};

const DEPLOYMENTS_PATH = "deployments/eth-sepolia.json";

function loadSepoliaDeployments(): SepoliaDeployments {
  const raw = JSON.parse(
    readFileSync(resolve(process.cwd(), DEPLOYMENTS_PATH), "utf8"),
  ) as Record<string, string>;

  const entries = Object.entries(raw).map(([key, value]) => {
    if (!isAddress(value)) {
      throw new Error(
        `${DEPLOYMENTS_PATH} key '${key}' is not an address: ${value}`,
      );
    }
    return [key, getAddress(value)];
  });

  return Object.fromEntries(entries) as SepoliaDeployments;
}

export const sepoliaDeployments = loadSepoliaDeployments();

/**
 * True once a deployment slot has been filled in.
 *
 * Slots start as the zero address, and a zero address would otherwise be indistinguishable from a
 * real contract that simply matches nothing, so unfilled entries are left out of the data lists
 * entirely and surface as a "no deployment for this chain" error instead.
 */
export function isDeployed(address: Address): boolean {
  return address !== zeroAddress;
}
