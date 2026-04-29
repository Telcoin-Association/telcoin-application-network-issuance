import * as XLSX from "xlsx";
import { promises as fs } from "fs";
import { formatUnits } from "viem";

/// Usage: `yarn ts-node backend/merkl/merklCampaignReport.ts <campaignId> [--distributionChainId <id>]`
/// eg: `yarn ts-node backend/merkl/merklCampaignReport.ts 0x3d1d0e523fcededa84488c9ffe367d44f2a9f0bb00c23cad0fe7fc24b31e620b`
///
/// Fetches a Merkl campaign's metadata and per-recipient reward breakdown via
/// the public Merkl API (https://api.merkl.xyz) and writes a 2-sheet xlsx:
///   - "Campaign Info": campaign metadata
///   - "LP Rewards":    recipient address + amount + claimed/unclaimed/reason
/// Output: backend/checkpoints/merkl/<campaignId>.xlsx

const MERKL_API = "https://api.merkl.xyz";
const OUTPUT_DIR = "backend/checkpoints/merkl";
const DEFAULT_CAMPAIGN_ID =
  "0x3d1d0e523fcededa84488c9ffe367d44f2a9f0bb00c23cad0fe7fc24b31e620b";
const CANDIDATE_DISTRIBUTION_CHAINS = [137, 8453, 1, 42161, 10, 56, 100];

interface MerklCampaign {
  id: string;
  computeChainId: number;
  distributionChainId: number;
  campaignId: string;
  type: string;
  subType: number;
  rewardTokenId: string;
  amount: string;
  opportunityId: string;
  startTimestamp: number;
  endTimestamp: number;
  creatorAddress: string;
  params: Record<string, unknown>;
  chain: { id: number; name: string };
  distributionChain: { id: number; name: string };
  rewardToken: {
    id: string;
    name: string;
    chainId: number;
    address: string;
    decimals: number;
    symbol: string;
  };
  campaignStatus?: {
    status: string;
    preComputeStatus: string;
    error?: string;
    computedUntil?: number;
  };
  createdAt: string;
  campaignEncodingHash?: string;
}

interface DiffBreakdown {
  recipient: string;
  amount: string;
  claimed?: string;
  unclaimed?: string;
  merged?: string;
  mergedAt?: number | string;
  reason?: string;
  tokenAddress?: string;
  campaignId?: string;
  protocolId?: string | null;
}

interface BreakdownsResponse {
  count?: number;
  rows?: DiffBreakdown[];
  data?: DiffBreakdown[];
  summary?: Record<string, unknown>;
}

interface RootsLiveResponse {
  [chainId: string]: {
    endOfDisputePeriod: number;
    lastTree: string;
    live: string;
    tree: string;
  };
}

async function main() {
  const { campaignHash, distributionChainId: cliChainId } = parseCLIArgs(
    process.argv.slice(2),
  );
  const apiKey = process.env.MERKL_API_KEY;

  // 1. Resolve the composite campaign id by trying candidate distribution chains
  //    if the caller didn't pin one.
  console.log(`Resolving campaign ${campaignHash}...`);
  const campaign = await resolveCampaign(campaignHash, cliChainId, apiKey);
  console.log(
    `  → ${campaign.distributionChain.name} (distribution chain ${campaign.distributionChainId}), compute on ${campaign.chain.name} (${campaign.computeChainId})`,
  );
  console.log(
    `  → reward token: ${campaign.rewardToken.symbol} (${campaign.rewardToken.address}, decimals ${campaign.rewardToken.decimals})`,
  );

  // 2. Pick the live merkle root on the distribution chain — the breakdowns
  //    endpoint requires a (chainId, root) pair.
  const root = await getLiveRoot(campaign.distributionChainId, apiKey);
  console.log(`  → live root on chain ${campaign.distributionChainId}: ${root}`);

  // 3. Page through reward breakdowns filtered by this campaign.
  //    `/v4/diffs/breakdowns` requires an API key; if missing or rejected we
  //    still emit the Campaign Info sheet so the comparison artefact exists.
  let breakdowns: DiffBreakdown[] = [];
  let breakdownNote: string;
  if (!apiKey) {
    breakdownNote =
      "skipped: MERKL_API_KEY env var not set — /v4/diffs/breakdowns requires authentication";
    console.warn(`⚠️  ${breakdownNote}`);
  } else {
    console.log(`Fetching reward breakdowns...`);
    try {
      breakdowns = await fetchAllBreakdowns(
        campaign.distributionChainId,
        root,
        campaign.campaignId,
        apiKey,
      );
      breakdownNote = `${breakdowns.length} row(s)`;
      console.log(`  → ${breakdownNote}`);
    } catch (err) {
      breakdownNote = `failed: ${(err as Error).message}`;
      console.warn(`⚠️  Breakdown fetch ${breakdownNote}`);
    }
  }

  // 4. Write xlsx.
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputFile = `${OUTPUT_DIR}/${campaign.campaignId}.xlsx`;
  writeXlsx(outputFile, campaign, root, breakdowns, breakdownNote);
  console.log(`Report saved to ${outputFile}`);
}

async function resolveCampaign(
  campaignHash: string,
  pinnedDistributionChainId: number | undefined,
  apiKey: string | undefined,
): Promise<MerklCampaign> {
  const candidates = pinnedDistributionChainId
    ? [pinnedDistributionChainId]
    : CANDIDATE_DISTRIBUTION_CHAINS;

  for (const chainId of candidates) {
    const id = `${chainId}-${campaignHash}`;
    const res = await merklFetch(`/v4/campaigns/${id}`, undefined, apiKey);
    if (res.status === 404) continue;
    if (!res.ok) {
      throw new Error(
        `GET /v4/campaigns/${id} failed: ${res.status} ${res.statusText} ${await res.text()}`,
      );
    }
    return (await res.json()) as unknown as MerklCampaign;
  }
  throw new Error(
    `Campaign ${campaignHash} not found on any candidate chain (${candidates.join(", ")}). ` +
      `Pass --distributionChainId <id> to override.`,
  );
}

async function getLiveRoot(
  distributionChainId: number,
  apiKey: string | undefined,
): Promise<string> {
  const res = await merklFetch(
    `/v4/roots/live?chainId=${distributionChainId}`,
    undefined,
    apiKey,
  );
  if (!res.ok) {
    throw new Error(
      `GET /v4/roots/live?chainId=${distributionChainId} failed: ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as unknown as RootsLiveResponse;
  const entry = body[String(distributionChainId)];
  if (!entry) {
    throw new Error(
      `No live root returned for chainId ${distributionChainId} (response keys: ${Object.keys(body).join(",")})`,
    );
  }
  // Prefer `live` (current claimable root); fall back to `tree`.
  return entry.live ?? entry.tree;
}

async function fetchAllBreakdowns(
  distributionChainId: number,
  root: string,
  campaignId: string,
  apiKey: string | undefined,
): Promise<DiffBreakdown[]> {
  const pageSize = 500;
  const all: DiffBreakdown[] = [];
  let page = 0;

  while (true) {
    const qs = new URLSearchParams({
      chainId: String(distributionChainId),
      root,
      campaignId,
      page: String(page),
      items: String(pageSize),
    });
    // The OpenAPI spec lists chainId and root as both query params *and*
    // required headers. Send both to satisfy validation either way.
    const headers: Record<string, string> = {
      chainId: String(distributionChainId),
      root,
    };
    const res = await merklFetch(
      `/v4/diffs/breakdowns?${qs.toString()}`,
      headers,
      apiKey,
    );
    if (!res.ok) {
      throw new Error(
        `GET /v4/diffs/breakdowns failed: ${res.status} ${res.statusText} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as unknown as
      | BreakdownsResponse
      | DiffBreakdown[];
    const rows = extractBreakdownRows(body);
    all.push(...rows);
    if (rows.length < pageSize) break;
    page += 1;
  }

  return all;
}

function extractBreakdownRows(
  body: BreakdownsResponse | DiffBreakdown[],
): DiffBreakdown[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.rows)) return body.rows;
  if (Array.isArray(body.data)) return body.data;
  throw new Error(
    `Unexpected /v4/diffs/breakdowns response shape: ${JSON.stringify(body).slice(0, 200)}`,
  );
}

function writeXlsx(
  outputFile: string,
  campaign: MerklCampaign,
  root: string,
  breakdowns: DiffBreakdown[],
  breakdownNote: string,
) {
  const decimals = campaign.rewardToken.decimals;
  const symbol = campaign.rewardToken.symbol;

  const campaignInfo = [
    { Parameter: "Campaign Hash", Value: campaign.campaignId },
    { Parameter: "Composite ID", Value: campaign.id },
    { Parameter: "Type", Value: campaign.type },
    {
      Parameter: "Compute Chain",
      Value: `${campaign.chain.name} (${campaign.computeChainId})`,
    },
    {
      Parameter: "Distribution Chain",
      Value: `${campaign.distributionChain.name} (${campaign.distributionChainId})`,
    },
    {
      Parameter: "Pool ID",
      Value: String(
        (campaign.params as { poolId?: string }).poolId ?? "",
      ),
    },
    {
      Parameter: "Currency 0",
      Value: String(
        (campaign.params as { currency0?: string }).currency0 ?? "",
      ),
    },
    {
      Parameter: "Currency 1",
      Value: String(
        (campaign.params as { currency1?: string }).currency1 ?? "",
      ),
    },
    { Parameter: "Reward Token Symbol", Value: symbol },
    { Parameter: "Reward Token Address", Value: campaign.rewardToken.address },
    { Parameter: "Reward Token Decimals", Value: decimals },
    {
      Parameter: `Total Reward Amount (${symbol})`,
      Value: formatUnits(BigInt(campaign.amount), decimals),
    },
    { Parameter: "Total Reward Amount (raw)", Value: campaign.amount },
    {
      Parameter: "Start Timestamp (UTC)",
      Value: new Date(campaign.startTimestamp * 1000).toISOString(),
    },
    {
      Parameter: "End Timestamp (UTC)",
      Value: new Date(campaign.endTimestamp * 1000).toISOString(),
    },
    { Parameter: "Start Timestamp (unix)", Value: campaign.startTimestamp },
    { Parameter: "End Timestamp (unix)", Value: campaign.endTimestamp },
    { Parameter: "Creator Address", Value: campaign.creatorAddress },
    {
      Parameter: "Status",
      Value: campaign.campaignStatus?.status ?? "unknown",
    },
    {
      Parameter: "Pre-Compute Status",
      Value: campaign.campaignStatus?.preComputeStatus ?? "unknown",
    },
    {
      Parameter: "Status Error",
      Value: campaign.campaignStatus?.error ?? "",
    },
    { Parameter: "Live Merkle Root (used for breakdown)", Value: root },
    { Parameter: "Created At", Value: campaign.createdAt },
    { Parameter: "Breakdown Fetch", Value: breakdownNote },
  ];

  const lpRewards = breakdowns.map((row) => {
    const amount = safeBig(row.amount);
    const claimed = safeBig(row.claimed);
    const unclaimed = safeBig(row.unclaimed);
    return {
      lpAddress: row.recipient,
      reward_formatted:
        amount === undefined ? "" : formatUnits(amount, decimals),
      claimed_formatted:
        claimed === undefined ? "" : formatUnits(claimed, decimals),
      unclaimed_formatted:
        unclaimed === undefined ? "" : formatUnits(unclaimed, decimals),
      reward_raw: row.amount ?? "",
      claimed_raw: row.claimed ?? "",
      unclaimed_raw: row.unclaimed ?? "",
      reason: row.reason ?? "",
    };
  });

  // Sort descending by reward so the top earners are at the top.
  lpRewards.sort((a, b) => {
    const ra = safeBig(a.reward_raw) ?? 0n;
    const rb = safeBig(b.reward_raw) ?? 0n;
    if (rb > ra) return 1;
    if (rb < ra) return -1;
    return 0;
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(campaignInfo),
    "Campaign Info",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(lpRewards),
    "LP Rewards",
  );
  XLSX.writeFile(wb, outputFile);
}

function safeBig(value: string | undefined): bigint | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

// Minimal types for the global `fetch` (available since Node 18) — the project's
// @types/node version predates the typings, so we declare what we use locally.
interface MerklResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}
declare const fetch: (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<MerklResponse>;

async function merklFetch(
  pathAndQuery: string,
  extraHeaders: Record<string, string> | undefined,
  apiKey: string | undefined,
): Promise<MerklResponse> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(extraHeaders ?? {}),
  };
  if (apiKey) {
    // Merkl's OpenAPI spec only declares the security scheme name (`apiKey`)
    // without a header convention. Default to a plain `apiKey` header — the
    // Merkl Developer Keys flow in the docs uses this name. Users can override
    // via MERKL_API_KEY_HEADER (e.g. "Authorization: Bearer").
    const overrideHeader = process.env.MERKL_API_KEY_HEADER;
    if (overrideHeader && overrideHeader.toLowerCase().startsWith("authorization")) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (overrideHeader) {
      headers[overrideHeader] = apiKey;
    } else {
      headers["apiKey"] = apiKey;
    }
  }
  return fetch(`${MERKL_API}${pathAndQuery}`, { headers });
}

function parseCLIArgs(args: string[]): {
  campaignHash: string;
  distributionChainId?: number;
} {
  let campaignHash = DEFAULT_CAMPAIGN_ID;
  let distributionChainId: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--distributionChainId") {
      const next = args[++i];
      if (!next) throw new Error("--distributionChainId requires a value");
      distributionChainId = Number(next);
      if (!Number.isInteger(distributionChainId)) {
        throw new Error(`Invalid --distributionChainId: ${next}`);
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (!arg.startsWith("-")) {
      campaignHash = arg;
    }
  }
  if (!campaignHash.startsWith("0x")) {
    throw new Error(`Invalid campaignId, expected 0x-prefixed hash: ${campaignHash}`);
  }
  return { campaignHash, distributionChainId };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
