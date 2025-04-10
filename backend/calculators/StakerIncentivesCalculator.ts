import {
  AbiEvent,
  Address,
  decodeFunctionData,
  getAbiItem,
  getAddress,
  GetLogsReturnType,
  PublicClient,
  zeroAddress,
} from "viem";
import {ICalculator, UserMetadata, UserRewardEntry} from "./ICalculator";
import {BaseExecutorRegistry} from "../datasources/ExecutorRegistry";
import {ChainId} from "../config";
import {TokenTransfer, TokenTransferHistory, TokenTransferWithCalldata,} from "../datasources/TokenTransferHistory";
import {AmirX} from "../data/amirXs";
import {StakingModule} from "../data/stakingModules";
import {AmirXAbi, StakingModuleAbi, TanIssuanceHistoryAbi} from "../abi/abi";
import {TanIssuanceHistory} from "../data/tanIssuanceHistories";

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

export type StakeChangedEvent = {
  account: Address;
  blockNumber: bigint;
  oldStake: bigint;
  newStake: bigint;
};

export class StakerIncentivesCalculator
  implements ICalculator<UserRewardEntry>
{
  constructor(
    private readonly _tokenTransferHistories: TokenTransferHistory[],
    private readonly _stakingModules: StakingModule[],
    private readonly _tanIssuanceHistories: TanIssuanceHistory[],
    private readonly _amirXs: AmirX[],
    private readonly _executorRegistry: BaseExecutorRegistry,
    private readonly _totalIncentiveAmount: bigint,
    private readonly _startBlocks: Partial<{ [chain in ChainId]: bigint }>,
    private readonly _endBlocks: Partial<{ [chain in ChainId]: bigint }>
  ) {
    // arity checks for initialization in multichain context
    const transfersChains = _tokenTransferHistories.map((db) => db.token.chain);
    const stakingModulesChains = _stakingModules.map(
      (stakingModule) => stakingModule.chain
    );
    const amirXsChains = _amirXs.map((amirX) => amirX.chain);
    const arrays = [transfersChains, stakingModulesChains, amirXsChains];
    if (
      !arrays.every((chains) =>
        chains.every((chain) => transfersChains.includes(chain))
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
      this._executorRegistry.executors.map((executor) => executor.address)
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
      }
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
        eligibleSwap.isRefereeSwap
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
      0n
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
      const userMetadata = {
        uncappedAmount: uncappedAmount,
        fees: feeTotals.fees,
        refereeFees: feeTotals.refereeFees,
      };

      // addressToRewardCap will contain all relevant stakers since fetching is required for eligibility
      const stakerRewardCap = addressToRewardCap.get(staker);
      // determine if reward cap is applicable; if so it results in a remainder for the period's issuance
      let stakerReward = 0n;
      if (uncappedAmount < stakerRewardCap!) {
        stakerReward = uncappedAmount;
      } else {
        stakerReward = stakerRewardCap!;
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
    userFeeTransfers: TokenTransferWithCalldata[]
  ): Promise<[UserFeeSwap[], Map<Address, OnchainRewardData[]>]> {
    const addressToOnchainRewardDatas = new Map<Address, OnchainRewardData[]>();

    // note that this entire block could be replaced with a solidity checkpoint reading function on the StakingModule
    let eligibleUserFeeSwaps: UserFeeSwap[][] = await Promise.all(
      // map over all chains, delineated by staking modules
      this._stakingModules.map(async (currentChainStakingModule) => {
        // parse user and referrer addresses from `defiSwap()` calldata to construct userFee swaps
        const userFeeSwaps = this.parseToUserFeeSwaps(userFeeTransfers);

        // fetch the existing client from the TokenTransferHistory
        const currentChain = currentChainStakingModule.chain;
        const currentChainTransferHistory = this._tokenTransferHistories.find(
          (tokenHistory) => tokenHistory.token.chain === currentChain
        );
        const client = currentChainTransferHistory!.client;

        const currentChainTanIssuanceHistory = this._tanIssuanceHistories.find(
          (issuanceHistory) => issuanceHistory.chain === currentChain
        );

        // fetch `StakingModule::StakeChanged()` events to identify lowest stake balance during period and update rewardDatas
        const stakeChangedAbiItem = getAbiItem({
          abi: currentChainStakingModule.abi,
          name: "StakeChanged",
        });
        // create set to filter stake changed events for those including users or referrers
        const accountsOfInterest = new Set<Address>();
        userFeeSwaps.map((swap) => {
          accountsOfInterest.add(swap.userAddress);
        });
        
        const stakeChangedEvents = await this.fetchStakeChangedEvents(
            client,
            currentChainStakingModule.address,
            stakeChangedAbiItem as AbiEvent,
            {account: Array.from(accountsOfInterest)},
            this._startBlocks[currentChain]!,
            this._endBlocks[currentChain]!)
        
        const accountToAverageStake = await this.CalculateAvgStakedAmountsPerAccount(
            stakeChangedEvents,
            this._startBlocks[currentChain]!,
            this._endBlocks[currentChain]!);
        

        return await this.processUserFeeSwaps(
          userFeeSwaps,
          client,
          currentChainStakingModule.address,
          currentChainTanIssuanceHistory!.address,
          addressToOnchainRewardDatas,
          accountToAverageStake
        );
      })
    );

    return [eligibleUserFeeSwaps.flat(), addressToOnchainRewardDatas];
  }
  
  async CalculateAvgStakedAmountsPerAccount(
      stakeChangedEvents: StakeChangedEvent[],
      fromBlock: bigint,
      toBlock: bigint,
  ): Promise<Map<Address, bigint>> {

    // populate a map of Address => newStakeAmount which will be used to skip RPC calls to `StakingModule::stakedByAt()`
    const accountToLowestStake = new Map<Address, bigint>();
    
    // Group stakeChangedEvents by their `args.account`
    const groupedStakeChangedEvents = stakeChangedEvents.reduce((grouped, event) => {

      if (!grouped.has(event.account)) {
        grouped.set(event.account, []);
      }
      grouped.get(event.account)!.push(event);
      return grouped;
    }, new Map<Address, typeof stakeChangedEvents>());

    // Loop over the grouping and log account and its corresponding events
    groupedStakeChangedEvents.forEach((events, account) => {
      events.sort((a, b) => (a.blockNumber > b.blockNumber ? 1 : -1));

      let lowestBlockNumber = fromBlock;


      const stakedAmount: { blocks: bigint; stake: bigint }[] = [];
      for (let i = 0; i < events.length; i++) {
        
        stakedAmount.push({
          blocks: events[i].blockNumber - lowestBlockNumber!,
          stake: events[i].oldStake
        })


        if(i == (events.length - 1)){
          stakedAmount.push({
            blocks: toBlock! - events[i].blockNumber,
            stake: events[i].newStake
          })
        }

        lowestBlockNumber = events[i].blockNumber;

      }

      // calculate the total number of blocks available in our period here. 
      const totalBlocks =
          (toBlock ?? 0n) - (fromBlock ?? 0n);

      // Calculate the total staked amount weighted by the duration for each stake period
      let totalWeightedStake = 0n;
      let totalDuration = 0n;

      stakedAmount.forEach(({blocks, stake}) => {
        totalWeightedStake += stake * blocks;
      });

      // Calculate the average stake over the total duration and total blocks
      const averageStakeOverTime = totalWeightedStake / totalBlocks;

      accountToLowestStake.set(account, averageStakeOverTime);
    });
    
    return accountToLowestStake;
  }

  /**
   * @dev Processes an array of `UserFeeSwaps` by fetching onchain stake and previous cumulative rewards, filtering out unstaked users,
   * and updating the map of user addresses to their `OnchainRewardData`s while handling multichain context
   * as well as potential collisions across iterations between `user` addresses
   */
  private async processUserFeeSwaps(
    userFeeSwaps: UserFeeSwap[],
    client: PublicClient,
    stakingModuleContract: Address,
    tanIssuanceHistory: Address,
    addressToOnchainRewardDatas: Map<Address, OnchainRewardData[]>,
    accountToAverageStake: Map<Address, bigint>
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
          stakingModuleContract,
          tanIssuanceHistory,
          addressToOnchainRewardDatas,
          accountToAverageStake
        );
        // if `userFeeSwap` user is eligible for rewards, ie staked, push to return array
        if (userEligible) eligibleFeeSwaps.push(userFeeSwap);
      })
    );

    return eligibleFeeSwaps;
  }

  /**
   * @returns True if the `UserFeeSwap` user is eligible for rewards and was successfully processed; else false
   * @dev Checks whether onchain data, ie stake and cumulative rewards, has already been fetched for given `address`
   * If not, cross reference `address` against known stake changes previously detected from `StakeChanged` events
   * If a change in stake for `address` was emitted, stake is known so only fetch cumulative rewards and return true
   * If no stake change was emitted, fetch the stake. If 0, return false. If > 0, fetch cumulative rewards and return true
   */
  private async processAddress(
    address: Address,
    client: PublicClient,
    stakingModuleContract: Address,
    tanIssuanceHistory: Address,
    addressToOnchainRewardDatas: Map<Address, OnchainRewardData[]>,
    accountToAverageStake: Map<Address, bigint>
  ): Promise<boolean> {
    // check if the top level map already contains the user address, ie from another swap iteration or different chain
    const chainId = client.chain!.id as ChainId;
    if (
      this.onchainDataAlreadyFetched(
        address,
        chainId,
        addressToOnchainRewardDatas
      )
    ) {
      // return true if the address's data has already been fetched,
      // because this function is being invoked for a `UserFeeSwap` which should be processed
      return true;
    }

    // query `TANIssuanceHistory` contract with period's start block so runs on settled periods
    // return cumulative rewards for this period's pre-settlement value and not the next period's
    const currentChainEndBlock = this._endBlocks[chainId]! - 1n;
    const existingAverageStake = accountToAverageStake.get(address);
    // check whether the account's lowest stake for the period was detected from `StakeChanged` events
    if (existingAverageStake) {
      // if nonzero lowest stake was identified by `StakeChanged` events, only fetch cumulative rewards
      const prevCumulativeRewards = await this.fetchCumulativeRewardsAtBlock(
        client,
        address,
        currentChainEndBlock,
        tanIssuanceHistory
      );
      addressToOnchainRewardDatas.set(address, [
        {
          chain: chainId,
          userStake: existingAverageStake!,
          prevCumulativeRewards: prevCumulativeRewards,
        },
      ]);

      // no more RPC calls necessary when the account's lowest stake was discerned from `StakeChanged` events
      // in which case this function is being invoked for a `UserFeeSwap` that should be processed
      return true;
    } else {
      // account's stake did not emit a change event during the period so it must be fetched
      console.log(
        `No StakeChanged events during period for ${address}, fetching from StakingModule`
      );
      const stake = await this.fetchStake(
        client,
        address,
        currentChainEndBlock,
        stakingModuleContract
      );

      // ignore addresses that are not staked; they are not eligible so their cumulative rewards are irrelevant
      if (stake !== 0n) {
        console.log(
          `Nonzero stake returned for ${address}: ${stake} TEL, fetching cumulative rewards`
        );
        const prevCumulativeRewards = await this.fetchCumulativeRewardsAtBlock(
          client,
          address,
          currentChainEndBlock,
          tanIssuanceHistory
        );
        addressToOnchainRewardDatas.set(address, [
          {
            chain: chainId,
            userStake: stake,
            prevCumulativeRewards: prevCumulativeRewards,
          },
        ]);

        // address is eligible (ie staked) and has been processed (ie added to `addressToOnchainRewardDatas`)
        return true;
      }
    }

    // address did not meet eligibility criteria
    return false;
  }

  /**
   * @dev Checks whether onchain data, ie stake and cumulative rewards, has already been fetched for given `address`
   */
  private onchainDataAlreadyFetched(
    address: Address,
    chainId: ChainId,
    addressToOnchainRewardDatas: Map<Address, OnchainRewardData[]>
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
    tokenTransfers: TokenTransferWithCalldata[]
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
    isRefereeSwap: boolean
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

  async fetchStakeChangedEvents(
      client: PublicClient,
      stakingModuleAddress: Address,
      stakeChangedEvent: AbiEvent,
      args: {account: Address[]},
      startBlock: bigint,
      endBlock: bigint
  ): Promise<StakeChangedEvent[]> {
    const loggedEvents: GetLogsReturnType<AbiEvent, [AbiEvent], undefined, bigint | undefined, bigint | undefined> = await client.getLogs({
      address: stakingModuleAddress,
      event: stakeChangedEvent,
      args: args,
      fromBlock: startBlock,
      toBlock: endBlock,
    });

    return loggedEvents.map(event => {

      const {account, oldStake, newStake} = event.args as {
        account: Address,
        oldStake: bigint;
        newStake: bigint;
      };

      return {
        blockNumber: event.blockNumber,
        account: account,
        oldStake: oldStake,
        newStake: newStake,
      } as StakeChangedEvent;
    });
  }
  
  async fetchStake(
    client: PublicClient,
    userAddress: Address,
    endBlock: bigint,
    stakingModule: Address
  ): Promise<bigint> {
    try {
      const currentlyStaked = await client.readContract({
        address: stakingModule,
        abi: StakingModuleAbi,
        functionName: "stakedByAt",
        args: [userAddress, endBlock],
      });

      return currentlyStaked;
    } catch (err) {
      // log error to console but don't panic at this point
      console.error(`Error fetching stake for user ${userAddress}`, err);
      return 0n;
    }
  }

  async fetchCumulativeRewardsAtBlock(
    client: PublicClient,
    userAddress: Address,
    endBlock: bigint,
    tanIssuanceHistory: Address
  ): Promise<bigint> {
    try {
      const prevCumulativeRewards = await client.readContract({
        address: tanIssuanceHistory,
        abi: TanIssuanceHistoryAbi,
        functionName: "cumulativeRewardsAtBlock",
        args: [userAddress, endBlock],
      });

      return prevCumulativeRewards;
    } catch (err) {
      // log error to console but don't panic at this point
      console.error(
        `Error fetching cumulativeRewards for user ${userAddress} at block ${endBlock}`,
        err
      );
      return 0n;
    }
  }

  /**
   * @returns A map of developer addresses to the amount of incentives they should receive
   */
  async calculate(): Promise<Map<Address, UserRewardEntry>> {
    return await this.calculateRewardsPerStaker();
  }
}
