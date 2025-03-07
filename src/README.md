# TANIP-1 TANIssuanceHistory Smart Contract

The `TANIssuanceHistory` smart contract is used for distributing and recording rewards to TEL stakers participating in the TANIP-1 referral program.

It is located in `src/TANIssuanceHistory.sol` and its tests are located in both `test/TANIssuanceHistoryTest.t.sol` and `test/TANIssuanceHistoryForkTest.t.sol`

## Overview

The contract serves two purposes: to "distribute" TEL rewards by forwarding them from the Telcoin Application Network Governance Safe to the `SimplePlugin` and to store historical settlement block checkpoints for account rewards. These checkpoints are used for future periods' calculations.

## Configuration

The contract supports ERC6372 to externally declare its time metric as block numbers.

The contract stores an immutable reference to the chain's TEL token contract, as well as the `SimplePlugin` contract for which it serves the `Increaser` role. There is more on this at the bottom of this document.

The contract is owned by the Telcoin Application Network Governance Safe, which is managed via a Telcoin governance council. Through Telcoin governance, the safe retains the right to set a new plugin address for migrations and to recall any stray tokens which have mistakenly been sent to the contract to prevent them from becoming locked.

## Entrypoint: `TANIssuanceHistory::increaseClaimableByBatched()`

The contract's main entrypoint for the TANIP-1 program is a call to `increaseClaimableByBatched()` for every period which accepts an array of the rewardee addresses eligible under the program and a corresponding array containing their calculated rewards.

Distribution using `increaseClaimableByBatched()` may only be performed by the TAN Safe as part of a batched safe transaction so that TEL token transfers move directly through the `TANIssuanceHistory` contract from the safe to the `SimplePlugin`. While the history contract could hold TEL, the batched tx distribution flow forwards the correct amount of tokens and does not leave any TEL balance on the contract.

### Note on Polygon chain reorgs

Polygon often experiences chain reorgs, some reaching depths to the tune of 200 blocks. To address the potential for a reorg undoing a distribution via `increaseClaimableByBatched()`, the offchain calculator refuses to process or produce calldata for an `endBlock` which is less than 500 blocks earlier than the current block. This is in abundance of caution with regard to Polygon's stability properties.

### Note on calldata gas cost

While the contract is designed to be relatively time-agnostic, the TANIP-1 specification uses a weekly period to distribute rewards. Thus the program ideally settles once per week with a predictable `endBlock` parameter corresponding to a week's worth of blocks.

Current user activity can currently be easily encompassed by the EVM gas limit, but should weekly user activity ever grow to exceed it the function can be called more frequently.

## SimplePlugin Smart Contract

The `TANIssuanceHistory` contract is designed to serve the role of an `Increaser` for a pre-existing Telcoin staking contract implementation called the `SimplePlugin`. This is a modular contract designed to modularize TEL staking and rewards programs which attaches to the TEL staking hub contract called the `StakingModule`.

Both are already audited so the relationship between the `SimplePlugin` and `StakingModule` are not within scope for this audit however the relationship between the `TANIssuanceHistory` and the `SimplePlugin` are.

Auditors should thus focus on `SimplePlugin::increaseClaimableBy()` and how it is invoked by `TANIssuanceHistory::increaseClaimableByBatched()` during their security review. Other functionality within the `SimplePlugin` is less relevant though still within scope and any issues found there are valid.

[The previous audit report for the `SimplePlugin` can be found here](https://github.com/Telcoin-Association/telcoin-laboratories-contracts/blob/main/docs/v1_Sherlock_Staking.pdf)

## Audit

A completed audit report of the `TANIssuanceHistory` contract and its paired `SimplePlugin` for which it serves the "Increaser" role can be found in the `../audit` directory.

## TANIP-1 Spec and Implementation

The offchain component which calculates rewards and constructs the settlement calldata is called the `StakerIncentivesCalculator` and is out of scope for this smart contract audit. However general information about the program, its spec, and its implementation are linked below should they be useful for context.

- [TANIP-1 Proposal](../README.md)

- [`StakerIncentivesCalculator` spec](../backend/staker-incentives-calculator.md)

- [`StakerIncentivesCalculator` implementation](../backend/calculators/StakerIncentivesCalculator.ts)
