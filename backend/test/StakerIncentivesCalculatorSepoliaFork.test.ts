import {
  Address,
  createPublicClient,
  getAddress,
  http,
  PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { ChainId, config } from "../config";
import {
  StakerIncentivesCalculator,
  VoteCheckpoint,
} from "../calculators/StakerIncentivesCalculator";
import StakingModuleAbi from "../abi/StakingModuleAbi";
import { sepoliaDeployments } from "../data/addressBooks";

/**
 * Exercises the V3 stake reader against the live StakingModule on Ethereum Sepolia.
 *
 * V3 removed `StakeChanged` and `stakedByAt`, so the reward cap is now derived from the module's
 * `ERC20Votes` checkpoints. Those checkpoints are only meaningful against real staking activity:
 * accounts that staked in several tranches, accounts that burned sTEL by requesting a withdrawal,
 * and accounts that left entirely. Sepolia has all three, which no mock reproduces faithfully.
 *
 * Reads run against the chain head rather than a pinned block, so the assertions are differential
 * and structural rather than hardcoded totals. New staking activity changes the numbers but not
 * whether the reader agrees with the chain.
 *
 * Requires `ETH_SEPOLIA_RPC_URL`, and is skipped without it.
 */

/**
 * Accounts known to have staked on the Sepolia module. Their histories only ever grow, so naming
 * them keeps the test off an `eth_getLogs` sweep wide enough to trip provider range limits.
 */
const KNOWN_STAKERS: Address[] = [
  getAddress("0xdCe4Ef7679E8A81EEE8c71917b21EbbCef45B5BA"),
  getAddress("0xe1f34e19baA32e320f44dF1325A23a5EB75609c7"),
  getAddress("0xbf0F8a8b779F16887e1497bC796292e97677488d"),
  getAddress("0x91cF188c372E0324183f24Bd0AAd7ecFD3760b8e"),
];

const NEVER_STAKED: Address = getAddress(
  "0x000000000000000000000000000000000000dEaD",
);

const rpcUrl = config.rpcUrls[ChainId.EthSepolia];
const describeOrSkip = rpcUrl ? describe : describe.skip;

describeOrSkip("StakerIncentivesCalculator on the Sepolia V3 StakingModule", () => {
  let client: PublicClient;
  let calculator: StakerIncentivesCalculator;
  let stakingModule: Address;

  /**
   * The same quantity `durationWeightedStake` produces, computed the naive way: walk every block in
   * the window and look up the stake in effect. Obviously correct and obviously slow, which is what
   * makes it a useful check on the segment-weighted version.
   */
  function bruteForceAverage(
    checkpoints: VoteCheckpoint[],
    fromBlock: bigint,
    toBlock: bigint,
  ): bigint {
    if (toBlock <= fromBlock) return stakeAt(checkpoints, fromBlock);

    let total = 0n;
    for (let block = fromBlock; block < toBlock; block++) {
      total += stakeAt(checkpoints, block);
    }

    return total / (toBlock - fromBlock);
  }

  /** The value of the newest checkpoint at or before `block`, or zero if there is none. */
  function stakeAt(checkpoints: VoteCheckpoint[], block: bigint): bigint {
    let stake = 0n;
    for (const checkpoint of checkpoints) {
      if (checkpoint.blockNumber > block) break;
      stake = checkpoint.votes;
    }
    return stake;
  }

  beforeAll(() => {
    client = createPublicClient({
      batch: { multicall: true },
      chain: sepolia,
      transport: http(rpcUrl, { batch: true }),
    }) as PublicClient;

    stakingModule = sepoliaDeployments.StakingModule;

    // only the stake reader is under test here, so the rest of the constructor is given the minimum
    // it validates: one chain, with the contracts that chain's reward cap is read from
    calculator = new StakerIncentivesCalculator(
      [{ token: config.telToken[ChainId.EthSepolia] } as any],
      [
        {
          chain: ChainId.EthSepolia,
          address: stakingModule,
          abi: StakingModuleAbi,
        } as any,
      ],
      [
        {
          chain: ChainId.EthSepolia,
          address: stakingModule,
          abi: StakingModuleAbi,
        } as any,
      ],
      [],
      { executors: [] } as any,
      config.incentivesAmounts.stakerIncentivesAmount,
      { [ChainId.EthSepolia]: 0n },
      { [ChainId.EthSepolia]: 1n },
    );
  });

  it("reads a checkpoint history whose keys are ascending block numbers", async () => {
    const histories = await Promise.all(
      KNOWN_STAKERS.map((account) =>
        calculator.fetchVoteCheckpoints(client, account, stakingModule),
      ),
    );

    // an environment where nobody has staked would let every assertion below pass vacuously
    const totalCheckpoints = histories.reduce(
      (sum, history) => sum + history.length,
      0,
    );
    expect(totalCheckpoints).toBeGreaterThan(0);

    const head = await client.getBlockNumber();
    for (const history of histories) {
      for (let i = 1; i < history.length; i++) {
        expect(history[i]!.blockNumber).toBeGreaterThan(
          history[i - 1]!.blockNumber,
        );
      }
      for (const checkpoint of history) {
        // the module leaves `clock()` at its default, so keys are block numbers, not timestamps
        expect(checkpoint.blockNumber).toBeLessThanOrEqual(head);
      }
    }
  }, 60_000);

  it("agrees with getPastVotes at every checkpoint boundary", async () => {
    const account = KNOWN_STAKERS[2]!;
    const history = await calculator.fetchVoteCheckpoints(
      client,
      account,
      stakingModule,
    );
    expect(history.length).toBeGreaterThan(1);

    for (const checkpoint of history) {
      const [atCheckpoint, justBefore] = await Promise.all([
        client.readContract({
          address: stakingModule,
          abi: StakingModuleAbi,
          functionName: "getPastVotes",
          args: [account, checkpoint.blockNumber],
        }),
        client.readContract({
          address: stakingModule,
          abi: StakingModuleAbi,
          functionName: "getPastVotes",
          args: [account, checkpoint.blockNumber - 1n],
        }),
      ]);

      // a checkpoint at block k means the account holds that value from k onward
      expect(atCheckpoint).toBe(checkpoint.votes);
      expect(justBefore).toBe(stakeAt(history, checkpoint.blockNumber - 1n));
    }
  }, 60_000);

  it("ends its history at the account's current sTEL balance", async () => {
    for (const account of KNOWN_STAKERS) {
      const history = await calculator.fetchVoteCheckpoints(
        client,
        account,
        stakingModule,
      );
      const balance = await client.readContract({
        address: stakingModule,
        abi: StakingModuleAbi,
        functionName: "balanceOf",
        args: [account],
      });

      // staking self-delegates on receipt, so votes and balance stay equal
      const latest = history.length === 0 ? 0n : history[history.length - 1]!.votes;
      expect(latest).toBe(balance);
    }
  }, 60_000);

  it("weights stake by the blocks it was held for", async () => {
    const account = KNOWN_STAKERS[2]!;
    const history = await calculator.fetchVoteCheckpoints(
      client,
      account,
      stakingModule,
    );
    expect(history.length).toBeGreaterThan(1);

    // a window straddling the account's real activity, so the average has something to average over
    const fromBlock = history[0]!.blockNumber - 50n;
    const toBlock = history[history.length - 1]!.blockNumber + 50n;

    expect(calculator.durationWeightedStake(history, fromBlock, toBlock)).toBe(
      bruteForceAverage(history, fromBlock, toBlock),
    );

    // the average has to sit inside the range of levels actually held
    const levels = [0n, ...history.map((checkpoint) => checkpoint.votes)];
    const average = calculator.durationWeightedStake(
      history,
      fromBlock,
      toBlock,
    );
    expect(average).toBeGreaterThanOrEqual(
      levels.reduce((min, level) => (level < min ? level : min)),
    );
    expect(average).toBeLessThanOrEqual(
      levels.reduce((max, level) => (level > max ? level : max)),
    );
  }, 60_000);

  it("carries the opening balance through a window with no checkpoint in it", async () => {
    const account = KNOWN_STAKERS[2]!;
    const history = await calculator.fetchVoteCheckpoints(
      client,
      account,
      stakingModule,
    );
    expect(history.length).toBeGreaterThan(0);

    const last = history[history.length - 1]!;
    const fromBlock = last.blockNumber + 1n;
    const toBlock = fromBlock + 500n;

    // nothing moved in this window, so the weighted average collapses to the level held throughout
    expect(calculator.durationWeightedStake(history, fromBlock, toBlock)).toBe(
      last.votes,
    );
  }, 60_000);

  it("reports zero for an account that never staked", async () => {
    const history = await calculator.fetchVoteCheckpoints(
      client,
      NEVER_STAKED,
      stakingModule,
    );

    expect(history).toEqual([]);
    expect(calculator.durationWeightedStake(history, 0n, 1000n)).toBe(0n);
  }, 60_000);

  it("batches every account into one average-stake map", async () => {
    const accounts = [...KNOWN_STAKERS, NEVER_STAKED];
    const histories = await Promise.all(
      accounts.map((account) =>
        calculator.fetchVoteCheckpoints(client, account, stakingModule),
      ),
    );

    const withHistory = histories.filter((history) => history.length > 0);
    expect(withHistory.length).toBeGreaterThan(0);
    const fromBlock =
      withHistory.reduce(
        (min, history) =>
          history[0]!.blockNumber < min ? history[0]!.blockNumber : min,
        withHistory[0]![0]!.blockNumber,
      ) - 10n;
    const toBlock = await client.getBlockNumber();

    const averages = await calculator.calculateAvgStakedAmountsPerAccount(
      client,
      stakingModule,
      accounts,
      fromBlock,
      toBlock,
    );

    expect(averages.size).toBe(accounts.length);
    accounts.forEach((account, i) => {
      expect(averages.get(account)).toBe(
        calculator.durationWeightedStake(histories[i]!, fromBlock, toBlock),
      );
    });
    expect(averages.get(NEVER_STAKED)).toBe(0n);
  }, 120_000);
});
