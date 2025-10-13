#!/usr/bin/env node
const { createPublicClient, http, getAddress } = require("viem");
const { polygon } = require("viem/chains");

if (!process.env.POLYGON_RPC_URL) {
  console.error("POLYGON_RPC_URL is not set.");
  process.exit(1);
}

const client = createPublicClient({
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL),
});

const historyAddress = getAddress("0xE533911F00f1C3B58BB8D821131C9B6E2452Fc27");
const abi = [
  {
    type: "function",
    name: "lastSettlementBlock",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
];

async function main() {
  try {
    const last = await client.readContract({
      address: historyAddress,
      abi,
      functionName: "lastSettlementBlock",
    });
    console.log("lastSettlementBlock:", last.toString());
  } catch (err) {
    console.error("Failed to fetch lastSettlementBlock:", err);
    process.exit(1);
  }
}

main();
