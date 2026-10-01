/// SPDX-License-Identifier MIT or Apache-2.0
pragma solidity ^0.8.26;

/// @notice Address book for the Ethereum Sepolia rehearsal environment, where the V3 issuance stack
/// is exercised against real V3 staking contracts before Polygon has one.
///
/// @dev Foundry decodes JSON data to Solidity structs using lexicographical ordering of the JSON
/// keys, therefore upper-case struct member names must come **BEFORE** lower-case ones. Every key in
/// `eth-sepolia.json` must have a matching member here, and vice versa.
struct SepoliaDeployments {
    /// @dev Stand-in for AmirX, which has no Sepolia deployment. Emits the TEL transfer and carries
    /// the `defiSwap` selector the staker calculator keys fee volume off of.
    address MockAmirX;
    /// @dev Live V3 `SimplePlugin` paying rewards in `TelV3`. Owned by `pluginOwner`.
    address SimplePlugin;
    /// @dev Live V3 `StakingModule` proxy. This contract is itself the sTEL ERC20, so per-account
    /// stake history is read from its `ERC20Votes` checkpoints.
    address StakingModule;
    /// @dev The rehearsal `TANIssuanceHistory`, populated by the deploy script.
    address TANIssuanceHistory;
    /// @dev V3 TEL. The plugin's `rewardToken()`, 18 decimals.
    address TelV3;
    /// @dev EOA that owns `MockAmirX` and funds its swaps. Rehearsal fee volume has to be generated
    /// one transaction at a time, which is impractical through a multisig, so this stays an EOA even
    /// though every issuance contract is Safe-owned.
    address feeSimulator;
    /// @dev Owner of `TANIssuanceHistory`, standing in for the TAN Safe. Every settlement, backfill,
    /// and seal is proposed through it.
    address owner;
    /// @dev Holder of the `SimplePlugin` owner and increaser roles. Wiring the rehearsal history in
    /// as increaser goes through this address. The same Safe as `owner` on Sepolia, so one multisig
    /// covers both sides of the settlement path.
    address pluginOwner;
}
