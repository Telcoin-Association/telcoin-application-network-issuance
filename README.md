# Activating TEL Issuance at the Application Layer

This codebase is designed to calculate and distribute TAN and TELx incentives, establishing the platform's application layer incentive mechanisms. These mechanisms must be voted on and approved by the TAN and TELx councils.

With 194.44M TEL in the TAN Council Safe and 60.33M TEL in the TELx Council Safe, weekly distributions of TEL will flow to stakers based on their share of platform production. This initiates unified staking and liquidity provision models and activates essential platform adoption incentives while optimizing for user experiences.

## Motivation

The Telcoin Platform requires active application layer participation to achieve its vision of universal mobile-enabled blockchain services. By implementing TEL issuance for stakers and liquidity providers, we aim to:

- **Drive user adoption through staker referrals**
- **Improve swap UX and onchain liquidity through incentivized liquidity**
- **Foster an on-chain ecosystem aligned with natural market incentives**
- **Empower the entire value chain with ownership rights**, fulfilling the Association's constitutional mandate for inclusive, decentralized governance

While multiple incentive programs are planned for the future such as Developer incentives, which will aim to encourage GSMA member application development, the programs currently in production include:

- Staker Incentives Calculator implementation, which issues incentives based on the TANIP-1 referral program, has been paused as of Period 26
- TELx Rewards Calculator implementation, which issues liquidity incentives to LPs via the use of the Uniswap v4 hook `TELxIncentivesHook`

[The Uniswap v4 hook used for TELx liquidity incentives can be viewed here](https://github.com/Telcoin-Association/telcoin-laboratories-contracts/blob/foundry/contracts/telx/core/TELxIncentiveHook.sol)

## Staker Issuance Specification

TANIP-1 Staker Incentives Issuance has been paused for the time being.

### TEL Distribution Framework

- **TAN Council Safe Balance:** 194.44M TEL
- **Weekly Distribution:**
  - **Stakers:** 3,205,128.205 TEL
- **Distribution Timing:** Every Wednesday at 00:00 UTC

### Staker Rules

- **Eligibility:** All Telcoin Developer apps' users' who have added another user’s referral code and staked
- **Allocation Formula:** 3,205,128.205 TEL per week
- **Basis for Income Formula:**
  - Pro-rata share of:
    - Personal fees paid
    - Referred users' fees paid
- **TAN Maximum Weekly TEL Issuance Rule:** Throughout the entire period, total staked TEL must exceed (Lifetime TEL issuance + Current week TEL issuance)

## Viewing the official rewards

For community members wishing to view the official published rewards for each TANIP-1 period (weeks starting Feb 19 at 00:00 UTC), refer to the `rewards` directory and consult the file for the period, for example `rewards/staker_rewards_period_0.json`. These rewards files list the supported networks, start and end blocks, and a map of each address to its rewards for the period.

### Note that the rewards amounts are denominated in EVM-recognizable numbers so the TEL decimals transformation must be applied. This means all listed amounts must be divided by 100 to get the reward amount in TEL which has a decimal precision of 2.

## Running the Tests

To run the tests, first ensure you are using the correct node version:

```bash
nvm use 18
```

Then install dependencies:

```bash
yarn install
```

### Contract tests

This codebase uses the Foundry framework for smart contract testing.

Running the contract tests requires a `.env` file with a node provider API endpoint entry for `POLYGON_RPC_URL`. Once the `.env` is set, run the tests using:

```bash
forge test
```

### Backend tests

This codebase uses the Jest framework for TypeScript backend testing. Tests exist for each of the calculators; however, as mentioned, the StakerIncentivesCalculator is currently the only calculator in production, pending the approval of more TANIPs.

Running the backend tests require a `.env` file with a node provider API endpoint entry for `POLYGON_RPC_URL`. Once the `.env` is set, run the tests using:

```bash
yarn jest
```

#### Backend fork test

The `src/test/StakerIncentivesCalculatorFork.test.ts` features an extensive end-to-end fork simulation test of an entire period's worth of staking, TAN trading, and user fees; these actions are fuzzed using randomly generated users, stakes, fees, and referral relationships. Because this test executes on-chain actions on a local fork, it requires running a local anvil fork of the Polygon mainnet alongside the test.

To run an Anvil fork of Polygon, make sure you have Foundry installed and then execute:

```bash
anvil --fork-url $POLYGON_RPC_URL
```

If Foundry is not installed or the fork test is not desired (~20s), disable it by adding `.skip` to line 171, i.e.:

```javascript
it.skip("should return the correct reward amounts per staker and referrer", async () => {
```

Then run the tests with the Anvil fork of Polygon running on port 8545:

```bash
yarn jest
```

## Running the StakerIncentivesCalculator

The program's entry point is the `src/app.ts` file, which instantiates all the data sources and fetches required data to run the `StakerIncentivesCalculator`. Future additions to the program, such as new incentive program calculators, will be added to this file. For a deeper dive into the staker issuance incentives calculator, including specification, invariants, and system diagrams, refer to the `staker-incentives-calculator.md` file

Ensure all required local files for the data sources relevant to the calculators being run are present in the expected locations. The TAN Staker Incentives Program calculator does not require any of these because it fetches all required data from on-chain, but future calculators may rely on the local files, such as those using the `UserRegistry`, which expects a `users_wallets_referrals.json` file generated by the TAN backend.

First, ensure you are using the correct node version:

```bash
nvm use 18
```

Install dependencies:

```bash
yarn install
```

Make sure to edit `src/config.ts` to fit your requirements, such as the staker incentives amounts, and set the `.env` with RPC endpoints.

Then build the project:

```bash
yarn build
```

Now you can run the main application. The program accepts the chain(s) to fetch and process information from as well as an optional start block and endblock, for example:

```bash
# calculate based on Polygon data only, starting from block 67070000 until block 67078000
yarn start polygon=67070000:67078000

# calculate based on Polygon data, starting from the TANIssuanceHistory's stored `lastSettlementBlock`
yarn start polygon

# calculate based on Polygon and Mainnet
yarn start polygon mainnet

# calculate based on Polygon and Mainnet with specified start blocks for each.
yarn start polygon=67070000:67078000 mainnet=21740000:21739790
```

## Running with Docker and Makefile

## Prerequisites

- Docker installed on your system
- Make installed on your system

## Quick Start

1. Build the Docker image:

```bash
make build
```

2. Start an interactive development session:

```bash
make up
```

Once inside the container, you need to run `yarn` once to install dependencies.

## Running the SafeTxArrayBuilder script

### Note that TANIP-1 periods must be settled in chronological order. Ie, do not submit a transaction for period 5 before settling ALL transactions & chunks for period 4.

Because the TANIssuanceHistory contract is owned by the Telcoin Application Network Council governance safe, distributions should be performed via the Safe UI for secure multisig operation. This way transaction checks and simulation can be validated across councilmembers ahead of signing.

#### The TAN Safe to use is deployed to `0x8Dcf8d134F22aC625A7aFb39514695801CD705b5` on Polygon and the transaction should target the `TANIssuanceHistory` contract's `increaseClaimableByBatch()` function, which is also deployed on Polygon at `0xe533911f00f1c3b58bb8d821131c9b6e2452fc27`.

#### The TANIssuanceHistory ABI can be found in `backend/abi/TanIssuanceHistoryAbi.ts` or fetched from PolygonScan

The `backend/safeTxArrayBuilder.ts` script builds the function parameters which must be supplied to the Safe UI for distribution. These are:

- an array of Solidity `IssuanceReward` structs defined within `TANIssuanceHistory.sol`, called `rewards`
- the settlement chain's end block used for the period's calculation run, aptly called `endBlock`

#### The builder script prints the total amount of TEL needed to be transferred from the TANSafe to the history contract (and then to the plugin), as well as the `endBlock` for all networks in `rewards/staker_rewards_period_x.json`. The `rewards` array parameter is often too long to view in a terminal and sometimes too long to perform the period's distribution in a single transaction, so it is written to a series of chunks at`backend/temp/safe_param_period_x_chunk_y.json` file for the corresponding period number.

To run the script, use:

`yarn ts-node backend/safeTxArrayBuilder.ts --period $DESIRED_PERIOD`
