// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Deployments } from "../deployments/Deployments.sol";
import { TANIssuanceHistory } from "../src/issuance/TANIssuanceHistory.sol";
import { RecordOnlyPlugin } from "../src/issuance/RecordOnlyPlugin.sol";

/// @dev Usage: `forge script script/DeployRecordOnlyPlugin.s.sol -vvvv \
/// --rpc-url $POLYGON_RPC_URL --private-key $ADMIN_PK --verify --broadcast`
/// Then build the TAN Safe setup batch: `yarn ts-node backend/safeTxArrayBuilder.ts --setup-stub <address>`
contract DeployRecordOnlyPlugin is Script {
    Deployments deployments;
    TANIssuanceHistory tanIssuanceHistory;
    IERC20 oldTel;

    function setUp() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/deployments.json"));
        deployments = abi.decode(vm.parseJson(json), (Deployments));

        tanIssuanceHistory = TANIssuanceHistory(deployments.TANIssuanceHistory);
        oldTel = IERC20(deployments.polygonTEL);
    }

    function run() public returns (RecordOnlyPlugin stub) {
        vm.startBroadcast();
        stub = new RecordOnlyPlugin(oldTel, address(tanIssuanceHistory));
        vm.stopBroadcast();

        // `setTanIssuancePlugin()` only accepts plugins reporting the history's immutable TEL
        assert(stub.tel() == tanIssuanceHistory.tel());
        assert(stub.increaser() == address(tanIssuanceHistory));

        console2.log("RecordOnlyPlugin:", address(stub));
    }
}
