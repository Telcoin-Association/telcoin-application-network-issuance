import * as dotenv from "dotenv";
dotenv.config();

import {
  Address,
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  PublicClient,
} from "viem";
import { polygon } from "viem/chains";
import { ChainId, config } from "./config";
import { TanIssuanceHistoryAbi, ERC20Abi, StakingModuleAbi } from "./abi/abi";
import * as fs from "fs/promises";

/**
 * Resume Dry Run Script
 *
 * Queries the real deployed contracts on Polygon and performs comprehensive
 * preflight checks for resuming TANIP-1 staker incentives after the pause.
 *
 * Checks:
 *   1. lastSettlementBlock and how far behind it is
 *   2. Plugin deactivation status
 *   3. TAN Safe TEL balance
 *   4. TANIssuanceHistory TEL balance
 *   5. Contract ownership
 *   6. Cumulative rewards for known period-27 recipients
 *   7. Stake status for those users (did they unstake during pause?)
 *   8. Cap calculation simulation for those users
 *   9. Executor addresses still have recent activity
 *
 * Usage: yarn ts-node backend/resumeDryRun.ts
 */

const TAN_ISSUANCE_HISTORY: Address =
  "0xE533911F00f1C3B58BB8D821131C9B6E2452Fc27";
const TAN_SAFE: Address = "0x8Dcf8d134F22aC625A7aFb39514695801CD705b5";
const STAKING_MODULE: Address = "0x92e43Aec69207755CB1E6A8Dc589aAE630476330";
const TEL_TOKEN: Address = "0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32";
const TAN_ISSUANCE_PLUGIN: Address =
  "0xCAa823Fd48bec0134c8285Fd3C34F9D95CF3280f";

// Period 27 endBlock from rewards/staker_rewards_period_27.json
const PERIOD_27_END_BLOCK = 75_981_194n;
// TEL has 2 decimals
const TEL_DECIMALS = 2n;
// Weekly issuance amount (raw)
const WEEKLY_ISSUANCE = 320_512_820n;

async function main() {
  const client = createPublicClient({
    chain: polygon,
    transport: http(config.rpcUrls[ChainId.Polygon]),
  }) as PublicClient;

  const currentBlock = await client.getBlockNumber();
  console.log("=".repeat(70));
  console.log("  TANIP-1 RESUME DRY RUN - PREFLIGHT CHECKS");
  console.log("=".repeat(70));
  console.log(`\nCurrent Polygon block: ${currentBlock}`);
  console.log(
    `Reorg-safe block (current - 500): ${currentBlock - config.reorgSafeDepth[ChainId.Polygon]}`
  );

  // ================================================================
  //  1. LAST SETTLEMENT BLOCK
  // ================================================================
  console.log("\n--- 1. Last Settlement Block ---");
  const lastSettlementBlock = await client.readContract({
    address: TAN_ISSUANCE_HISTORY,
    abi: TanIssuanceHistoryAbi,
    functionName: "lastSettlementBlock",
  });
  console.log(`lastSettlementBlock: ${lastSettlementBlock}`);
  console.log(`Period 27 endBlock:  ${PERIOD_27_END_BLOCK}`);
  console.log(
    `Blocks since last settlement: ${currentBlock - lastSettlementBlock}`
  );

  if (lastSettlementBlock < PERIOD_27_END_BLOCK) {
    console.log(
      "WARNING: lastSettlementBlock is BEFORE period 27 endBlock. Check if period 27 was actually settled."
    );
  } else if (lastSettlementBlock === PERIOD_27_END_BLOCK) {
    console.log("PASS: lastSettlementBlock matches period 27 endBlock exactly.");
  } else {
    console.log(
      `NOTE: lastSettlementBlock is ${lastSettlementBlock - PERIOD_27_END_BLOCK} blocks AFTER period 27 endBlock. Additional settlements may have occurred.`
    );
  }

  // ================================================================
  //  2. PLUGIN DEACTIVATION STATUS
  // ================================================================
  console.log("\n--- 2. Plugin Deactivation Status ---");
  const isDeactivated = await client.readContract({
    address: TAN_ISSUANCE_HISTORY,
    abi: TanIssuanceHistoryAbi,
    functionName: "deactivated",
  });
  console.log(`Plugin deactivated: ${isDeactivated}`);
  if (isDeactivated) {
    console.log(
      "BLOCKER: Plugin is deactivated. Empty-batch jump will work, but real rewards will REVERT."
    );
    console.log(
      "         The SimplePlugin must be reactivated before distributing rewards."
    );
  } else {
    console.log("PASS: Plugin is active. Real rewards can be distributed.");
  }

  // ================================================================
  //  3. TEL BALANCES
  // ================================================================
  console.log("\n--- 3. TEL Balances ---");
  const safeTelBalance = await client.readContract({
    address: TEL_TOKEN,
    abi: ERC20Abi,
    functionName: "balanceOf",
    args: [TAN_SAFE],
  });
  const historyTelBalance = await client.readContract({
    address: TEL_TOKEN,
    abi: ERC20Abi,
    functionName: "balanceOf",
    args: [TAN_ISSUANCE_HISTORY],
  });
  console.log(
    `TAN Safe TEL balance:            ${safeTelBalance} (${formatUnits(safeTelBalance, Number(TEL_DECIMALS))} TEL)`
  );
  console.log(
    `TANIssuanceHistory TEL balance:  ${historyTelBalance} (${formatUnits(historyTelBalance, Number(TEL_DECIMALS))} TEL)`
  );
  console.log(
    `Weekly issuance amount:          ${WEEKLY_ISSUANCE} (${formatUnits(WEEKLY_ISSUANCE, Number(TEL_DECIMALS))} TEL)`
  );

  if (safeTelBalance < WEEKLY_ISSUANCE) {
    console.log(
      "BLOCKER: TAN Safe does not have enough TEL for even one period of issuance!"
    );
  } else {
    const weeksAvailable = safeTelBalance / WEEKLY_ISSUANCE;
    console.log(
      `PASS: Safe has enough TEL for ~${weeksAvailable} weeks of issuance.`
    );
  }

  // ================================================================
  //  4. CONTRACT OWNERSHIP
  // ================================================================
  console.log("\n--- 4. Contract Ownership ---");
  const owner = await client.readContract({
    address: TAN_ISSUANCE_HISTORY,
    abi: TanIssuanceHistoryAbi,
    functionName: "owner",
  });
  console.log(`TANIssuanceHistory owner: ${owner}`);
  console.log(`Expected TAN Safe:        ${TAN_SAFE}`);
  if (getAddress(owner as string) === getAddress(TAN_SAFE)) {
    console.log("PASS: Owner matches TAN Safe.");
  } else {
    console.log(
      "BLOCKER: Owner does NOT match TAN Safe! Cannot call increaseClaimableByBatch."
    );
  }

  // ================================================================
  //  5. CUMULATIVE REWARDS FOR KNOWN USERS
  // ================================================================
  console.log("\n--- 5. Cumulative Rewards for Known Period-27 Recipients ---");

  // Load period 27 reward file to get known recipients
  let period27Recipients: { address: Address; reward: string }[] = [];
  try {
    const rawData = await fs.readFile(
      "rewards/staker_rewards_period_27.json",
      "utf-8"
    );
    const jsonData = JSON.parse(rawData);
    period27Recipients = jsonData.stakerIncentives.slice(0, 10); // check first 10
  } catch (err) {
    console.log(
      "WARNING: Could not read rewards/staker_rewards_period_27.json"
    );
  }

  const capIssues: {
    address: Address;
    stake: bigint;
    cumulative: bigint;
    capStatus: string;
  }[] = [];

  for (const recipient of period27Recipients) {
    const addr = getAddress(recipient.address);

    const cumRewards = (await client.readContract({
      address: TAN_ISSUANCE_HISTORY,
      abi: TanIssuanceHistoryAbi,
      functionName: "cumulativeRewards",
      args: [addr],
    })) as bigint;

    // Also check their current stake
    let currentStake: bigint = 0n;
    try {
      currentStake = (await client.readContract({
        address: STAKING_MODULE,
        abi: StakingModuleAbi,
        functionName: "stakedByAt",
        args: [addr, currentBlock - 10n], // slight lookback for safety
      })) as bigint;
    } catch {
      // stakedByAt may not exist or may fail
      currentStake = 0n;
    }

    let capStatus: string;
    if (currentStake === 0n) {
      capStatus = "UNSTAKED (not eligible)";
    } else if (currentStake <= cumRewards) {
      capStatus = `CAP=0 (stake ${currentStake} <= cumulative ${cumRewards})`;
    } else {
      capStatus = `CAP=${currentStake - cumRewards}`;
    }

    capIssues.push({
      address: addr,
      stake: currentStake,
      cumulative: cumRewards,
      capStatus,
    });

    console.log(`  ${addr}:`);
    console.log(
      `    Period 27 reward: ${recipient.reward}, Cumulative: ${cumRewards}, Stake: ${currentStake}`
    );
    console.log(`    Cap status: ${capStatus}`);
  }

  // Summarize cap issues
  const zeroCapUsers = capIssues.filter(
    (u) => u.stake > 0n && u.stake <= u.cumulative
  );
  const unstakedUsers = capIssues.filter((u) => u.stake === 0n);
  console.log(
    `\n  Summary (of ${period27Recipients.length} sampled users):`
  );
  console.log(`    ${unstakedUsers.length} unstaked (not eligible)`);
  console.log(
    `    ${zeroCapUsers.length} staked but cap=0 (stake <= cumulative rewards)`
  );
  console.log(
    `    ${period27Recipients.length - unstakedUsers.length - zeroCapUsers.length} have positive cap`
  );

  // ================================================================
  //  6. PROPOSED RESUME PLAN
  // ================================================================
  console.log("\n--- 6. Proposed Resume Plan ---");
  const reorgSafeBlock =
    currentBlock - config.reorgSafeDepth[ChainId.Polygon];
  console.log(`\nStep 1: Call increaseClaimableByBatch([], ${reorgSafeBlock})`);
  console.log(`  - From TAN Safe: ${TAN_SAFE}`);
  console.log(`  - Target: ${TAN_ISSUANCE_HISTORY}`);
  console.log(`  - This advances lastSettlementBlock from ${lastSettlementBlock} to ${reorgSafeBlock}`);
  console.log(`  - No TEL transfer needed. Empty rewards array.`);
  console.log(
    `\nStep 2: Run calculator for first real period`
  );
  console.log(
    `  - yarn start polygon=${reorgSafeBlock + 1n}:<new_end_block>`
  );
  console.log(
    `  - new_end_block should be ~1 week of blocks after ${reorgSafeBlock + 1n}`
  );
  console.log(
    `\nStep 3: Build Safe transaction parameters`
  );
  console.log(
    `  - yarn ts-node backend/safeTxArrayBuilder.ts --period <N> --tan`
  );
  console.log(
    `\nStep 4: Execute via Safe UI`
  );
  console.log(`  - Transfer TEL from Safe to TANIssuanceHistory`);
  console.log(
    `  - Call increaseClaimableByBatch(rewards, endBlock) with the calculated data`
  );

  // ================================================================
  //  7. EXECUTOR CHECK
  // ================================================================
  console.log("\n--- 7. Executor Addresses ---");
  const executorAddresses = [
    "0x0082CaF47363bD42917947d81f4d4E0395257267",
    "0xA64B745351EC40bdb3147FF99db2ae21cf93E6E3",
  ];
  for (const exec of executorAddresses) {
    const txCount = await client.getTransactionCount({
      address: exec as Address,
    });
    console.log(`  ${exec}: nonce=${txCount}`);
  }
  console.log(
    "  Verify these executors are still active and correspond to current Telcoin developer EOAs."
  );

  // ================================================================
  //  FINAL SUMMARY
  // ================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  SUMMARY");
  console.log("=".repeat(70));

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (isDeactivated) blockers.push("Plugin is deactivated");
  if (getAddress(owner as string) !== getAddress(TAN_SAFE))
    blockers.push("Contract owner is not TAN Safe");
  if (safeTelBalance < WEEKLY_ISSUANCE)
    blockers.push("Insufficient TEL in Safe for one period");

  if (zeroCapUsers.length > 0)
    warnings.push(
      `${zeroCapUsers.length}/${period27Recipients.length} sampled users have cap=0 (stake <= cumulative)`
    );
  if (unstakedUsers.length > 0)
    warnings.push(
      `${unstakedUsers.length}/${period27Recipients.length} sampled users have unstaked`
    );

  if (blockers.length > 0) {
    console.log("\nBLOCKERS (must fix before resuming):");
    blockers.forEach((b) => console.log(`  - ${b}`));
  } else {
    console.log("\nNo blockers found. Resume is feasible.");
  }

  if (warnings.length > 0) {
    console.log("\nWARNINGS (review but not blocking):");
    warnings.forEach((w) => console.log(`  - ${w}`));
  }

  console.log("");
}

main().catch((err) => {
  console.error("Dry run failed:", err);
  process.exit(1);
});
