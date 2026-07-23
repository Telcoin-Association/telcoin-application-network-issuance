// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { Deployments } from "../deployments/Deployments.sol";

/// @dev Guards the deployments.json decode: an empty-string `RewardsNotifier`
///      value made `abi.decode(vm.parseJson(json), (Deployments))` mis-align
///      every field by one (an empty string is type-inferred as a dynamic
///      string, not an address). With the zero-address placeholder the
///      whole-struct decode stays aligned.
contract DeploymentsDecodeTest is Test {
    function test_deploymentsJson_decodesWithoutFieldShift() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/deployments.json"));

        Deployments memory d = abi.decode(vm.parseJson(json), (Deployments));

        // Cross-check the whole-struct decode against per-key parses: if any field
        // were shifted, these would disagree (e.g. TANSafe decoding to the
        // TANIssuancePlugin address).
        assertEq(d.TANSafe, vm.parseJsonAddress(json, ".TANSafe"), "TANSafe field shifted");
        assertEq(
            d.TANIssuanceHistory, vm.parseJsonAddress(json, ".TANIssuanceHistory"), "TANIssuanceHistory field shifted"
        );
        assertEq(d.StakingModule, vm.parseJsonAddress(json, ".StakingModule"), "StakingModule field shifted");

        // The placeholder itself decodes as the zero address (not an ABI offset word).
        assertEq(d.RewardsNotifier, address(0), "RewardsNotifier is not the zero-address placeholder");
    }
}
