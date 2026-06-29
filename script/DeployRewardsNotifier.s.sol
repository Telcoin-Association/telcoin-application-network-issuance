// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { Script } from "forge-std/Script.sol";
import { LibString } from "solady/utils/LibString.sol";
import { Deployments } from "../deployments/Deployments.sol";
import { RewardsNotifier } from "../src/issuance/RewardsNotifier.sol";

/// @dev Usage:
///   forge script script/DeployRewardsNotifier.s.sol -vvvv \
///     --rpc-url $POLYGON_RPC_URL --private-key $ADMIN_PK --broadcast --verify
///
///   The constructor admin (DEFAULT_ADMIN_ROLE + NOTIFIER_ROLE) defaults to the
///   TANSafe address in deployments/deployments.json. Override by setting
///   REWARDS_NOTIFIER_ADMIN env var to a different address before running.
contract DeployRewardsNotifier is Script {
    RewardsNotifier public notifier;

    function run() public {
        string memory root = vm.projectRoot();
        string memory deploymentsPath = string.concat(root, "/deployments/deployments.json");
        string memory json = vm.readFile(deploymentsPath);
        bytes memory data = vm.parseJson(json);
        Deployments memory deployments = abi.decode(data, (Deployments));

        // Default admin: TAO Safe.
        address admin = deployments.TANSafe;

        vm.startBroadcast();
        notifier = new RewardsNotifier(admin);
        vm.stopBroadcast();

        assert(notifier.hasRole(notifier.DEFAULT_ADMIN_ROLE(), admin));
        assert(notifier.hasRole(notifier.NOTIFIER_ROLE(), admin));

        vm.writeJson(
            LibString.toHexString(uint256(uint160(address(notifier))), 20),
            deploymentsPath,
            ".RewardsNotifier"
        );
    }
}
