import {
  AbiEvent,
  Address,
  createPublicClient,
  decodeFunctionData,
  getAbiItem,
  PublicClient,
  zeroAddress,
} from "viem";
import { ICalculator } from "./ICalculator";
import { BaseBlocksDatabase } from "../datasources/persistent/BlocksDatabase";
import { BaseExecutorRegistry } from "../datasources/ExecutorRegistry";
import { ChainId, config, Token } from "../config";
import {
  TokenTransfer,
  TokenTransferWithCalldata,
  TokenTransferHistory,
} from "../datasources/TokenTransferHistory";
import { Aggregator } from "../data/aggregators";
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
};

type OnchainRewardData = {
  chain: ChainId;
  userStake: bigint;
  prevCumulativeRewards: bigint;
};

export class StakerIncentivesCalculator implements ICalculator {
  constructor(
    private readonly _blocksDbs: BaseBlocksDatabase[],
    private readonly _tokenTransferHistories: TokenTransferHistory[],
    private readonly _aggregators: Aggregator[],
    private readonly _stakingModules: StakingModule[],
    private readonly _tanIssuanceHistories: TanIssuanceHistory[],
    private readonly _amirXs: AmirX[],
    private readonly _executorRegistry: BaseExecutorRegistry,
    private readonly _totalIncentiveAmount: bigint,
    private readonly _startBlocks: Partial<{ [chain in ChainId]: bigint }>,
    private readonly _endBlocks: Partial<{ [chain in ChainId]: bigint }>
  ) {
    // arity checks for initialization in multichain context
    const blocksChains = _blocksDbs.map((db) => db.chain);
    const transfersChains = _tokenTransferHistories.map((db) => db.token.chain);
    // token transfer history and blocks dbs must match
    if (!transfersChains.every((chain) => blocksChains.includes(chain)))
      throw new Error(
        "Blocks databases and token transfer histories must be for the same chains"
      );

    const aggregatorsChains = _aggregators.map(
      (aggregator) => aggregator.chain
    );
    const stakingModulesChains = _stakingModules.map(
      (stakingModule) => stakingModule.chain
    );
    const amirXsChains = _amirXs.map((amirX) => amirX.chain);
    const arrays = [
      blocksChains,
      transfersChains,
      aggregatorsChains,
      stakingModulesChains,
      amirXsChains,
    ];
    if (
      !arrays.every((chains) =>
        chains.every((chain) => blocksChains.includes(chain))
      )
    ) {
      throw new Error("All input arrays must have the same chains.");
    }

    // Ensure start and end blocks are specified for each chain
    if (
      ![...blocksChains].every((chain) => {
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
   * @dev First identifies multichain user fees over the period, ie transfer events from agg to AmirX
   * @dev Then ensures all txs were initiated by executors so nobody can falsify user fees
   * @returns An array of user fee payments, represented as `TokenTransfer`s
   */
  async fetchUserFeeTransfers(): Promise<TokenTransferWithCalldata[]> {
    // search all transfers in TokenTransferHistorys for transfers from aggregators to AmirX
    const filteredTransfers = this._tokenTransferHistories
      .map((history) => {
        return history.transfers.filter((transfer) => {
          // explicitly return result of boolean eval for `to === amirX && from === aggregator`
          return (
            this._amirXs.map((amirX) => amirX.address).includes(transfer.to) &&
            this._aggregators
              .map((aggregator) => aggregator.address)
              .includes(transfer.from)
          );
        });
      })
      .flat();

    // fetch executor addresses as Set
    const executorSet = new Set<Address>(
      this._executorRegistry.executors.map((executor) => executor.address)
    );

    // get all tx hashes and input calldatas of all executor EOAs
    let executorTxHashToCalldata = new Map<`0x${string}`, `0x${string}`>();
    for (const db of this._blocksDbs) {
      // fetch all executors' transactions within `[startBlock:endBlock]` range
      const txMap = await db.getTransactionsOfEOASet(
        executorSet,
        this._startBlocks[db.chain]!,
        this._endBlocks[db.chain]!
      );

      // extract executor tx hashes and input calldata from executor txs into map
      for (const transactions of txMap.values()) {
        transactions.forEach((tx) => {
          executorTxHashToCalldata.set(tx.hash, tx.input);
        });
      }
    }

    // select for `TokenTransfer`s resulting from executor txs only
    const verifiedFeeTransfers = filteredTransfers.filter((transfer) => {
      return executorTxHashToCalldata.has(transfer.txHash);
    });

    // append calldata to `TokenTransfer`s to construct `TokenTransferWithCalldata`s
    const userFeeTransfers: TokenTransferWithCalldata[] =
      verifiedFeeTransfers.map((transfer) => {
        return {
          ...transfer,
          calldata: executorTxHashToCalldata.get(transfer.txHash)!,
        };
      });

    return userFeeTransfers;
  }

  /**
   * @notice A user who is staked is eligible for rewards equal to their pro-rata share of total eligible user fee volume
   * A user who is staked is *ALSO* eligible for rewards equal to the total sum of their referred users' fees (in addition to their own)
   * @returns A map of staker addresses eligible for issuance rewards to their issuance reward amount for the [startBlock:endBlock] period
   */
  async calculateRewardsPerStaker(): Promise<Map<Address, bigint>> {
    console.log("Fetching UserFeeTransfers...");
    const userFeeTransfers = await this.fetchUserFeeTransfers();

    console.log("Fetching onchain data for eligible (staked) users");
    // note `eligibleStakerSwaps` includes swaps for unstaked users who are referees since we need their fees
    // but `addressToRewardDatas` will only include staked users
    const [eligibleStakerSwaps, addressToRewardDatas] =
      await this.fetchOnchainData(userFeeTransfers);

    // calculate volume of total fee eligibility per user by summing user fees along protocol rules
    const stakerToStakerFeeTotal = new Map<Address, bigint>();
    console.log("Calculating volume of total fee eligibility per user...");
    for (const eligibleSwap of eligibleStakerSwaps) {
      // user collisions are expected and summed agnostically provided they are staked
      // because userFees for staked Referees are double counted: once for themselves and again for their referrer (if staked)
      this.updateStakerFeeTotal(
        stakerToStakerFeeTotal,
        addressToRewardDatas,
        eligibleSwap.userAddress,
        eligibleSwap.userFee
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

      // set map of address to its reward cap; `updateStakerFeeTotal` not used for efficiency
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
    const stakerToReward = new Map<Address, bigint>();
    const decimalScale = 1_000_000_000_000_000n;
    console.log("Calculating rewards and applying caps if appropriate...");
    for (const [staker, stakerFeeTotal] of stakerToStakerFeeTotal) {
      // address rounding and precision loss for cases where vars are unbalanced
      const scaledIncentive =
        (stakerFeeTotal * this._totalIncentiveAmount * decimalScale) /
        totalFees;
      let stakerIncentive = scaledIncentive / decimalScale;

      // determine if reward cap is applicable; if so it results in a remainder for the period's issuance
      if (addressToRewardCap.has(staker)) {
        const stakerRewardCap = addressToRewardCap.get(staker);

        // update reward cap if it is less than their derived pro-rata share of issuance
        if (stakerRewardCap! < stakerIncentive) {
          stakerIncentive = stakerRewardCap!;
        }
      }

      stakerToReward.set(staker, stakerIncentive);
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
        const stakeChangedEvents = await client.getLogs({
          address: currentChainStakingModule.address,
          event: stakeChangedAbiItem as AbiEvent,
          args: { account: Array.from(accountsOfInterest) },
          fromBlock: this._startBlocks[currentChain],
          toBlock: this._endBlocks[currentChain],
        });

        // populate a map of Address => newStakeAmount which will be used to skip RPC calls to `StakingModule::stakedByAt()`
        const accountToLowestStake = new Map<Address, bigint>();
        stakeChangedEvents.forEach((stakeChange) => {
          const { account, oldStake, newStake } = stakeChange.args as {
            account: Address;
            oldStake: bigint;
            newStake: bigint;
          };
          const currentLowerStake = oldStake < newStake ? oldStake : newStake;

          const existingLowestStake = accountToLowestStake.get(account);
          if (
            existingLowestStake == undefined ||
            currentLowerStake < existingLowestStake
          ) {
            console.log(
              `StakeChanged event found for ${account} for stake amount ${oldStake} to ${newStake}`
            );
            accountToLowestStake.set(account, currentLowerStake);
          }
        });

        return await this.processUserFeeSwaps(
          userFeeSwaps,
          client,
          currentChainStakingModule.address,
          currentChainTanIssuanceHistory!.address,
          addressToOnchainRewardDatas,
          accountToLowestStake
        );
      })
    );

    return [eligibleUserFeeSwaps.flat(), addressToOnchainRewardDatas];
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
    accountToLowestStake: Map<Address, bigint>
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
          accountToLowestStake
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
    accountToLowestStake: Map<Address, bigint>
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

    const currentChainEndBlock = this._endBlocks[chainId];
    const existingLowestStake = accountToLowestStake.get(address);
    // check whether the account's lowest stake for the period was detected from `StakeChanged` events
    if (existingLowestStake) {
      // if a `StakeChanged` event was emitted and `newStake` was not 0, only fetch cumulative rewards
      const prevCumulativeRewards = await this.fetchCumulativeRewardsAtBlock(
        client,
        address,
        currentChainEndBlock!,
        tanIssuanceHistory
      );
      addressToOnchainRewardDatas.set(address, [
        {
          chain: chainId,
          userStake: existingLowestStake!,
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
        currentChainEndBlock!,
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
          currentChainEndBlock!,
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
   * If not, cross reference `address` against known stake changes previously detected from `StakeChanged` events
   * If a change in stake for `address` was emitted, stake is known so only fetch cumulative rewards and return true
   * If no stake change was emitted, fetch the stake. If 0, return false. If > 0, fetch cumulative rewards and return true
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
          },
          {
            txHash: transfer.txHash,
            userAddress: defiSwap.referrer,
            userFee: transfer.amount,
          },
        ];
      })
      .flat();
  }

  private updateStakerFeeTotal(
    stakerFeeTotalMap: Map<Address, bigint>,
    stakerMap: Map<Address, OnchainRewardData[]>,
    address: Address,
    amount: bigint
  ) {
    // skip zero address and nonstakers
    if (address === zeroAddress || !stakerMap.has(address)) return;

    if (stakerFeeTotalMap.has(address)) {
      const existingAmount = stakerFeeTotalMap.get(address)!;
      stakerFeeTotalMap.set(address, existingAmount + amount);
    } else {
      stakerFeeTotalMap.set(address, amount);
    }
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
  async calculate(): Promise<Map<Address, bigint>> {
    return await this.calculateRewardsPerStaker();
  }
}
