import { Address } from "viem";
import * as fs from "fs/promises";
import { NetworkConfig } from "helpers";

// interface for the incentives JSON file, eg `staker_incentives.json`
interface IncentivesJson {
  blockRanges: NetworkConfig[];
  stakerIncentives: Reward[];
}

// interface for the `address => incentive` map entries within an incentives file
interface Reward {
  address: Address;
  incentive: string;
}

async function main() {
  try {
    // todo: generalize to accept CLI file name & document usage in README
    const data = await fs.readFile("staker_incentives.json", "utf-8");
    const jsonData: IncentivesJson = JSON.parse(data);

    // distribution must include a transfer of the total TEL rewards to increaser (TANIssuanceHistory)
    let totalAmount: number = 0;
    // build ordered arrays of all Reward.address and Reward.incentive, corresponding by array index
    const rewardees: Address[] = [];
    const incentives: number[] = [];

    for (const reward of jsonData.stakerIncentives) {
      const incentive = Number(reward.incentive);
      totalAmount += incentive;
      rewardees.push(reward.address);
      incentives.push(incentive);
    }

    console.log(
      "Total Amount to transfer to increaser (TANIssuanceHistory)",
      totalAmount
    );

    // relevant endBlock must be used in settlement transaction on the settlement chain
    console.log(
      "Select the `endBlock` for the settlement chain and pass to TANIssuanceHistory::increaseClaimableByBatched()"
    );
    jsonData.blockRanges.map((config) => {
      console.log(`endBlock for ${config.network}: ${config.endBlock}`);
    });
    console.log("Rewardees:", rewardees);
    console.log("Incentives:", incentives);
  } catch (err) {
    console.error("Error building arrays", err);
  }
}

main();
