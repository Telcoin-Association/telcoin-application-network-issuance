// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.26;

import { Test, console2 } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SepoliaDeployments } from "../deployments/SepoliaDeployments.sol";
import { TANIssuanceHistory } from "../src/issuance/TANIssuanceHistory.sol";
import { ISimplePlugin } from "../src/interfaces/ISimplePlugin.sol";

/// @dev The parts of the live V3 `SimplePlugin` beyond what `TANIssuanceHistory` itself calls.
interface ISimplePluginAdmin {
    function setIncreaser(address newIncreaser) external;
    function increaser() external view returns (address);
    function owner() external view returns (address);
    function staking() external view returns (address);
    function claimable(address account, bytes calldata auxData) external view returns (uint256);
}

/// @dev The parts of the live V3 `StakingModule` this rehearsal exercises. The module is itself the
/// sTEL ERC20, so stake history is read from its `ERC20Votes` checkpoints.
interface IStakingModuleV3 {
    struct Checkpoint208 {
        uint48 _key;
        uint208 _value;
    }

    function stake(uint256 amount) external;
    function claimFromIndividualPlugin(address plugin, bytes calldata auxData) external returns (uint256);
    function isPlugin(address p) external view returns (bool);
    function pluginCount() external view returns (uint256);
    function tel() external view returns (address);
    function balanceOf(address account) external view returns (uint256);
    function numCheckpoints(address account) external view returns (uint32);
    function checkpoints(address account, uint32 pos) external view returns (Checkpoint208 memory);
    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256);
    function clock() external view returns (uint48);
}

/**
 * @notice Exercises `TANIssuanceHistory` against the live V3 staking stack on Ethereum Sepolia.
 *
 * @dev Sepolia carries a deployed V3 `StakingModule` and `SimplePlugin` with a history we own and can
 * settle freely, so it is where the V3 settlement path is driven end to end against real bytecode,
 * claims included. Every assertion here therefore covers something the unit tests structurally cannot: that the plugin's
 * real `rewardToken()` wiring satisfies the constructor, that the real batch entry point accepts what
 * we encode, that the real module pays the credit back out, and that the real vote checkpoints carry
 * the stake history the off-chain calculator reads.
 *
 * The settlement block domain is chain-local. `increaseClaimableByBatch` and
 * `backfillCumulativeRewards` both bound their block argument by `block.number`, so a history
 * deployed here can only ever be driven with Sepolia block numbers.
 *
 * Run with:
 *   FOUNDRY_PROFILE=cancun forge test --match-path test/TANIssuanceHistorySepoliaForkTest.t.sol -vv
 */
contract TANIssuanceHistorySepoliaForkTest is Test {
    string ETH_SEPOLIA_RPC_URL = vm.envOr("ETH_SEPOLIA_RPC_URL", string(""));

    SepoliaDeployments deployments;

    ISimplePlugin plugin;
    ISimplePluginAdmin pluginAdmin;
    IStakingModuleV3 stakingModule;
    IERC20 tel;
    address pluginOwner;

    TANIssuanceHistory history;
    address owner;

    address alice;
    address bob;
    address carol;

    /// @dev 18-decimal TEL, so rehearsal amounts are whole tokens scaled by 1e18.
    uint256 constant TEL = 1e18;

    function setUp() public {
        // the live V3 bytecode carries Cancun opcodes, which revert under the repo's default shanghai
        // target, so this suite only runs under the `cancun` profile and skips under any other
        vm.skip(!_isCancunProfile());

        vm.createSelectFork(ETH_SEPOLIA_RPC_URL);

        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/eth-sepolia.json"));
        deployments = abi.decode(vm.parseJson(json), (SepoliaDeployments));

        plugin = ISimplePlugin(deployments.SimplePlugin);
        pluginAdmin = ISimplePluginAdmin(deployments.SimplePlugin);
        stakingModule = IStakingModuleV3(deployments.StakingModule);
        tel = IERC20(deployments.TelV3);
        pluginOwner = deployments.pluginOwner;

        owner = makeAddr("tanSafe");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");

        history = new TANIssuanceHistory(plugin, owner);

        // settlement is increaser-gated on the plugin, so the rehearsal history has to take over that
        // slot from the plugin owner. On a live Sepolia deploy this is a manual owner transaction.
        vm.prank(pluginOwner);
        pluginAdmin.setIncreaser(address(history));
    }

    /**
     * Wiring
     */

    /// @dev The V3 plugin reports `rewardToken()` where V2 reported `tel()`. Constructing against the
    /// live plugin is the only proof that the retargeted interface matches deployed bytecode.
    function testForkConstructorBindsToLivePlugin() public view {
        assertEq(history.tel(), address(tel));
        assertFalse(history.telIsNative());
        assertEq(address(history.tanIssuancePlugin()), address(plugin));
        assertEq(history.owner(), owner);
        assertEq(history.lastSettlementBlock(), 0);
        assertFalse(history.backfillSealed());
        assertFalse(history.deactivated());

        assertEq(plugin.rewardToken(), address(tel));
        assertEq(pluginAdmin.staking(), address(stakingModule));
        assertEq(pluginAdmin.increaser(), address(history));
        assertTrue(stakingModule.isPlugin(address(plugin)));
    }

    /// @dev ABI stability is the headline constraint on this upgrade: the TAN Safe's existing
    /// settlement flow must keep encoding the same call.
    function testForkSettlementSelectorUnchanged() public pure {
        assertEq(TANIssuanceHistory.increaseClaimableByBatch.selector, bytes4(0x8bf2e6a1));
    }

    /// @dev A history deployed on Sepolia cannot be settled with Polygon block numbers, which is why
    /// the rehearsal reads and writes on one chain rather than splitting across two.
    function testForkRejectsBlockAboveChainHead() public {
        uint256 futureBlock = block.number + 1;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TANIssuanceHistory.InvalidBlock.selector, futureBlock));
        history.increaseClaimableByBatch(new TANIssuanceHistory.IssuanceReward[](0), futureBlock);
    }

    /**
     * Backfill
     */

    function testForkBackfillSeedsHistory() public {
        (address[] memory accounts, uint256[] memory amounts) = _threeAccounts(100 * TEL, 250 * TEL, 0);

        vm.prank(owner);
        history.backfillCumulativeRewards(accounts, amounts, block.number);

        assertEq(history.cumulativeRewards(alice), 100 * TEL);
        assertEq(history.cumulativeRewards(bob), 250 * TEL);
        // a zero row carries no history and is skipped rather than checkpointed at zero
        assertEq(history.cumulativeRewards(carol), 0);
        assertEq(history.lastSettlementBlock(), block.number);
        assertFalse(history.backfillSealed());
    }

    /// @dev Chunked backfills are retried in practice, so a repeat of an already-applied chunk must
    /// be inert rather than additive.
    function testForkBackfillRestatesSeedWhileUnsealed() public {
        (address[] memory accounts, uint256[] memory amounts) = _threeAccounts(100 * TEL, 250 * TEL, 0);

        vm.startPrank(owner);
        history.backfillCumulativeRewards(accounts, amounts, block.number);

        amounts[0] = 999 * TEL;
        history.backfillCumulativeRewards(accounts, amounts, block.number);
        vm.stopPrank();

        assertEq(history.cumulativeRewards(alice), 999 * TEL);
        assertEq(history.cumulativeRewards(bob), 250 * TEL);
    }

    function testForkSealedBackfillReverts() public {
        vm.startPrank(owner);
        history.sealBackfill();

        (address[] memory accounts, uint256[] memory amounts) = _threeAccounts(1 * TEL, 0, 0);
        vm.expectRevert(TANIssuanceHistory.BackfillIsSealed.selector);
        history.backfillCumulativeRewards(accounts, amounts, block.number);
        vm.stopPrank();
    }

    /**
     * Settlement against the live plugin
     */

    function testForkSettlementCreditsLivePlugin() public {
        uint256 aliceReward = 12 * TEL;
        uint256 bobReward = 8 * TEL;
        uint256 total = aliceReward + bobReward;

        _fundHistory(total);

        uint256 pluginBalBefore = tel.balanceOf(address(plugin));
        uint256 totalClaimableBefore = plugin.totalClaimable();
        uint256 aliceClaimableBefore = pluginAdmin.claimable(alice, "");
        uint256 bobClaimableBefore = pluginAdmin.claimable(bob, "");

        _settle(aliceReward, bobReward);

        // the plugin pulls exactly the declared total, so both sides move by the same amount
        assertEq(tel.balanceOf(address(plugin)) - pluginBalBefore, total);
        assertEq(plugin.totalClaimable() - totalClaimableBefore, total);
        assertEq(pluginAdmin.claimable(alice, "") - aliceClaimableBefore, aliceReward);
        assertEq(pluginAdmin.claimable(bob, "") - bobClaimableBefore, bobReward);

        assertEq(history.cumulativeRewards(alice), aliceReward);
        assertEq(history.cumulativeRewards(bob), bobReward);
        assertEq(history.lastSettlementBlock(), block.number);

        // settlement is funded exactly, so nothing is left behind on either rail
        assertEq(tel.balanceOf(address(history)), 0);
        assertEq(tel.allowance(address(history), address(plugin)), 0);
    }

    /// @dev Backfill skips accounts that already carry history, so a backfill landing after a
    /// settlement would silently drop everyone settled in between. Settlement closes that door.
    function testForkSettlementSealsBackfill() public {
        _fundHistory(20 * TEL);
        assertFalse(history.backfillSealed());

        _settle(12 * TEL, 8 * TEL);

        assertTrue(history.backfillSealed());

        (address[] memory accounts, uint256[] memory amounts) = _threeAccounts(1 * TEL, 0, 0);
        vm.prank(owner);
        vm.expectRevert(TANIssuanceHistory.BackfillIsSealed.selector);
        history.backfillCumulativeRewards(accounts, amounts, block.number);
    }

    /// @dev The live plugin reverts `EmptyBatch()`, so closing a settlement gap depends on the length
    /// guard skipping the plugin call entirely.
    function testForkEmptyBatchAdvancesWithoutTouchingPlugin() public {
        uint256 totalClaimableBefore = plugin.totalClaimable();
        uint256 targetBlock = block.number;

        vm.prank(owner);
        history.increaseClaimableByBatch(new TANIssuanceHistory.IssuanceReward[](0), targetBlock);

        assertEq(history.lastSettlementBlock(), targetBlock);
        assertEq(plugin.totalClaimable(), totalClaimableBefore);
        // no credit was created, so the backfill path stays open
        assertFalse(history.backfillSealed());
    }

    /// @dev Settling a period as several chunks that all carry the same `endBlock` is the shape the
    /// Safe flow uses, and each chunk must accumulate rather than replace.
    function testForkChunkedSettlementAccumulates() public {
        _fundHistory(20 * TEL);
        uint256 endBlock = block.number;

        TANIssuanceHistory.IssuanceReward[] memory chunk = new TANIssuanceHistory.IssuanceReward[](1);

        vm.startPrank(owner);
        chunk[0] = TANIssuanceHistory.IssuanceReward({ account: alice, amount: 12 * TEL });
        history.increaseClaimableByBatch(chunk, endBlock);

        chunk[0] = TANIssuanceHistory.IssuanceReward({ account: alice, amount: 8 * TEL });
        history.increaseClaimableByBatch(chunk, endBlock);
        vm.stopPrank();

        assertEq(history.cumulativeRewards(alice), 20 * TEL);
        assertEq(pluginAdmin.claimable(alice, ""), 20 * TEL);
        assertEq(history.lastSettlementBlock(), endBlock);
    }

    /**
     * End to end
     */

    /// @dev The full loop: seeded history, a settlement, and the staker collecting through the real
    /// module. Proves the credit we write is actually payable, not just recorded.
    function testForkBackfillThenSettleThenClaim() public {
        (address[] memory accounts, uint256[] memory amounts) = _threeAccounts(100 * TEL, 250 * TEL, 0);
        vm.prank(owner);
        history.backfillCumulativeRewards(accounts, amounts, block.number);
        // a crediting settlement has to end after the backfill block
        vm.roll(block.number + 1);

        uint256 aliceReward = 12 * TEL;
        _fundHistory(aliceReward + 8 * TEL);
        _settle(aliceReward, 8 * TEL);

        // carried-over history and the new settlement accumulate onto one checkpoint series
        assertEq(history.cumulativeRewards(alice), 100 * TEL + aliceReward);

        uint256 aliceTelBefore = tel.balanceOf(alice);

        vm.prank(alice);
        uint256 claimed = stakingModule.claimFromIndividualPlugin(address(plugin), "");

        assertEq(claimed, aliceReward);
        assertEq(tel.balanceOf(alice) - aliceTelBefore, aliceReward);
        assertEq(pluginAdmin.claimable(alice, ""), 0);
    }

    /**
     * Stake history the off-chain calculator reads
     */

    /// @dev The staker calculator derives each account's reward cap from the module's vote
    /// checkpoints rather than from events, because V3 removed `StakeChanged` and `stakedByAt`. This
    /// pins the shape and the block-number keying that reader depends on against real bytecode.
    function testForkVoteCheckpointsTrackStake() public {
        assertEq(stakingModule.clock(), uint48(block.number));
        assertEq(stakingModule.numCheckpoints(alice), 0);

        uint256 firstStake = 40 * TEL;
        uint256 secondStake = 60 * TEL;

        _stake(alice, firstStake);
        uint256 firstBlock = block.number;

        vm.roll(block.number + 100);

        _stake(alice, secondStake);
        uint256 secondBlock = block.number;

        assertEq(stakingModule.numCheckpoints(alice), 2);

        IStakingModuleV3.Checkpoint208 memory first = stakingModule.checkpoints(alice, 0);
        IStakingModuleV3.Checkpoint208 memory second = stakingModule.checkpoints(alice, 1);

        // keys are block numbers because the module leaves `clock()` at its default
        assertEq(first._key, uint48(firstBlock));
        assertEq(first._value, uint208(firstStake));
        assertEq(second._key, uint48(secondBlock));
        assertEq(second._value, uint208(firstStake + secondStake));

        // sTEL balance and votes agree because staking self-delegates on receipt
        assertEq(stakingModule.balanceOf(alice), firstStake + secondStake);

        vm.roll(block.number + 1);
        assertEq(stakingModule.getPastVotes(alice, firstBlock), firstStake);
        assertEq(stakingModule.getPastVotes(alice, secondBlock), firstStake + secondStake);
        assertEq(stakingModule.getPastVotes(alice, firstBlock - 1), 0);
    }

    /**
     * Helpers
     */

    function _threeAccounts(
        uint256 aliceAmount,
        uint256 bobAmount,
        uint256 carolAmount
    )
        internal
        view
        returns (address[] memory accounts, uint256[] memory amounts)
    {
        accounts = new address[](3);
        amounts = new uint256[](3);
        (accounts[0], accounts[1], accounts[2]) = (alice, bob, carol);
        (amounts[0], amounts[1], amounts[2]) = (aliceAmount, bobAmount, carolAmount);
    }

    /// @dev Settlement pulls the reward token from this contract, so the history has to be funded
    /// first. On Sepolia that is a plain TEL transfer from the TAN Safe.
    function _fundHistory(uint256 amount) internal {
        deal(address(tel), address(history), amount);
    }

    function _settle(uint256 aliceReward, uint256 bobReward) internal {
        TANIssuanceHistory.IssuanceReward[] memory rewards = new TANIssuanceHistory.IssuanceReward[](2);
        rewards[0] = TANIssuanceHistory.IssuanceReward({ account: alice, amount: aliceReward });
        rewards[1] = TANIssuanceHistory.IssuanceReward({ account: bob, amount: bobReward });

        vm.prank(owner);
        history.increaseClaimableByBatch(rewards, block.number);
    }

    function _stake(address account, uint256 amount) internal {
        deal(address(tel), account, amount);
        vm.startPrank(account);
        tel.approve(address(stakingModule), amount);
        stakingModule.stake(amount);
        vm.stopPrank();
    }

    function _isCancunProfile() internal view returns (bool) {
        return keccak256(bytes(vm.envOr("FOUNDRY_PROFILE", string("")))) == keccak256("cancun");
    }
}
