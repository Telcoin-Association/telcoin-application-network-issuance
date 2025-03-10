import { Address } from "viem";
import * as fs from "fs/promises";
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

async function main() {
  try {
    // todo: generalize to accept CLI file name & document usage in README
    const data = await fs.readFile("staker_incentives.json", "utf-8");
    const jsonData: IncentivesJson = JSON.parse(data);

    // distribution must include a transfer of the total TEL rewards to increaser (TANIssuanceHistory)
    let totalAmount: number = 0;

    // build array of `TANIssuanceHistory::IssuanceReward` structs, to be JSON.stringified for Safe UI
    const formattedForSafeUI: Array<[string, number]> = [];
    for (const stakerIncentive of jsonData.stakerIncentives) {
      const rewardee = stakerIncentive.address;
      const reward = Number(stakerIncentive.incentive.reward);
      totalAmount += reward;

      formattedForSafeUI.push([rewardee, reward]);
    }

    console.log(
      "Total amount to transfer to increaser (TANIssuanceHistory):",
      totalAmount
    );

    // relevant endBlock must be used in settlement transaction on the settlement chain
    console.log(
      "Select the `endBlock` for the settlement chain and pass to TANIssuanceHistory::increaseClaimableByBatched()"
    );
    jsonData.blockRanges.map((config) => {
      console.log(`${config.network} endBlock: ${config.endBlock}`);
    });
    console.log(
      "IssuanceRewards formatted for Safe UI:\n",
      JSON.stringify(formattedForSafeUI, null, 2)
    );
  } catch (err) {
    console.error("Error building array for Safe UI", err);
  }
}

main();
