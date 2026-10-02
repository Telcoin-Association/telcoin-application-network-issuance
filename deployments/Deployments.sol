/// SPDX-License-Identifier MIT or Apache-2.0
pragma solidity ^0.8.26;

/// @notice Address book for the predecessor V2 TAN issuance contracts on Polygon, read from
/// `deployments.json`. Frozen: `backend/buildBackfill.ts` reads it as the backfill source, so the V3
/// stack lives in `polygon.json` instead.
/// @dev Foundry decodes JSON data to Solidity structs using lexicographical ordering
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