import { Address } from "viem";
import * as fs from "fs/promises";
import * as path from "path";
import { NetworkConfig } from "helpers";

// interface for the incentives output JSON file, eg `staker_incentives.json`
interface IncentivesJson {
  blockRanges: NetworkConfig[];
  stakerIncentives: StakerIncentive[];
}

// interface for the `address => incentive` map entries (`stakerIncentives`) within an output file
interface StakerIncentive {
  address: Address;
  incentive: Incentive;
}

// interface for the nested `incentive` value, keyed by address within `stakerIncentives` map
interface Incentive {
  reward: string;
  uncappedAmount?: string; // informational; not used in distribution
}

// usage example: `yarn ts-node backend/safeTxArrayBuilder.ts --period 0`
async function main() {
  try {
    const args = process.argv.slice(2);
    // `--period` must be specified and followed by number or else throw error
    const periodIndex = args.indexOf("--period");
    if (periodIndex === -1 || periodIndex + 1 >= args.length) {
      throw new Error(
        "Error: --period must be specified and followed by a number"
      );
    }

    const periodNumber = args[periodIndex + 1];
    const fileForPeriod = `rewards/staker_rewards_period_${periodNumber}.json`;
    const data = await fs.readFile(fileForPeriod, "utf-8");
    const jsonData: IncentivesJson = JSON.parse(data);

    // distribution must include a transfer of the total TEL rewards to increaser (TANIssuanceHistory)
    let totalAmount: number = 0;

    // build array of `TANIssuanceHistory::IssuanceReward` structs, to be JSON.stringified for Safe UI
    const issuanceRewards: Array<[string, number]> = [];
    for (const stakerIncentive of jsonData.stakerIncentives) {
      const rewardee = stakerIncentive.address;
      const reward = Number(stakerIncentive.incentive.reward);
      totalAmount += reward;

      issuanceRewards.push([rewardee, reward]);
    }

    console.log(
      `Total amount to transfer to increaser (TANIssuanceHistory):
      ${totalAmount / 100} TEL (decimals applied)
      ${totalAmount} (decimals not applied)`
    );

    // relevant endBlock must be used in settlement transaction on the settlement chain
    console.log(
      "Select the `endBlock` for the settlement chain and pass to TANIssuanceHistory::increaseClaimableByBatched()"
    );
    jsonData.blockRanges.map((config) => {
      console.log(`${config.network} endBlock: ${config.endBlock}`);
    });

    // write Safe TX info as chunks to gitignored `temp` directory, creating if it doesn't exist
    const chunkSize = 250;
    const chunks = chunkIssuanceRewardArray(issuanceRewards, chunkSize);
    for (let i = 0; i < chunks.length; i++) {
      const outputDir = path.join(__dirname, "temp");
      await fs.mkdir(outputDir, { recursive: true });
      const outputFilePath = path.join(
        outputDir,
        `safe_param_period_${periodNumber}_chunk_${i}.json`
      );
      await fs.writeFile(outputFilePath, JSON.stringify(chunks[i], null, 2));

      console.log(
        `Period ${periodNumber} IssuanceRewards chunk ${i} formatted for Safe UI transaction written to:
        ${outputFilePath}`
      );
    }
  } catch (err) {
    console.error("Error building arrays for Safe UI transactions", err);
  }
}

function chunkIssuanceRewardArray<T>(
  issuanceRewards: T[],
  chunkSize: number
): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < issuanceRewards.length; i += chunkSize) {
    chunks.push(issuanceRewards.slice(i, i + chunkSize));
  }
  return chunks;
}

main();
