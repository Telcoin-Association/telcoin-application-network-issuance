/// SPDX-License-Identifier MIT or Apache-2.0
pragma solidity ^0.8.26;

/// @notice Address book for the V3 TAN issuance stack on Polygon, read from `polygon.json`.
///
/// @dev Foundry decodes JSON data to Solidity structs using lexicographical ordering of the JSON
/// keys, therefore upper-case struct member names must come **BEFORE** lower-case ones. Every key in
/// `polygon.json` must have a matching member here, and vice versa.
///
/// The predecessor V2 contracts stay in `deployments.json`, which is frozen so that
/// `backend/buildBackfill.ts` always reads the predecessor rather than this stack.
struct PolygonDeployments {
    /// @dev `SimplePlugin_TAN` from tel-v3-staking, paying rewards in `TelV3`. Owned by `pluginOwner`.
    address SimplePlugin;
    /// @dev V3 `StakingModule` proxy. This contract is itself the sTEL ERC20, so per-account stake
    /// history is read from its `ERC20Votes` checkpoints.
    address StakingModule;
    /// @dev The V3 `TANIssuanceHistory`, written by `script/DeployTANIssuanceHistory.s.sol` on broadcast.
    address TANIssuanceHistory;
    /// @dev TAN Safe. Owns `TANIssuanceHistory`, so it proposes every settlement, backfill, and seal.
    address TANSafe;
    /// @dev TelcoinV3, 18 decimals. The plugin's `rewardToken()`.
    address TelV3;
    /// @dev Safe that owns `SimplePlugin`, a different multisig from `TANSafe`. Only it can call
    /// `setIncreaser`.
    address pluginOwner;
}
