# Ethereum Sepolia rehearsal

Sepolia is where the V3 issuance path gets exercised end to end against real contracts, with a
history we own and can settle freely, before a settlement is ever proposed against the production
Polygon stack. This document covers what is deployed, why
the rehearsal is single-chain, and how to run it.

## Why not read Polygon and write Sepolia

Settling a period against a Sepolia `TANIssuanceHistory` while reading fee volume from Polygon
cannot work, and not for a configuration reason. Both write paths bound their block argument by the
chain they are deployed on:

```solidity
if (endBlock < lastSettlementBlock || endBlock > block.number) revert InvalidBlock(endBlock);
```

Polygon is around block 91,500,000 and Sepolia is around 11,430,000. Any Polygon block number handed
to a Sepolia history is above `block.number` and reverts `InvalidBlock`. `backfillCumulativeRewards`
carries the same bound on `atBlock`. Block numbers are chain-local, so the chain we read and the
chain we settle on have to be the same one.

Everything the rehearsal needs is on Sepolia anyway. The one exception is AmirX, which has no Sepolia
deployment, so we stand up a `MockAmirX` that carries the same `defiSwap` selector (`0x9a249c41`) and
emits the same TEL transfer the staker calculator keys fee volume off of.

## What is already live on Sepolia

| Contract | Address | Notes |
|---|---|---|
| `TANIssuanceHistory` | `0x2f7d9e2a275d3c454Cb8B7A838C4FC31D84cd607` | Safe-owned, verified |
| `MockAmirX` | `0xA519514b3820327FC2275b5C02D12D0be7a00ffa` | fee sink, EOA-owned, verified |
| `StakingModule` (sTEL) | `0x5deE96cA2358112907493d651f58AA889b8EBFA0` | V3 proxy, migration window open until 2026-08-29 |
| `SimplePlugin` (TEL) | `0xEBeca686a6B7CAb725C75C3b7A2b49b839Ecd416` | registered on the module, `rewardToken()` is TelV3 |
| TelV3 | `0x6B46d2f2a27f16dC1ef29a71C38A7E274132C7E7` | 18 decimals |
| Safe | `0x765327d1AeA74cC360B1C6Cc567200d7e4baC3fD` | Safe 1.4.1. Owns the history and the plugin, and holds `DEFAULT_ADMIN_ROLE` on the module |

These live in `deployments/eth-sepolia.json`, which both the Foundry scripts and the backend read, so
there is one address book rather than two that can drift.

The module already carries real staking history: accounts that staked in several tranches, an account
that burned sTEL through `requestWithdrawal`, and an account that left entirely. That is what makes it
worth testing the checkpoint reader against rather than a mock.

## Running the tests

The Solidity suite forks live Sepolia, deploys `TANIssuanceHistory` against the real plugin,
impersonates the plugin owner to take over the `increaser` slot, and drives backfill, settlement, and
a claim back out through the real `StakingModule`.

```
FOUNDRY_PROFILE=sepolia forge test --match-path test/TANIssuanceHistorySepoliaForkTest.t.sol -vv
```

The `sepolia` profile exists because the live V3 bytecode was compiled for a post-Cancun target, and
executing it under the repo default of `shanghai` hits an invalid opcode.

The TypeScript suite reads the live module and checks the V3 stake reader against the chain's own
`getPastVotes`, plus a brute-force recomputation of the duration-weighted average.

```
yarn test backend/test/StakerIncentivesCalculatorSepoliaFork.test.ts
```

Both need `ETH_SEPOLIA_RPC_URL`. The TypeScript suite skips itself without one. The Solidity suite
skips itself under any profile other than `sepolia`, so a plain `forge test` stays green, and fails
without the RPC URL when the profile is set.

## Deploying the rehearsal contracts

```
FOUNDRY_PROFILE=sepolia forge script script/DeployTANIssuanceHistorySepolia.s.sol \
  --rpc-url $ETH_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY --broadcast -vvvv
```

This deploys `TANIssuanceHistory` and `MockAmirX` and writes both addresses back into
`deployments/eth-sepolia.json`. A dry run leaves the file alone, so simulated addresses never enter
the address book.

The deploy runs from an EOA even though the contracts are multisig-managed, and that is safe rather
than a shortcut: `TANIssuanceHistory` takes its owner as a constructor argument, so the Safe owns it
from the first block of its existence and the deployer never holds a privilege to hand over.
`MockAmirX` deliberately stays EOA-owned, because rehearsal fee volume is generated one swap at a
time and routing each through a multisig would be unworkable.

## Multisig operations

Everything the owner can do is proposed through `script/safe/TANIssuanceSafeOps.s.sol`, which is
built on [safe-utils](https://github.com/Recon-Fuzz/safe-utils) and mirrors how `tel-v3-staking`
drives its own Safe. Without `--broadcast` it simulates against a fork, which needs no hardware
wallet and is the way to check a batch before asking signers to look at it. With `--broadcast` it
signs and posts to the Safe Transaction Service instead.

| Entrypoint | Proposes |
|---|---|
| `verify()` | nothing; prints the wiring every other entrypoint depends on |
| `setIncreaser()` | `SimplePlugin.setIncreaser(history)`, which is what unblocks settlement |
| `backfillChunk(string,uint256)` | one `backfillCumulativeRewards` chunk at the cutover block |
| `sealBackfill()` | `sealBackfill()`, one way |
| `settleChunk(string,uint256)` | a TEL transfer plus `increaseClaimableByBatch`, batched |
| `settleGap(uint256)` | an empty batch, to advance `lastSettlementBlock` across a period that pays nobody |

```
FOUNDRY_PROFILE=sepolia forge script script/safe/TANIssuanceSafeOps.s.sol \
  --sig "setIncreaser()" --rpc-url $ETH_SEPOLIA_RPC_URL --ffi -vvvv
```

Chunk arguments name a file under `backend/temp`, the same files `buildBackfill.ts` and
`safeTxArrayBuilder.ts` already write for the Safe UI. Reading those directly means a proposal is
built from the same bytes a reviewer would paste in by hand. `test/SafeChunkReaderTest.t.sol` pins
that parsing against fixtures in both shapes.

`settleChunk` batches the funding transfer with the settlement through MultiSend on purpose.
Settlement pulls the reward token from the history, so the history has to be holding the chunk total
when the call lands; batching makes that atomic, and no TEL is ever parked on the history between two
separately-executed proposals.

Proposing needs `DEPLOYER_SAFE_ADDRESS`, `SIGNER_ADDRESS_0` (plus `_1`, `_2`, ... for more signers),
`DERIVATION_PATH`, and `HARDWARE_WALLET`. A proposal carrying large calldata can exceed the Windows
command-line length limit through the FFI bridge, so proposing is done from macOS or Linux.
Simulation is unaffected and works anywhere.

## Running a period

```
yarn dev sepolia=<startBlock>:<endBlock> --period=<n>
```

The app now resolves its chain from the network argument instead of assuming Polygon, and it rejects
a run naming more than one network for the block-domain reason above. `assertTelTokensConfigured` is
scoped to the chain being run, so Polygon's still-unset TelV3 address does not block a Sepolia run.

Before the first period we need fee volume to exist. `MockAmirX.defiSwap` pulls its fee from the
address recorded as `feeSimulator`, so that address has to hold TelV3 and have approved the mock.
TelV3 is reachable by migrating legacy Sepolia TEL through `TokenMigration` at
`0x213DFC78120864346d6F33C3F4a2B5E09f181946`, which is permissionless.

The Safe also needs TelV3 to settle with, since `settleChunk` funds the history out of the Safe's own
balance.

## What this does not cover

- The Polygon backfill itself. `buildBackfill.ts` reads the live Polygon `TANIssuanceHistory`, and
  that data has no Sepolia analogue. It is covered by its own dry run.
- AmirX. The real contract hardcodes the V2 TEL address in bytecode and still needs a proxy upgrade
  on all three Polygon deployments. `MockAmirX` stands in for the calculator's fee-detection path
  only, and says nothing about whether the upgrade is correct.
