import {
  TokenTransferHistory,
  TokenTransferWithCalldata,
} from "../datasources/TokenTransferHistory";
import {
  BaseExecutorRegistry,
  LocalFileExecutorRegistry,
} from "../datasources/ExecutorRegistry";
import { ChainId, config } from "../config";
import { executors } from "../data/executors";
import { aggregators } from "../data/aggregators";
import { amirXs } from "../data/amirXs";
import { stakingModules } from "../data/stakingModules";
import { StakerIncentivesCalculator } from "../calculators/StakerIncentivesCalculator";
import {
  mockToken,
  mockTelTransfers,
  expectedUserFeeTransfers,
} from "./dummydata/mockTransfers";
import {
  transactionTemplate,
  mockTransferTransactions,
} from "./dummydata/transactionTemplate";
import {
  Address,
  createPublicClient,
  encodeFunctionData,
  http,
  PublicActions,
  PublicClient,
  Transaction,
  zeroAddress,
} from "viem";
import { tanIssuanceHistories } from "../data/tanIssuanceHistories";
import AmirXAbi from "../abi/AmirXAbi";
import {
  mockDefiSwap,
  getRandomBigInt,
  generateMockHex,
  generateRandomReferralRelationships,
} from "../helpers";
import { polygon } from "viem/chains";

/**
 * Config
 */

// use arbitrary block with actual pulled transfers from 388 blocks in `mockTransfers.ts`
const arbitraryStartBlock = 66660433n;
const arbitraryEndBlock = 66660821n;

// use prod executor
const executor1 = executors[0].address;

// signals for simplified asserts
const stakerSignal = "0x11111111";
const nonstakerSignal = "0x00000000";

/**
 * Helpers
 */

function generateTestTokenTransfer(
  iterator: number,
  referrer: Address,
  referee: Address
): TokenTransferWithCalldata {
  const testDefiSwap = {
    ...mockDefiSwap,
    referrer: referrer,
  };
  const calldata: `0x${string}` = encodeFunctionData({
    abi: AmirXAbi,
    functionName: "defiSwap",
    args: [referee, testDefiSwap],
  });

  return {
    token: mockToken,
    from: executor1,
    to: amirXs[0].address,
    amount: BigInt((iterator + 1) * 100), // incremental amounts for simplicity
    txHash: generateMockHex(64, iterator, false), // enumerated pretty tx hash
    blockNumber: getRandomBigInt(1, 300000), // Random block number
    calldata: calldata,
  };
}

function createTestTransfers(
  relationships: Map<Address, Address[]>
): TokenTransferWithCalldata[] {
  const transfers: TokenTransferWithCalldata[] = [];

  let index = 0;
  for (const [referrer, referees] of relationships.entries()) {
    referees.forEach((referee) => {
      transfers.push(generateTestTokenTransfer(index, referrer, referee));
      index++;
    });
  }
  return transfers;
}

/**
 * Mocks
 */

// mock the TokenTransferHistory with actual data to save on RPC calls to API
jest.mock("../datasources/TokenTransferHistory", () => {
  return {
    TokenTransferHistory: jest.fn().mockImplementation(() => ({
      client: createPublicClient({
        chain: polygon,
        transport: http(config.rpcUrls[polygon.id]),
      }),
      token: mockToken,
      startBlock: arbitraryStartBlock,
      endBlock: arbitraryEndBlock,
      showLogs: false,
      transfers: mockTelTransfers,
      fetchTransfers: jest.fn().mockImplementation(() => mockTelTransfers),
    })),
  };
});

/**
 * Tests
 */

describe("StakerIncentivesCalculator", () => {
  let calculator: StakerIncentivesCalculator;

  // mocked constructor args
  let mockTokenTransferHistorys: jest.Mocked<TokenTransferHistory>[];
  // prod constructor args
  let executorRegistry: LocalFileExecutorRegistry;

  beforeEach(async () => {
    // create mock data for calculator constructor
    const mockTokenTransferHistory = new TokenTransferHistory(
      mockToken,
      arbitraryStartBlock,
      arbitraryEndBlock
    ) as jest.Mocked<TokenTransferHistory>;
    // sanity check mock TokenTransferHistory pulled the 123 expected transfers from `mockTransers.ts`
    expect((await mockTokenTransferHistory.fetchTransfers()).length).toBe(123);
    mockTokenTransferHistorys = [mockTokenTransferHistory];

    // use prod user and executor registries
    executorRegistry = new LocalFileExecutorRegistry();

    // instantiate calculator
    calculator = new StakerIncentivesCalculator(
      mockTokenTransferHistorys,
      aggregators,
      stakingModules,
      tanIssuanceHistories,
      amirXs,
      executorRegistry,
      1000n,
      { [ChainId.Polygon]: arbitraryStartBlock },
      { [ChainId.Polygon]: arbitraryEndBlock }
    );

    jest
      .spyOn(calculator, "fetchStake")
      .mockImplementation(
        async (
          client: PublicClient,
          userAddress: Address,
          endBlock: bigint,
          stakingModuleContract: Address
        ): Promise<bigint> => {
          if (userAddress.toString().startsWith(stakerSignal))
            return Promise.resolve(getRandomBigInt(1, 2 ** 32));
          else if (userAddress.toString().startsWith(nonstakerSignal))
            return Promise.resolve(0n);
          else throw new Error("Invalid test data for fetchStake");
        }
      );

    jest
      .spyOn(calculator, "fetchCumulativeRewardsAtBlock")
      .mockImplementation(
        async (
          client: PublicClient,
          address: Address,
          endBlock: bigint,
          tanIssuanceHistory: any
        ): Promise<bigint> => {
          if (address.toString().startsWith(stakerSignal))
            return Promise.resolve(getRandomBigInt(1, 2 ** 32));
          else if (address.toString().startsWith(nonstakerSignal)) return 0n;
          else
            throw new Error(
              "Invalid test data for fetchCumulativeRewardsAtBlock"
            );
        }
      );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Tests for `fetchUserFeeTransfers()`
   */

  it("should return transfers initiated by executor EOAs", async () => {
    const result = await calculator.fetchUserFeeTransfers();
    expect(result).toEqual(expectedUserFeeTransfers);
    expect(result.length).toBe(15);

    // pull expected aggregator addresses
    const aggregator0xSettler = aggregators.find(
      (aggregator) => aggregator.aggregatorName === "0x"
    )?.address;
    const aggregator1Inch = aggregators.find(
      (aggregator) => aggregator.aggregatorName === "1Inch"
    )?.address;
    // ensure transfer `from` attribute matches expected aggregators
    const from0x = result.filter(
      (transfer) => transfer.from === aggregator0xSettler
    );
    expect(from0x.length).toBe(14);
    const from1Inch = result.filter(
      (transfer) => transfer.from === aggregator1Inch
    );
    expect(from1Inch.length).toBe(1);
  });

  it("should return an empty array if no transfers match executor transactions", async () => {
    const impossibleExecutorRegistry = new LocalFileExecutorRegistry();
    Object.defineProperty(impossibleExecutorRegistry, "executors", {
      get: jest.fn().mockReturnValue([
        {
          developerName: "Impossible",
          developerAddress: "0x0000000000000000000000000000000000000000",
          address: "0x0000000000000000000000000000000000000000",
        },
      ]),
    });
    // instantiate new calculator with impossible executor
    const impossibleCalculator = new StakerIncentivesCalculator(
      mockTokenTransferHistorys,
      aggregators,
      stakingModules,
      tanIssuanceHistories,
      amirXs,
      impossibleExecutorRegistry,
      1000n,
      { [ChainId.Polygon]: arbitraryStartBlock },
      { [ChainId.Polygon]: arbitraryEndBlock }
    );

    const result = await impossibleCalculator.fetchUserFeeTransfers();
    expect(result).toEqual([]);
  });

  /**
   * Tests for `fetchOnchainData()`
   */

  it("should return UserFeeSwaps where each txHash is represented twice, once for user and once for referrer", async () => {
    const numUsers = 10;
    const referralRelationships = new Map<Address, Address[]>();
    for (let i = 0; i < numUsers; i++) {
      // for simplicity let's say half are stakers and half nonstakers
      const isStaker = i % 2 === 0;
      const referrer = generateMockHex(40, i, isStaker);
      const referee = generateMockHex(40, i + numUsers / 2, isStaker);

      referralRelationships.set(referrer, [referee]);
    }

    const testTransfers: TokenTransferWithCalldata[] = createTestTransfers(
      referralRelationships
    );

    // half of the users are stakers and half not
    const [userFeeSwaps, _] = await calculator.fetchOnchainData(testTransfers);
    // each txHash with one referee should result in two `UserFeeSwap`s, one for referrer and one for referee
    expect(userFeeSwaps.length).toBe(10);

    // for even numbered addresses (referrers), there should be a duplicate txHash & fee but w/ diff referee addr
    userFeeSwaps.forEach((swap) => {
      const complementarySwap = userFeeSwaps.find(
        (duplicateSwap) =>
          duplicateSwap.txHash === swap.txHash &&
          duplicateSwap.userFee === swap.userFee &&
          BigInt(duplicateSwap.userAddress) !== BigInt(swap.userAddress)
      );
      expect(complementarySwap).toBeDefined();
    });

    // Ensure no duplicates by comparing set size to array length
    const uniqueSwaps = new Set(userFeeSwaps.map((swap) => swap.userAddress));
    expect(uniqueSwaps.size).toEqual(userFeeSwaps.length);
    expect(uniqueSwaps.size).toBe(userFeeSwaps.length);
  }, 8_000);

  it("should only include staked users in OnchainRewardData", async () => {
    const numUsers = 10;
    const referralRelationships = new Map<Address, Address[]>();
    for (let i = 0; i < numUsers; i++) {
      // for simplicity let's say half are stakers and half nonstakers
      const isStaker = i % 2 === 0;
      const referrer = generateMockHex(40, i, isStaker);
      const referee = generateMockHex(40, i + numUsers / 2, isStaker);

      referralRelationships.set(referrer, [referee]);
    }

    const testTransfers: TokenTransferWithCalldata[] = createTestTransfers(
      referralRelationships
    );

    const [userFeeSwaps, addressToOnchainRewardDatas] =
      await calculator.fetchOnchainData(testTransfers);

    for (const validUserFeeSwap of userFeeSwaps) {
      // tests are structured to generate mock addresses left-padded with "1"s when signaling stakers
      const isStaker = validUserFeeSwap.userAddress.startsWith(stakerSignal);
      expect(isStaker).toBe(true);
    }

    for (const [address, onchainData] of addressToOnchainRewardDatas) {
      // ensure all onchain reward datas are populated with nonzero stake amounts
      const nonzeroStakeAmount = onchainData.every(
        (data) => data.userStake > 0n
      );
      expect(nonzeroStakeAmount).toBe(true);

      // ensure address keys in returned onchain reward data are all stakers
      const isStaker = address.startsWith(stakerSignal);
      expect(isStaker).toBe(true);
    }
  });

  it("should return correct stake and prevCumulativeReward for each address", async () => {
    const numUsers = 10;
    const users: Address[] = [];
    for (let i = 0; i < numUsers; i++) {
      // for simplicity let's say half are stakers and half nonstakers
      const isStaker = i % 2 === 0;
      const randomUser = generateMockHex(40, i, isStaker);
      users.push(randomUser);
    }

    const referralRelationships = generateRandomReferralRelationships(users);
    const testTransfers: TokenTransferWithCalldata[] = createTestTransfers(
      referralRelationships
    );

    const [_, addressToOnchainRewardDatas] = await calculator.fetchOnchainData(
      testTransfers
    );

    // todo: populate a map of address to <stakeAmount, prevRewards> in setup and read it for jest spyOn
    for (const [address, onchainDatas] of addressToOnchainRewardDatas) {
      for (const data of onchainDatas) {
        let isExpectedStake;
        let isExpectedPrevCumulativeRewards;
        if (address.toString().startsWith(stakerSignal)) {
          // if marked as staker, stake and cumulative rewards should be set to nonzero value
          isExpectedStake = data.userStake > 1 && data.userStake <= 2 ** 32;
          isExpectedPrevCumulativeRewards =
            data.prevCumulativeRewards > 1 &&
            data.prevCumulativeRewards <= 2 ** 32;

          expect(isExpectedStake).toBe(true);
          expect(isExpectedPrevCumulativeRewards).toBe(true);
        } else {
          // if marked as nonstaker, both should be 0
          isExpectedStake = data.userStake === 0n;
          isExpectedPrevCumulativeRewards = data.prevCumulativeRewards === 0n;

          expect(isExpectedStake).toBe(false);
          expect(isExpectedPrevCumulativeRewards).toBe(false);
        }
      }
    }
  });
});
