import { createPublicClient, http, getAddress } from "viem";
import { polygon } from "viem/chains";

const client = createPublicClient({
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL),
});

const tanHistory = getAddress("0xE533911F00f1C3B58BB8D821131C9B6E2452Fc27");
const abi = [
  { type: "function", name: "lastSettlementBlock", inputs: [], outputs: [{ type: "uint256" }] },
];

const lastSettlement = await client.readContract({
  address: tanHistory,
  abi,
  functionName: "lastSettlementBlock",
});

console.log("lastSettlementBlock:", lastSettlement.toString());
process.exit(0);
