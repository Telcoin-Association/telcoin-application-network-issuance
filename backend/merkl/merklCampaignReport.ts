import * as XLSX from "xlsx";
import { promises as fs } from "fs";
import { formatUnits } from "viem";

/// Usage: `yarn ts-node backend/merkl/merklCampaignReport.ts <campaignId> [--distributionChainId <id>] [--hide]`
/// eg: `yarn ts-node backend/merkl/merklCampaignReport.ts 0x3d1d0e523fcededa84488c9ffe367d44f2a9f0bb00c23cad0fe7fc24b31e620b`
///
/// Fetches a Merkl campaign's metadata and per-recipient reward list via the
/// public Merkl API (https://api.merkl.xyz) and writes a 2-sheet xlsx:
///   - "Campaign Info": campaign metadata
///   - "LP Rewards":    recipient address + amount + claimed/unclaimed/reason
///
/// Notes:
///   - Uses `/v4/rewards/`, not `/v4/diffs/breakdowns`, so no MERKL_API_KEY is required.
///   - Merkl's `pending` field is exported as the existing `unclaimed_*` columns
///     to preserve compatibility with the previous spreadsheet shape.
///
/// Output: backend/checkpoints/merkl/<campaignId>.xlsx

const MERKL_API = "https://api.merkl.xyz";
const OUTPUT_DIR = "backend/checkpoints/merkl";
const DEFAULT_CAMPAIGN_ID =
  "0x3d1d0e523fcededa84488c9ffe367d44f2a9f0bb00c23cad0fe7fc24b31e620b";

const CANDIDATE_DISTRIBUTION_CHAINS = [137, 8453, 1, 42161, 10, 56, 100];
const REWARDS_PAGE_SIZE = 1000;

interface MerklCampaign {
  id: string;
  computeChainId: number;
  distributionChainId: number;
  campaignId: string;
  type: string;
  subType: number | null;
  rewardTokenId: string;
  amount: string;
  opportunityId?: string;
  startTimestamp: number | string;
  endTimestamp: number | string;
  creatorAddress: string;
  params: Record<string, unknown>;
  chain: { id: number; name: string };
  distributionChain: { id: number; name: string };
  rewardToken: {
    id: string;
    name: string | null;
    chainId: number;
    address: string;
    decimals: number;
    symbol: string;
  };
  campaignStatus?: {
    status?: string;
    preComputeStatus?: string;
    error?: string;
    computedUntil?: number | string;
  };
  createdAt: string;
  campaignEncodingHash?: string;
}

interface Reward {
  recipient: string;
  amount: string;
  claimed?: string;
  pending?: string;
  reason?: string;
  rewardTokenAddress?: string;
}

interface CLIArgs {
  campaignHash: string;
  distributionChainId?: number;
  hide: boolean;
}

async function main() {
  const {
    campaignHash,
    distributionChainId: cliChainId,
    hide,
  } = parseCLIArgs(process.argv.slice(2));

  console.log(`Resolving campaign ${campaignHash}...`);
  const campaign = await resolveCampaign(campaignHash, cliChainId);

  console.log(
    `  → ${campaign.distributionChain.name} (distribution chain ${campaign.distributionChainId}), compute on ${campaign.chain.name} (${campaign.computeChainId})`,
  );
  console.log(
    `  → reward token: ${campaign.rewardToken.symbol} (${campaign.rewardToken.address}, decimals ${campaign.rewardToken.decimals})`,
  );

  console.log(`Fetching rewards...`);
  const [expectedRewardCount, rewards] = await Promise.all([
    fetchRewardsCount(campaign.distributionChainId, campaign.campaignId, hide),
    fetchAllRewards(campaign.distributionChainId, campaign.campaignId, hide),
  ]);

  console.log(`  → ${rewards.length} recipient(s)`);

  if (
    expectedRewardCount !== undefined &&
    rewards.length !== expectedRewardCount
  ) {
    console.warn(
      `⚠️   Reward count mismatch: /v4/rewards/count returned ${expectedRewardCount}, but fetched ${rewards.length} row(s).`,
    );
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outputFile = `${OUTPUT_DIR}/${campaign.campaignId}.xlsx`;

  writeXlsx(outputFile, campaign, rewards, {
    expectedRewardCount,
    hide,
  });

  console.log(`Report saved to ${outputFile}`);
}

async function resolveCampaign(
  campaignHash: string,
  pinnedDistributionChainId: number | undefined,
): Promise<MerklCampaign> {
  const candidates = pinnedDistributionChainId
    ? [pinnedDistributionChainId]
    : CANDIDATE_DISTRIBUTION_CHAINS;

  for (const chainId of candidates) {
    const id = `${chainId}-${campaignHash}`;
    const res = await merklFetch(`/v4/campaigns/${id}`);

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

async function fetchRewardsCount(
  distributionChainId: number,
  campaignId: string,
  hide: boolean,
): Promise<number | undefined> {
  const qs = buildRewardsQuery(distributionChainId, campaignId, {
    page: 0,
    items: REWARDS_PAGE_SIZE,
    hide,
  });

  const res = await merklFetch(`/v4/rewards/count?${qs.toString()}`);

  if (!res.ok) {
    throw new Error(
      `GET /v4/rewards/count failed: ${res.status} ${res.statusText} ${await res.text()}`,
    );
  }

  const body = await res.json();
  return extractCount(body);
}

async function fetchAllRewards(
  distributionChainId: number,
  campaignId: string,
  hide: boolean,
): Promise<Reward[]> {
  const all: Reward[] = [];
  let page = 0;

  while (true) {
    const qs = buildRewardsQuery(distributionChainId, campaignId, {
      page,
      items: REWARDS_PAGE_SIZE,
      hide,
    });

    const res = await merklFetch(`/v4/rewards/?${qs.toString()}`);

    if (!res.ok) {
      throw new Error(
        `GET /v4/rewards/ failed: ${res.status} ${res.statusText} ${await res.text()}`,
      );
    }

    const body = await res.json();
    const rows = extractRewardRows(body);

    all.push(...rows);

    if (rows.length < REWARDS_PAGE_SIZE) break;
    page += 1;
  }

  return all;
}

function buildRewardsQuery(
  distributionChainId: number,
  campaignId: string,
  opts: {
    page: number;
    items: number;
    hide: boolean;
  },
): URLSearchParams {
  const qs = new URLSearchParams({
    chainId: String(distributionChainId),
    campaignId,
    page: String(opts.page),
    items: String(opts.items),
  });

  if (opts.hide) {
    qs.set("hide", "true");
  }

  return qs;
}

function extractRewardRows(body: unknown): Reward[] {
  if (Array.isArray(body)) {
    return body as Reward[];
  }

  if (isRecord(body)) {
    if (Array.isArray(body.rows)) return body.rows as Reward[];
    if (Array.isArray(body.data)) return body.data as Reward[];
    if (Array.isArray(body.rewards)) return body.rewards as Reward[];
  }

  throw new Error(
    `Unexpected /v4/rewards/ response shape: ${JSON.stringify(body).slice(0, 300)}`,
  );
}

function extractCount(body: unknown): number | undefined {
  if (typeof body === "number") return body;

  if (typeof body === "string" && body.trim() !== "") {
    const parsed = Number(body);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (!isRecord(body)) {
    return undefined;
  }

  const candidates = [
    body.count,
    body.total,
    body.value,
    body.result,
    body.data,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number") return candidate;

    if (typeof candidate === "string" && candidate.trim() !== "") {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return undefined;
}

function writeXlsx(
  outputFile: string,
  campaign: MerklCampaign,
  rewards: Reward[],
  opts: {
    expectedRewardCount?: number;
    hide: boolean;
  },
) {
  const decimals = campaign.rewardToken.decimals;
  const symbol = campaign.rewardToken.symbol;

  const totalRewardAmount = safeBig(campaign.amount);

  const totalFetchedAmount = rewards.reduce(
    (acc, row) => acc + (safeBig(row.amount) ?? 0n),
    0n,
  );
  const totalClaimedAmount = rewards.reduce(
    (acc, row) => acc + (safeBig(row.claimed) ?? 0n),
    0n,
  );
  const totalPendingAmount = rewards.reduce(
    (acc, row) => acc + (safeBig(row.pending) ?? 0n),
    0n,
  );

  const campaignInfo = [
    { Parameter: "Campaign Hash", Value: campaign.campaignId },
    { Parameter: "Composite ID", Value: campaign.id },
    { Parameter: "Type", Value: campaign.type },
    { Parameter: "Sub Type", Value: campaign.subType ?? "" },
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
      Value: String((campaign.params as { poolId?: string }).poolId ?? ""),
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
      Parameter: `Total Campaign Reward Amount (${symbol})`,
      Value:
        totalRewardAmount === undefined
          ? ""
          : formatUnits(totalRewardAmount, decimals),
    },
    { Parameter: "Total Campaign Reward Amount (raw)", Value: campaign.amount },
    {
      Parameter: `Total Fetched LP Rewards (${symbol})`,
      Value: formatUnits(totalFetchedAmount, decimals),
    },
    {
      Parameter: "Total Fetched LP Rewards (raw)",
      Value: totalFetchedAmount.toString(),
    },
    {
      Parameter: `Total Claimed (${symbol})`,
      Value: formatUnits(totalClaimedAmount, decimals),
    },
    {
      Parameter: "Total Claimed (raw)",
      Value: totalClaimedAmount.toString(),
    },
    {
      Parameter: `Total Unclaimed / Pending (${symbol})`,
      Value: formatUnits(totalPendingAmount, decimals),
    },
    {
      Parameter: "Total Unclaimed / Pending (raw)",
      Value: totalPendingAmount.toString(),
    },
    {
      Parameter: "Start Timestamp (UTC)",
      Value: formatUnixTimestamp(campaign.startTimestamp),
    },
    {
      Parameter: "End Timestamp (UTC)",
      Value: formatUnixTimestamp(campaign.endTimestamp),
    },
    {
      Parameter: "Start Timestamp (unix)",
      Value: String(campaign.startTimestamp),
    },
    { Parameter: "End Timestamp (unix)", Value: String(campaign.endTimestamp) },
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
      Parameter: "Computed Until",
      Value: campaign.campaignStatus?.computedUntil ?? "",
    },
    {
      Parameter: "Status Error",
      Value: campaign.campaignStatus?.error ?? "",
    },
    { Parameter: "Created At", Value: campaign.createdAt },
    { Parameter: "Reward Endpoint", Value: "/v4/rewards/" },
    {
      Parameter: "Count Endpoint",
      Value: "/v4/rewards/count",
    },
    {
      Parameter: "Expected Recipients",
      Value: opts.expectedRewardCount ?? "",
    },
    { Parameter: "Fetched Recipients", Value: rewards.length },
    {
      Parameter: "Hide Creator/Admin",
      Value: opts.hide ? "true" : "false",
    },
  ];

  const lpRewards = rewards.map((row) => {
    const amount = safeBig(row.amount);
    const claimed = safeBig(row.claimed);
    const unclaimed = safeBig(row.pending);

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
      unclaimed_raw: row.pending ?? "",
      reason: row.reason ?? "",
      rewardTokenAddress: row.rewardTokenAddress ?? "",
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

  const campaignInfoSheet = XLSX.utils.json_to_sheet(campaignInfo);
  const lpRewardsSheet = XLSX.utils.json_to_sheet(lpRewards);

  autosizeColumns(campaignInfoSheet, campaignInfo);
  autosizeColumns(lpRewardsSheet, lpRewards);

  XLSX.utils.book_append_sheet(wb, campaignInfoSheet, "Campaign Info");
  XLSX.utils.book_append_sheet(wb, lpRewardsSheet, "LP Rewards");

  XLSX.writeFile(wb, outputFile);
}

function safeBig(
  value: string | number | bigint | undefined | null,
): bigint | undefined {
  if (value === undefined || value === null || value === "") return undefined;

  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return undefined;
      return BigInt(Math.trunc(value));
    }
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function formatUnixTimestamp(
  value: number | string | bigint | undefined,
): string {
  const timestamp = Number(value);

  if (!Number.isFinite(timestamp)) return "";

  return new Date(timestamp * 1000).toISOString();
}

function autosizeColumns<T extends Record<string, unknown>>(
  sheet: XLSX.WorkSheet,
  rows: T[],
) {
  const widths: { wch: number }[] = [];

  for (const row of rows) {
    Object.entries(row).forEach(([key, value], index) => {
      const cellLength = String(value ?? "").length;
      const headerLength = key.length;
      const width = Math.max(cellLength, headerLength, 10);

      widths[index] = {
        wch: Math.min(Math.max(widths[index]?.wch ?? 0, width), 80),
      };
    });
  }

  sheet["!cols"] = widths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Minimal types for the global `fetch` (available since Node 18) — the project's
// @types/node version may predate the typings, so we declare what we use locally.
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

async function merklFetch(pathAndQuery: string): Promise<MerklResponse> {
  return fetch(`${MERKL_API}${pathAndQuery}`, {
    headers: { accept: "application/json" },
  });
}

function parseCLIArgs(args: string[]): CLIArgs {
  let campaignHash = DEFAULT_CAMPAIGN_ID;
  let distributionChainId: number | undefined;
  let hide = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--distributionChainId") {
      const next = args[++i];

      if (!next) throw new Error("--distributionChainId requires a value");

      distributionChainId = Number(next);

      if (!Number.isInteger(distributionChainId)) {
        throw new Error(`Invalid --distributionChainId: ${next}`);
      }
    } else if (arg === "--hide") {
      hide = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (!arg.startsWith("-")) {
      campaignHash = arg;
    }
  }

  if (!campaignHash.startsWith("0x")) {
    throw new Error(
      `Invalid campaignId, expected 0x-prefixed hash: ${campaignHash}`,
    );
  }

  return { campaignHash, distributionChainId, hide };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
