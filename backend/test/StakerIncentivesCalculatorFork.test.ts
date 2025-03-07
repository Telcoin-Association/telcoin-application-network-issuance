import {
  TokenTransferHistory,
  TokenTransferWithCalldata,
} from "../datasources/TokenTransferHistory";
import { BlocksDatabase } from "../datasources/persistent/BlocksDatabase";
import {
  BaseExecutorRegistry,
  LocalFileExecutorRegistry,
} from "../datasources/ExecutorRegistry";
import { ChainId, config } from "../config";
import { StakerIncentivesCalculator } from "../calculators/StakerIncentivesCalculator";
import {
  Address,
  createTestClient,
  encodeFunctionData,
  getAddress,
  http,
  parseEther,
  publicActions,
  TestClient,
  toHex,
  walletActions,
  zeroAddress,
} from "viem";
import AmirXAbi from "../abi/AmirXAbi";
import StakingModuleAbi from "../abi/StakingModuleAbi";
import { foundry, polygon } from "viem/chains";
import ERC20Abi from "../abi/ERC20Abi";
import TanIssuanceHistoryAbi from "../abi/TanIssuanceHistoryAbi";
import {
  generateRandomReferralRelationships,
  mockDefiSwap,
  getRandomBigInt,
} from "../helpers";
import { privateKeyToAccount } from "viem/accounts";

/**
 * @dev This fork test requires an active local Foundry fork of the chain being tested
 * Run one using `anvil --fork-url $POLYGON_RPC_URL`
 */
describe("StakerIncentivesCalculatorForkTest", () => {
  /**
   * Helpers
   */

  function generateRandomStakesAndFees(
    users: Address[]
  ): [Map<Address, bigint>, Map<Address, bigint>] {
    const userStakes = new Map<Address, bigint>();
    const userFees = new Map<Address, bigint>();

    const maxStake = 1_000_000_000;
    const maxFee = 100_000_000;
    for (const user of users) {
      // for simplicity let's say 1/5 users are not staked
      let stake = getRandomBigInt(0, maxStake);
      if (Math.random() < 0.2) stake = 0n;

      // for simplicity let's say 1/4 users had no fees for the period
      let fee = getRandomBigInt(0, maxFee);
      if (Math.random() < 0.2) fee = 0n;

      userStakes.set(user, stake);
      userFees.set(user, fee);
    }

    return [userStakes, userFees];
  }

  async function simulateFundRecipientGas(
    client: TestClient,
    sender: Address,
    recipient: Address
  ) {
    await client.impersonateAccount({ address: sender });

    // fund the recipient with 1 baseline gas token
    await client.extend(walletActions).sendTransaction({
      chain: polygon,
      mode: "anvil",
      account: sender,
      to: recipient,
      value: parseEther("1"),
    });
  }

  async function simulateFundRecipientTEL(
    client: TestClient,
    sender: Address,
    recipient: Address,
    telAmount: bigint
  ) {
    await client.impersonateAccount({ address: sender });

    // fund the recipient with TEL
    const transferData = encodeFunctionData({
      abi: ERC20Abi,
      functionName: "transfer",
      args: [recipient, telAmount],
    });
    await client.extend(walletActions).sendTransaction({
      chain: polygon,
      mode: "anvil",
      account: sender,
      to: config.telToken[ChainId.Polygon].address,
      data: transferData,
    });
  }

  async function simulateApproveTEL(
    client: TestClient,
    approver: Address,
    operator: Address,
    amount: bigint
  ) {
    await client.impersonateAccount({ address: approver });

    const approveData = encodeFunctionData({
      abi: ERC20Abi,
      functionName: "approve",
      args: [operator, amount],
    });
    await client.extend(walletActions).sendTransaction({
      chain: polygon,
      mode: "anvil",
      account: approver,
      to: config.telToken[ChainId.Polygon].address,
      data: approveData,
    });
  }

  async function simulateStakeTEL(
    client: TestClient,
    stakingModule: Address,
    user: Address,
    amount: bigint
  ) {
    await client.impersonateAccount({ address: user });

    const stakeData = encodeFunctionData({
      abi: StakingModuleAbi,
      functionName: "stake",
      args: [amount],
    });
    await client.extend(walletActions).sendTransaction({
      chain: polygon,
      mode: "anvil",
      account: user,
      to: stakingModule,
      data: stakeData,
    });
  }

  async function simulateDefiSwap(
    client: TestClient,
    executor: Address,
    amirX: Address,
    calldata: `0x${string}`
  ) {
    await client.impersonateAccount({ address: executor });

    await client.extend(walletActions).sendTransaction({
      chain: polygon,
      mode: "anvil",
      account: executor,
      to: amirX,
      data: calldata,
    });
  }

  it.skip("should return the correct reward amounts per staker and referrer", async () => {
    /**
     * test config
     */

    const numUsers = 10;
    const users: Address[] = [];
    for (let i = 0; i < numUsers; i++) {
      const randomUser = privateKeyToAccount(
        toHex(i + 1, { size: 32 })
      ).address;
      users.push(getAddress(randomUser));
    }

    const referralRelationships = generateRandomReferralRelationships(users);
    const [userStakes, userFees] = generateRandomStakesAndFees(users);

    /**
     * @notice Source address chosen by the highest TEL holder which also holds a large amount of POL tokens for gas
     */
    const sourceAddress: Address = "0x20dAAcb0864fF9a5e07d05Ea16Fa56cD00fdC16D";
    const mockStakingModule: Address =
      "0x1c815F579Ea0E342aA59224c2e403018E7E8f995";
    const mockAmirX: Address = "0x8d52367c87bDb6A957529d2aeD95C17260Db1B93";
    const mockDefiAgg: Address = "0x3DCc9a6f3A71F0A6C8C659c65558321c374E917a";
    const mockTanIssuanceHistory: Address =
      "0xcAE9a3227C93905418500498F65f5d2baB235511";
    const mockExecutor: Address = "0xc1612C97537c2CC62a11FC4516367AB6F62d4B23";

    // process referral relationships, user stakes, and user fees into a mono map
    interface UserTestInfo {
      referees: Address[];
      stake: bigint;
      userFees: bigint;
    }
    const usersToTestInfos = new Map<Address, UserTestInfo>(
      users.map((user) => [
        user,
        {
          referees: referralRelationships.get(user) || [],
          stake: userStakes.get(user) || 0n,
          userFees: userFees.get(user) || 0n,
        },
      ])
    );

    // create test client and set it to a specified block for consistency
    const testClient = createTestClient({
      chain: polygon,
      mode: "anvil",
      transport: http("http://localhost:8545"),
    });
    const startBlock = await testClient.extend(publicActions).getBlockNumber();

    // stake on behalf of all users
    for (const [user, info] of usersToTestInfos.entries()) {
      // all users get gas funds and TEL tokens enough to stake
      await simulateFundRecipientGas(testClient, sourceAddress, user);
      const stakeAmount = info.stake;
      if (stakeAmount !== 0n) {
        await simulateFundRecipientTEL(
          testClient,
          sourceAddress,
          user,
          stakeAmount
        );

        // all users approve and stake
        await simulateApproveTEL(
          testClient,
          user,
          mockStakingModule,
          stakeAmount
        );
        await simulateStakeTEL(
          testClient,
          mockStakingModule,
          user,
          stakeAmount
        );
      }
    }

    // get sum of all user fees
    const feeTotal: bigint = Array.from(usersToTestInfos.values()).reduce(
      (accumulator: bigint, info: UserTestInfo) => {
        return accumulator + info.userFees;
      },
      0n
    );

    // fund the mock defi aggregator intermediary and mock TANIssuanceHistory contract with TEL
    await simulateFundRecipientTEL(
      testClient,
      sourceAddress,
      mockDefiAgg,
      feeTotal
    );
    await simulateFundRecipientTEL(
      testClient,
      sourceAddress,
      mockTanIssuanceHistory,
      config.incentivesAmounts.stakerIncentivesAmount
    );
    // approve TEL from mock defi agg to mock AmirX. In prod this happens as part of AmirX logic
    await simulateApproveTEL(testClient, mockDefiAgg, mockAmirX, feeTotal);

    // construct defiSwap calldata and call it as `mockExecutor`
    for (const [user, info] of usersToTestInfos.entries()) {
      let referrer: Address = zeroAddress;
      for (const [
        potentialReferrer,
        referrerInfo,
      ] of usersToTestInfos.entries()) {
        if (referrerInfo.referees.includes(user)) {
          referrer = potentialReferrer;
          break;
        }
      }

      // for simplicity, the `userFee` is written to `DefiSwap.referralFee` in this test to match transfer event (not true in prod)
      const calldata = encodeFunctionData({
        abi: AmirXAbi,
        functionName: "defiSwap",
        args: [
          user,
          {
            ...mockDefiSwap,
            referrer: referrer,
            referralFee: info.userFees,
          },
        ],
      });

      // perform defiSwap for each user, initiated by executor EOA
      await simulateDefiSwap(testClient, mockExecutor, mockAmirX, calldata);
    }

    const endBlock = await testClient.extend(publicActions).getBlockNumber();
    // fast forward a block so all period terminates in the past
    await testClient.mine({ blocks: 1 });

    // calculator constructor args
    const tokenTransferHistory = new TokenTransferHistory(
      config.telToken[ChainId.Polygon],
      startBlock,
      endBlock,
      testClient.extend(publicActions)
    );
    await tokenTransferHistory.init();

    const aggregator = {
      aggregatorName: "mockDefiAgg",
      chain: ChainId.Polygon,
      address: mockDefiAgg,
    };
    const stakingModule = {
      chain: ChainId.Polygon,
      address: mockStakingModule,
      abi: StakingModuleAbi,
    };
    const tanIssuanceHistory = {
      chain: ChainId.Polygon,
      address: mockTanIssuanceHistory,
      abi: TanIssuanceHistoryAbi,
    };
    const amirX = { chain: ChainId.Polygon, address: mockAmirX };
    // mock just the executor registry for this test
    jest.doMock("../datasources/ExecutorRegistry", () => ({
      LocalFileExecutorRegistry: jest.fn().mockImplementation(() => ({
        executors: [
          {
            address: mockExecutor,
            developerName: "LOCALHOST",
            developerAddress: zeroAddress,
          },
        ],
      })),
    }));
    const {
      LocalFileExecutorRegistry,
    } = require("../datasources/ExecutorRegistry");
    const mockedExecutorRegistry: jest.Mocked<LocalFileExecutorRegistry> =
      new LocalFileExecutorRegistry();

    // instantiate new calculator with localhost rpc and mock constructor args
    const forkedCalculator = new StakerIncentivesCalculator(
      [tokenTransferHistory],
      [aggregator],
      [stakingModule],
      [tanIssuanceHistory],
      [amirX],
      mockedExecutorRegistry,
      config.incentivesAmounts.stakerIncentivesAmount,
      { [ChainId.Polygon]: startBlock },
      { [ChainId.Polygon]: endBlock }
    );

    const rewards = await forkedCalculator.calculateRewardsPerStaker();

    // formula for deriving rewardsPerUser
    let totalRewardableFees: bigint = 0n;
    Array.from(userFees.entries()).map(([user, fee]) => {
      // if user is referee && not staked, their fees are still counted towards the referrer when the referrer is staked
      if (userStakes.get(user) === 0n) return;

      // add staker's own fees
      console.log(`${user} is staked, adding ${fee}`);
      totalRewardableFees += fee;

      // if staker is a referrer, add referees' fees
      const referees = referralRelationships.get(user);
      if (referees) {
        // referees will be undefined if there are none (not empty array)
        referees!.forEach((referee) => {
          const refereesFees = userFees.get(referee);
          console.log(
            `${user} referred ${referee}, adding referee's fees: ${refereesFees}`
          );
          totalRewardableFees += refereesFees!;
        });
      }
    });

    console.log(`total fees: ${totalRewardableFees}`);

    const expectedRewards = new Map<Address, bigint>();
    for (const user of users) {
      // skip unstaked users
      const rewardsCap = userStakes.get(user);
      if (rewardsCap === 0n) continue;

      const usersFees = userFees.get(user);

      const userReferees = referralRelationships.get(user);
      let refereesFees: bigint = 0n;
      if (userReferees) {
        userReferees!.forEach((referee) => {
          refereesFees += userFees.get(referee)!;
        });
      }

      const totalEligibleFees = usersFees! + refereesFees;

      const scaledReward =
        (totalEligibleFees *
          config.incentivesAmounts.stakerIncentivesAmount *
          1_000_000_000_000_000n) /
        totalRewardableFees;
      let expectedReward = scaledReward / 1_000_000_000_000_000n;

      if (rewardsCap! < expectedReward) {
        expectedReward = rewardsCap!;
      }

      if (expectedReward !== 0n) expectedRewards.set(user, expectedReward);
    }

    // debugging
    // console.log(users);
    // console.log(referralRelationships);
    // console.log(userStakes);
    // console.log(userFees);

    expect(rewards).toEqual(expectedRewards);
  }, 30_000);
});
