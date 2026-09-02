import {
  Address,
  decodeFunctionData,
  getAddress,
  PublicClient,
  zeroAddress,
} from "viem";
import { ICalculator, UserMetadata, UserRewardEntry } from "./ICalculator";
import { BaseExecutorRegistry } from "../datasources/ExecutorRegistry";
import { ChainId } from "../config";
import {
  TokenTransfer,
  TokenTransferHistory,
  TokenTransferWithCalldata,
} from "../datasources/TokenTransferHistory";
import { AmirX } from "../data/amirXs";
import { StakingModule } from "../data/stakingModules";
import { AmirXAbi, StakingModuleAbi, TanIssuanceHistoryAbi } from "../abi/abi";
import { TanIssuanceHistory } from "../data/tanIssuanceHistories";

/**
 * This class calculates TAN stakers' referrals incentives.
 *
 * `Stakers` are Telcoin mobile app users who have posted nonzero TEL stake
 * to the Telcoin `StakingModule` contract, extended by a `SimplePlugin`
 * `Referees` are users who have supplied a referral code from another TAN user
 * `Referrers` are users who have referred one or more `Referees`
 * `Stakers'` who are also `Referees` are eligible for rewards based on their own user fees
 * `Stakers` who are both `Referees` AND `Referrers` are also eligible for rewards
 * based on their `Referees` user fees. This is in addition to the eligibility
 * of their own user fees.
 *
 * This class works across multiple chains.
 */

type UserFeeSwap = {
  txHash: `0x${string}`;
  userAddress: `0x${string}`;
  userFee: bigint;
  isRefereeSwap: boolean; // true for `UserFeeSwap`s associated with a referrer, false for a wallet
};

type OnchainRewardData = {
  chain: ChainId;
  userStake: bigint;
  prevCumulativeRewards: bigint;
};

/**
 * A single entry of an account's sTEL vote history on the StakingModule.
 *
 * `StakingModule` is an `ERC20Votes` token that auto-self-delegates on first receipt, so an
 * account's votes track its staked balance and `votes` is the balance in effect from
 * `blockNumber` onward, until the next checkpoint.
 */
export type VoteCheckpoint = {
  blockNumber: bigint;
  votes: bigint;
};

export class StakerIncentivesCalculator implements ICalculator<UserRewardEntry> {
  constructor(
    private readonly _tokenTransferHistories: TokenTransferHistory[],
    private readonly _stakingModules: StakingModule[],
    private readonly _tanIssuanceHistories: TanIssuanceHistory[],
    private readonly _amirXs: AmirX[],
    private readonly _executorRegistry: BaseExecutorRegistry,
    private readonly _totalIncentiveAmount: bigint,
    private readonly _startBlocks: Partial<{ [chain in ChainId]: bigint }>,
    private readonly _endBlocks: Partial<{ [chain in ChainId]: bigint }>,
  ) {
    // arity checks for initialization in multichain context
    const transfersChains = _tokenTransferHistories.map((db) => db.token.chain);
    const stakingModulesChains = _stakingModules.map(
      (stakingModule) => stakingModule.chain,
    );
    const amirXsChains = _amirXs.map((amirX) => amirX.chain);
    const arrays = [transfersChains, stakingModulesChains, amirXsChains];
    if (
      !arrays.every((chains) =>
        chains.every((chain) => transfersChains.includes(chain)),
      )
    ) {
      throw new Error("All input arrays must have the same chains.");
    }

    // Ensure start and end blocks are specified for each chain
    if (
      ![...transfersChains].every((chain) => {
        const chainId: ChainId = chain;
        return (
          _startBlocks[chainId] !== undefined &&
          _endBlocks[chainId] !== undefined
        );
      })
    ) {
      throw new Error("Start and end blocks must be specified for each chain.");
    }
  }

  /**
   * @dev First identifies multichain user fees over the period, ie transfer events to AmirX
   * @dev Then ensures all txs were initiated by executors so nobody can falsify user fees
   * @returns An array of user fee payments, represented as `TokenTransfer`s
   */
  async fetchUserFeeTransfers(): Promise<TokenTransferWithCalldata[]> {
    const amirXs = new Set(this._amirXs.map((amirX) => amirX.address));
    const executors = new Set<Address>(
      this._executorRegistry.executors.map((executor) => executor.address),
    );

    const filteredTransfers: TokenTransfer[] = [];
    let executorTxHashToCalldata = new Map<`0x${string}`, `0x${string}`>();
    for (const history of this._tokenTransferHistories) {
      const client = history.client;
      // search all transfers in TokenTransferHistorys for transfers to AmirX
      for (const transfer of history.transfers) {
        if (amirXs.has(transfer.to)) {
          const tx = await client.getTransaction({ hash: transfer.txHash });

          // select txs originating from executors and extract tx hash => calldata into map
          if (executors.has(getAddress(tx.from))) {
            filteredTransfers.push(transfer);
            executorTxHashToCalldata.set(tx.hash, tx.input);
          }
        }
      }
    }

    // append calldata to `TokenTransfer`s to construct `TokenTransferWithCalldata`s
    const userFeeTransfers: TokenTransferWithCalldata[] = filteredTransfers.map(
      (transfer) => {
        return {
          ...transfer,
          calldata: executorTxHashToCalldata.get(transfer.txHash)!,
        };
      },
    );

    return userFeeTransfers;
  }

  /**
   * @notice A user who is staked is eligible for rewards equal to their pro-rata share of total eligible user fee volume
   * A user who is staked is *ALSO* eligible for rewards equal to the total sum of their referred users' fees (in addition to their own)
   * @returns A map of staker addresses eligible for issuance rewards to their issuance reward amount for the [startBlock:endBlock] period
   */
  async calculateRewardsPerStaker(): Promise<Map<Address, UserRewardEntry>> {
    console.log("Fetching UserFeeTransfers...");
    const userFeeTransfers = await this.fetchUserFeeTransfers();

    // A settled period always has user fees. Finding none means the inputs are wrong rather than
    // the week being quiet: the wrong TEL token is configured for the chain, the AmirX set is
    // stale, or the block range is. Left unchecked this publishes an empty reward file with no
    // error, so refuse to produce a distribution off it.
    if (userFeeTransfers.length === 0) {
      throw new Error(
        "No user fee transfers found for this period. Check that config.telToken matches the token " +
          "AmirX actually collects fees in, that data/amirXs.ts is current, and that the block range " +
          "is correct.",
      );
    }

    console.log("Fetching onchain data for eligible (staked) users");
    const [eligibleStakerSwaps, addressToRewardDatas] =
      await this.fetchOnchainData(userFeeTransfers);

    // calculate volume of total fee eligibility per user by summing user fees along protocol rules
    const stakerToStakerFeeTotals = new Map<Address, UserMetadata>();
    console.log("Calculating volume of total fee eligibility per user...");
    // ordered processing bc `updateStakerFeeTotals()` writes to shared state
    for (const eligibleSwap of eligibleStakerSwaps) {
      // user collisions are expected and summed agnostically provided they are staked
      // because userFees for staked Referees are double counted: once for themselves and again for their referrer (if staked)
      this.updateStakerFeeTotals(
        stakerToStakerFeeTotals,
        addressToRewardDatas,
        eligibleSwap.userAddress,
        eligibleSwap.userFee,
        eligibleSwap.isRefereeSwap,
      );
    }

    // derive reward caps
    const addressToRewardCap = new Map<Address, bigint>();
    console.log("Deriving rewards caps...");
    Array.from(addressToRewardDatas.keys()).forEach((address) => {
      const onchainDatas = addressToRewardDatas.get(address);

      // accrue rewards cap over multichain context
      let rewardCapAcrossChains: bigint = 0n;
      for (const onchainData of onchainDatas!) {
        const currentChainRewardCap =
          onchainData.userStake - onchainData.prevCumulativeRewards;
        // users who have removed their stake on one chain should not be penalized by their previous rewards
        if (currentChainRewardCap > 0)
          rewardCapAcrossChains += currentChainRewardCap;
      }

      // set map of address to its reward cap
      addressToRewardCap.set(address, rewardCapAcrossChains);
    });

    // sum total user fees for pro-rata calculation
    const totalFees = eligibleStakerSwaps.reduce(
      (accumulator: bigint, currentSwap: UserFeeSwap) => {
        return accumulator + currentSwap.userFee;
      },
      0n,
    );

    // perform calculation: the ratio of a user's total fees to the total of all fees for the period is equal to the ratio of a user's reward amount to the period's issuance amount
    const stakerToReward = new Map<Address, UserRewardEntry>();
    const decimalScale = 1_000_000_000_000_000n;
    console.log("Calculating rewards and applying caps if appropriate...");
    for (const [staker, feeTotals] of stakerToStakerFeeTotals) {
      const stakerFeeTotal = feeTotals.fees + feeTotals.refereeFees;

      // address rounding and precision loss for cases where vars are unbalanced
      const scaledIncentive =
        (stakerFeeTotal * this._totalIncentiveAmount * decimalScale) /
        totalFees;
      const uncappedAmount = scaledIncentive / decimalScale;

      // addressToRewardCap will contain all relevant stakers since fetching is required for eligibility
      const stakerRewardCap = addressToRewardCap.get(staker);
      if (stakerRewardCap === undefined) {
        throw new Error(`Missing reward cap for staker ${staker}`);
      }

      const userMetadata = {
        uncappedAmount: uncappedAmount,
        stakeCapAmount: stakerRewardCap,
        fees: feeTotals.fees,
        refereeFees: feeTotals.refereeFees,
      };
      // determine if reward cap is applicable; if so it results in a remainder for the period's issuance
      let stakerReward = 0n;
      if (uncappedAmount < stakerRewardCap) {
        stakerReward = uncappedAmount;
      } else {
        stakerReward = stakerRewardCap;
      }

      // Apply fee-based rebate cap: wallet cannot receive more than its own fees paid (xref TANIP: Trading Fee Rebate Program)
      if (stakerReward > feeTotals.fees) {
        stakerReward = feeTotals.fees;
      }

      const rewardEntry = {
        userAddress: staker,
        reward: stakerReward,
        metadata: userMetadata,
      };

      stakerToReward.set(staker, rewardEntry);
    }

    return stakerToReward;
  }

  /**
   * @dev Fetches required onchain data from all chains provided to the `StakerIncentivesCalculator`
   * @returns An array of `UserFeeSwap`s comprising all eligible trades by TEL stakers & referrers
   * and a second map containing all eligible users for the period and their multichain reward datas
   */
  async fetchOnchainData(
    userFeeTransfers: TokenTransferWithCalldata[],
  ): Promise<[UserFeeSwap[], Map<Address, OnchainRewardData[]>]> {
    const addressToOnchainRewardDatas = new Map<Address, OnchainRewardData[]>();

    let eligibleUserFeeSwaps: UserFeeSwap[][] = await Promise.all(
      // map over all chains, delineated by staking modules
      this._stakingModules.map(async (currentChainStakingModule) => {
        // parse user and referrer addresses from `defiSwap()` calldata to construct userFee swaps
        const userFeeSwaps = this.parseToUserFeeSwaps(userFeeTransfers);

        // fetch the existing client from the TokenTransferHistory
        const currentChain = currentChainStakingModule.chain;
        const currentChainTransferHistory = this._tokenTransferHistories.find(
          (tokenHistory) => tokenHistory.token.chain === currentChain,
        );
        const client = currentChainTransferHistory!.client;

        const currentChainTanIssuanceHistory = this._tanIssuanceHistories.find(
          (issuanceHistory) => issuanceHistory.chain === currentChain,
        );

        // every account that appears in a swap, as either the wallet or the referrer
        const accountsOfInterest = new Set<Address>();
        userFeeSwaps.map((swap) => {
          accountsOfInterest.add(swap.userAddress);
        });
        accountsOfInterest.delete(zeroAddress);

        const accountToAverageStake = await this.calculateAvgStakedAmountsPerAccount(
          client,
          currentChainStakingModule.address,
          Array.from(accountsOfInterest),
          this._startBlocks[currentChain]!,
          this._endBlocks[currentChain]!,
        );

        return await this.processUserFeeSwaps(
          userFeeSwaps,
          client,
          currentChainTanIssuanceHistory!.address,
          addressToOnchainRewardDatas,
          accountToAverageStake,
        );
      }),
    );

    return [eligibleUserFeeSwaps.flat(), addressToOnchainRewardDatas];
  }

  /**
   * @dev Reads each account's full sTEL vote checkpoint history from the StakingModule and reduces it
   * to a duration-weighted average stake over `[fromBlock, toBlock]`.
   *
   * The StakingModule keeps these checkpoints as contract storage, so this reads the same source
   * `getPastVotes` resolves against rather than replaying logs. That avoids provider log-range
   * limits entirely, and it means every account is measured the same way whether or not its stake
   * happened to move during the period.
   *
   * @returns A map of account to its duration-weighted average stake. Accounts that held nothing
   * across the whole period map to `0n`.
   */
  async calculateAvgStakedAmountsPerAccount(
    client: PublicClient,
    stakingModule: Address,
    accounts: Address[],
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Map<Address, bigint>> {
    const accountToAverageStake = new Map<Address, bigint>();

    const histories = await Promise.all(
      accounts.map((account) =>
        this.fetchVoteCheckpoints(client, account, stakingModule),
      ),
    );

    accounts.forEach((account, i) => {
      accountToAverageStake.set(
        account,
        this.durationWeightedStake(histories[i], fromBlock, toBlock),
      );
    });

    return accountToAverageStake;
  }

  /**
   * @dev Reduces a checkpoint history to the average stake held across `[fromBlock, toBlock]`,
   * weighting each stake level by the number of blocks it was in effect for.
   *
   * A checkpoint at block `k` with value `v` means the account held `v` from block `k` onward, so
   * the opening balance is the newest checkpoint at or before `fromBlock`, and checkpoints after
   * `toBlock` are ignored.
   */
  durationWeightedStake(
    checkpoints: VoteCheckpoint[],
    fromBlock: bigint,
    toBlock: bigint,
  ): bigint {
    const ordered = [...checkpoints].sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? 0
        : a.blockNumber < b.blockNumber
          ? -1
          : 1,
    );

    // stake in effect at the start of the period
    let currentStake = 0n;
    for (const checkpoint of ordered) {
      if (checkpoint.blockNumber > fromBlock) break;
      currentStake = checkpoint.votes;
    }

    const totalBlocks = toBlock - fromBlock;
    // a single-block period has no duration to weight by, so the opening balance is the answer
    if (totalBlocks <= 0n) return currentStake;

    let totalWeightedStake = 0n;
    let cursor = fromBlock;
    for (const checkpoint of ordered) {
      if (checkpoint.blockNumber <= fromBlock) continue;
      if (checkpoint.blockNumber > toBlock) break;

      totalWeightedStake += currentStake * (checkpoint.blockNumber - cursor);
      currentStake = checkpoint.votes;
      cursor = checkpoint.blockNumber;
    }
    totalWeightedStake += currentStake * (toBlock - cursor);

    return totalWeightedStake / totalBlocks;
  }

  /**
   * @dev Reads every sTEL vote checkpoint recorded for `account`.
   *
   * `numCheckpoints` and `checkpoints` are the standard `ERC20Votes` accessors. The client batches
   * concurrent reads into multicalls, so the per-entry reads collapse into a small number of
   * requests.
   */
  async fetchVoteCheckpoints(
    client: PublicClient,
    account: Address,
    stakingModule: Address,
  ): Promise<VoteCheckpoint[]> {
    // A failed read must not be reported as "no stake". That would silently drop the account's
    // reward cap to zero and pay it nothing, so let the error abort the period instead.
    const numCheckpoints = await client.readContract({
      address: stakingModule,
      abi: StakingModuleAbi,
      functionName: "numCheckpoints",
      args: [account],
    });

    const positions = Array.from({ length: Number(numCheckpoints) }, (_, i) => i);
    const checkpoints = await Promise.all(
      positions.map((pos) =>
        client.readContract({
          address: stakingModule,
          abi: StakingModuleAbi,
          functionName: "checkpoints",
          args: [account, pos],
        }),
      ),
    );

    return checkpoints.map((checkpoint) => ({
      blockNumber: BigInt(checkpoint._key),
      votes: BigInt(checkpoint._value),
    }));
  }

  /**
   * @dev Processes an array of `UserFeeSwaps` by fetching onchain stake and previous cumulative rewards, filtering out unstaked users,
   * and updating the map of user addresses to their `OnchainRewardData`s while handling multichain context
   * as well as potential collisions across iterations between `user` addresses
   */
  private async processUserFeeSwaps(
    userFeeSwaps: UserFeeSwap[],
    client: PublicClient,
    tanIssuanceHistory: Address,
    addressToOnchainRewardDatas: Map<Address, OnchainRewardData[]>,
    accountToAverageStake: Map<Address, bigint>,
  ): Promise<UserFeeSwap[]> {
    const eligibleFeeSwaps: UserFeeSwap[] = [];
    // fetch onchain data for each fee swap to filter out unstaked users and set reward data
    await Promise.all(
      userFeeSwaps.map(async (userFeeSwap) => {
        // TEL token allows 0 transfer amounts and an empty `referrer` address in calldata is encoded as `address(0x0)`
        // skip these cases as they are not relevant for issuance rewards
        if (
          userFeeSwap.userFee === 0n ||
          userFeeSwap.userAddress === zeroAddress
        )
          return;

        // `processAddress` populates `addressToOnchainRewardDatas` with fetched stake, prev rewards
        const userEligible = await this.processAddress(
          userFeeSwap.userAddress,
          client,
          tanIssuanceHistory,
          addressToOnchainRewardDatas,
          accountToAverageStake,
        );
        // if `userFeeSwap` user is eligible for rewards, ie staked, push to return array
        if (userEligible) eligibleFeeSwaps.push(userFeeSwap);
      }),
    );

    return eligibleFeeSwaps;
  }

  /**
   * @returns True if the `UserFeeSwap` user is eligible for rewards and was successfully processed; else false
   * @dev An account is eligible when it held stake at some point during the period, which is exactly
   * when its duration-weighted average stake is nonzero. That average is already known for every
   * account of interest, so the only remaining read is the account's prior cumulative rewards.
   */
  private async processAddress(
    address: Address,
    client: PublicClient,
    tanIssuanceHistory: Address,
    addressToOnchainRewardDatas: Map<Address, OnchainRewardData[]>,
    accountToAverageStake: Map<Address, bigint>,
  ): Promise<boolean> {
    // check if the top level map already contains the user address, ie from another swap iteration or different chain
    const chainId = client.chain!.id as ChainId;
    if (
      this.onchainDataAlreadyFetched(
        address,
        chainId,
        addressToOnchainRewardDatas,
      )
    ) {
      // return true if the address's data has already been fetched,
      // because this function is being invoked for a `UserFeeSwap` which should be processed
      return true;
    }

    const averageStake = accountToAverageStake.get(address) ?? 0n;
    // ignore addresses that are not staked; they are not eligible so their cumulative rewards are irrelevant
    if (averageStake === 0n) return false;

    // query `TANIssuanceHistory` one block before the period ends so that re-running a settled period
    // returns this period's pre-settlement value rather than the next period's
    const currentChainEndBlock = this._endBlocks[chainId]! - 1n;
    const prevCumulativeRewards = await this.fetchCumulativeRewardsAtBlock(
      client,
      address,
      currentChainEndBlock,
      tanIssuanceHistory,
    );
    addressToOnchainRewardDatas.set(address, [
      {
        chain: chainId,
        userStake: averageStake,
        prevCumulativeRewards: prevCumulativeRewards,
      },
    ]);

    // address is eligible (ie staked) and has been processed (ie added to `addressToOnchainRewardDatas`)
    return true;
  }

  /**
   * @dev Checks whether onchain data, ie stake and cumulative rewards, has already been fetched for given `address`
   */
  private onchainDataAlreadyFetched(
    address: Address,
    chainId: ChainId,
    addressToOnchainRewardDatas: Map<Address, OnchainRewardData[]>,
  ): boolean {
    // if the key is not present, stake and cumulative rewards definitely have not yet been fetched
    if (!addressToOnchainRewardDatas.has(address)) return false;

    // check whether `addressToOnchainRewardDatas` already has an entry for the current chain
    const chainDatas = addressToOnchainRewardDatas.get(address);
    return (
      chainDatas!.some((chainData) => chainData.chain === chainId) ?? false
    );
  }

  /**
   * @returns Two `UserFeeSwap`s per `tokenTransfer`, one for each the `wallet` and `referrer` within calldata
   * This duplication abstracts wallets and referrers to users so that `UserFeeSwap`s can be processed agnostically
   */
  private parseToUserFeeSwaps(
    tokenTransfers: TokenTransferWithCalldata[],
  ): UserFeeSwap[] {
    const defiSwapSelector = "0x9a249c41";

    return tokenTransfers
      .filter((transfer) => {
        // include only transactions where `transfer.calldata[0:4] == AmirX.defiSwap.selector`
        return transfer.calldata.startsWith(defiSwapSelector);
      })
      .map((transfer) => {
        const { args } = decodeFunctionData({
          abi: AmirXAbi,
          data: transfer.calldata,
        });
        const defiSwap = args[1] as { referrer: `0x${string}` };

        // return populated UserFeeSwaps
        return [
          {
            txHash: transfer.txHash,
            userAddress: args[0]!,
            userFee: transfer.amount,
            isRefereeSwap: false,
          },
          {
            txHash: transfer.txHash,
            userAddress: defiSwap.referrer,
            userFee: transfer.amount,
            isRefereeSwap: true,
          },
        ];
      })
      .flat();
  }

  private updateStakerFeeTotals(
    stakerFeeTotalsMap: Map<Address, UserMetadata>,
    stakerMap: Map<Address, OnchainRewardData[]>,
    address: Address,
    amount: bigint,
    isRefereeSwap: boolean,
  ) {
    // skip zero address & nonstakers; handled earlier in execution but reiterates `UserFeeSwap` values can be 0
    if (address === zeroAddress || !stakerMap.has(address)) return;

    // get existing map entry if it exists, else initialize a new default one
    const feeTotals = stakerFeeTotalsMap.get(address) || {
      fees: 0n,
      refereeFees: 0n,
    };
    // update relevant member based on `isRefereeSwap`
    if (isRefereeSwap) {
      feeTotals.refereeFees += amount;
    } else {
      feeTotals.fees += amount;
    }

    // overwrite map entry with the incremented value
    stakerFeeTotalsMap.set(address, feeTotals);
  }

  async fetchCumulativeRewardsAtBlock(
    client: PublicClient,
    userAddress: Address,
    endBlock: bigint,
    tanIssuanceHistory: Address,
  ): Promise<bigint> {
    // A failed read must not be reported as zero prior rewards. That would lift the account's reward
    // cap to its full stake and overpay it, so let the error abort the period instead.
    return await client.readContract({
      address: tanIssuanceHistory,
      abi: TanIssuanceHistoryAbi,
      functionName: "cumulativeRewardsAtBlock",
      args: [userAddress, endBlock],
    });
  }

  /**
   * @returns A map of developer addresses to the amount of incentives they should receive
   */
  async calculate(): Promise<Map<Address, UserRewardEntry>> {
    return await this.calculateRewardsPerStaker();
  }
}
