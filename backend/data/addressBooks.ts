import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { Address, getAddress, isAddress, zeroAddress } from "viem";

/**
 * Address books shared with the Foundry scripts and fork tests, read from `deployments/`.
 *
 * Sharing one file per chain keeps the backend from drifting out of sync with what was actually
 * deployed: the deploy scripts write their addresses back there, and they show up here on the next
 * run without a second edit.
 *
 * `deployments/deployments.json` is not loaded here. It is the frozen book for the predecessor
 * (V2) contracts, read only by `backend/buildBackfill.ts` and the legacy fork test.
 */

/** The V3 TAN issuance stack on Polygon. */
export type PolygonDeployments = {
  SimplePlugin: Address;
  StakingModule: Address;
  TANIssuanceHistory: Address;
  TANSafe: Address;
  TelV3: Address;
  pluginOwner: Address;
};

/** The Ethereum Sepolia rehearsal stack. */
export type SepoliaDeployments = {
  MockAmirX: Address;
  SimplePlugin: Address;
  StakingModule: Address;
  TANIssuanceHistory: Address;
  TelV3: Address;
  owner: Address;
  pluginOwner: Address;
};

/**
 * The repo root, found by walking up from this module to the directory holding `foundry.toml`.
 *
 * This module runs from `backend/` under ts-node and from `dist/` after a build, at different
 * depths, so neither `__dirname` nor the working directory locates `deployments/` on its own.
 */
function findRepoRoot(): string {
  let dir = __dirname;
  while (!existsSync(join(dir, "foundry.toml"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find the repo root (foundry.toml) above ${__dirname}`,
      );
    }
    dir = parent;
  }

  return dir;
}

function loadAddressBook<T>(fileName: string): T {
  const filePath = join(findRepoRoot(), "deployments", fileName);
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<
    string,
    string
  >;

  const entries = Object.entries(raw).map(([key, value]) => {
    if (!isAddress(value)) {
      throw new Error(
        `deployments/${fileName} key '${key}' is not an address: ${value}`,
      );
    }
    return [key, getAddress(value)];
  });

  return Object.fromEntries(entries) as T;
}

export const polygonDeployments =
  loadAddressBook<PolygonDeployments>("polygon.json");

export const sepoliaDeployments =
  loadAddressBook<SepoliaDeployments>("eth-sepolia.json");

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
