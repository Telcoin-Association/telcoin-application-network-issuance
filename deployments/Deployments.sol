/// SPDX-License-Identifier MIT or Apache-2.0
pragma solidity ^0.8.26;

/// @notice Foundry decodes JSON data to Solidity structs using lexicographical ordering
/// therefore upper-case struct member names must come **BEFORE** lower-case ones!
struct Deployments {
    address StakingModule;
    address TANIssuanceHistory;
    address TANIssuancePlugin;
    address TANSafe;
    address admin;
    address mockAmirX;
    address polygonTEL;
}