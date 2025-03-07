# TAN Issuance Calculator Specification

![TAN Issuance Calculator](https://i.imgur.com/AhSUGHr.png)

## **Protocol Participants**

- **Stakers** are Telcoin mobile app users who have posted nonzero TEL stake to the Telcoin `StakingModule` contract
- **Referees** are users who have supplied a referral code from another TAN user to the app
- **Referrers** are users who have referred one or more `Referees`
- **Stakers** are eligible for rewards based on their own user fees
- **Stakers** who are also `Referrers` are further eligible for rewards based on their `Referees` user fees. Note that this is in addition to the eligibility of their own user fees.

## **Invariants**

### **Eligibility:** `Stakers` must both post a nonzero TEL stake and be the beneficiary of `eligible fees` as defined for Protocol Participants to be eligible for issuance rewards

`Stakers'` own user fees are eligible for rewards if they are also `Referees`, and if they are `Referrers` they are additionally eligible for their `Referees` fees. As a result, the set of `eligible users` for TAN rewards issuance comprises both `Stakers` and `Referrers`.

### **Rewards Caps:** Rewards for any given period are capped by the lowest stake held by the `Staker/Referrer` during the period, less cumulative rewards already earned.

To incentivize staking TEL, `Stakers'` are only eligible to receive issuance rewards up to their lowest amount staked for the period. This includes their cumulative rewards for all previous periods. Thus `rewardsCap = stakeAmtTrough - cumulativePrevRewards`.

Historical rewards checkpoints are persisted by the `TANIssuanceHistory` contract in a mapping called `prevCumulativeRewards` for immutable derivation of future rewards caps.

### **Multichain Support:** The `StakerIncentivesCalculator` class works across multiple chains.

This is achieved by instantiating and providing each chain's `BaseBlocksDatabase`, `TokenTransferHistory`, `Aggregator` set, `StakingModule`, `TanIssuanceHistory`, and `AmirX` contract. Data from each chain is abstracted by one degree by summing amounts to a multichain aggregate. For example, users' total fees, stake and cumulative rewards are fetched from all chains and summed together before performing calculations.

### **Automatic and Manual Time Periods:** The `StakerIncentivesCalculator` supports both automatic time period fetching from each chain as well as any custom time period accepted via CLI input.

The TANIP-1 issuance protocol makes use of a smart contract called `TANIssuanceHistory`, which has been designed to serve the `IPlugin::increaser` role for the existing implementation of Telcoin staking contracts. These are the `StakingModule` and its associated `IPlugin`s.

The `TANIssuanceHistory` performs distribution of rewards by incrementing claimable TEL on its paired `IPlugin` and stores the block in which the last settlement occurred, called `lastSettlementBlock`.

When the `StakerIncentivesCalculator` is run without a specified `startBlock`, the calculator will automatically determine the `startBlock` by fetching the `lastSettlementBlock` from the `TANIssuanceHistory` for each chain.

Likewise it will automatically determine the period's `endBlock` if run without a specified end block by identifying the chain's most recent finalized block.

### **Onchain Referral Data:** The relationships between `Referrer <-> Referee` are fetched from the chain on a need-to-know basis for each period.

The calculator examines all calls to `AmirX::defiSwap()` from `Executor` addresses to ensure they originated from the TAN backend and extracts the user wallet and referrer address from the transaction's calldata. This improves performance as the calculator need only care about the referral relationships relevant for the time period.

### **Onchain User Fees:** User fees are identified as TEL sent to AmirX from aggregators and filtered within `fetchUserFeeTransfers()`

To determine user fee eligibility, the calculator uses populates and iterates over a `TokenTransferHistory` for each chain, which contains `ERC20::Transfer` events for the TEL token.

Using `fetchUserFeeTransfers()`, it filters these down to identify transfers from the configured `Aggregator` addresses to the configured `AmirX` contracts. If these transfers were emitted as a part of an `Executor` transaction, these represent the user fee which may be eligible for issuance rewards if associated with a `Staker` or `Referrer`.

### **Executor Transactions:** All legitimate user fee payments must be part of transactions initiated by the TAN backend, represented as `Executor` EOAs (Externally Owned Accounts)

For security, the `fetchUserFeeTransfers()` function also ensures that the resulting user fee transfers originated from the TAN backend. It does so by further cross referencing the user fee transfers against transactions originated by configured `Executor` EOAs.

For each validated user fee transfer, the `fetchUserFeeTransfers()` function also appends the `Executor` transaction's calldata to each transfer in memory so that the `User <> Referrer` relationship can later be parsed.

## **Execution Flow**

### 1. **Determine Distribution Period:**

- The application determines a `startBlock` and `endBlock` for each chain, either by accepting one input via CLI or by calling the TANIssuanceHistory contract's `lastSettlementBlock()` function to automatically get the `startBlock` and using the chain's most recent finalized block for `endBlock`.

### 2. **Datasource and Calculator Initialization**

- Initialize the datasources required for the calculator's constructor and instantiate the calculator.

### 3. **StakerIncentivesCalculator::fetchUserFeeTransfers()**

- Identify multichain user fees over the period, defined as TEL transfer events from the DeFi aggregator address to the AmirX contract.
- Ensure all txs were initiated by executors so nobody can falsify user fees

### 4. **StakerIncentivesCalculator::fetchOnchainData()**

- Filter the fetched user fee transfers to include only those involving an eligible user fee for `Stakers` and `Referrers`.
- This necessitates fetching the trough stake amount for each transfer's `User (Wallet)` and `Referrer` parameters over the period (located in previously appended tx calldata). It is achieved first by examining `IPlugin::StakeChanged` events and falling back to a direct contract read of `StakingModule::stakedByAt(user, endBlock)` if no events were found.
- For users and referrers who are staked, it is also necessary to fetch the users' and referrers' cumulative rewards, performed within `processUserFeeSwaps()` and `processAddress()`
- Returns an array comprising all eligible trades by TEL stakers & referrers as well as a map containing all eligible users for the period and their multichain reward datas (stake and cumulative rewards)

### 5. **Derive Reward Caps**

- Accrue stake amounts and cumulative rewards over multichain context and derive a final reward cap across chains for each eligible user

### 6. **Total Fee Sum**

- Identify the total sum of all user fees for all eligible `Stakers` and `Referrers` over the specified period. This is necessary for the pro-rata calculation

### 7. **Pro-rata Calculation**

- Calculate the pro-rata share for each `Staker` and `Referrer` of the total fees for the period.
- Uses a decimal scaling constant to ensure there is no potential for rounding or precision loss

### 8. **Apply Rewards Caps:**

- Apply rewards caps where applicable to values derived in step 5. If any rewards caps were applied, it will result in a remainder out of the period's total issuance amount.

### 9. **Distribute Issuance:**

- Distribute the allocated reward amounts to each user for the period based on the capped pro-rata proportions from step 8, settling it onchain using the `TANIssuanceHistory` contract's `increaseClaimableByBatched()` function.
- Since the `TANIssuanceHistory` contract serves as the `Increaser` role for its paired plugin, rewarded users may now claim their increased rewards from the staking contract

## **Relevant Addresses**

### Polygon Addresses

#### **Executors**

- `0x0082CaF47363bD42917947d81f4d4E0395257267`
- `0xA64B745351EC40bdb3147FF99db2ae21cf93E6E3`

#### **Aggregator**

- The Telcoin Application Network utilizes 1inch and 0x aggregators for DeFi trades:
  - `0x1111111254EEB25477B68fb85Ed929f73A960582`
  - `0xDef1C0ded9bec7F1a1670819833240f027b25EfF`

#### **AmirX**

- `0x4eB4A35257458C1a87A4124CE02B3329Ed6b8D5a`

#### **Staking Contract**

- Locks staked TEL for all `Stakers` and `Referrers`:
  - `0x92e43Aec69207755CB1E6A8Dc589aAE630476330`

#### **Staking Plugins**

- `0xCAa823Fd48bec0134c8285Fd3C34F9D95CF3280f`

#### **TANIssuanceHistory**

- `0xE533911F00f1C3B58BB8D821131C9B6E2452Fc27`
