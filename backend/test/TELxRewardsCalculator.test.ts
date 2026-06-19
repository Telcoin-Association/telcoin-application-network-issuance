import { expect } from "chai";
import { getAddress, zeroAddress, type Address, type PublicClient } from "viem";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  deriveVwapResult,
  populateTotalFeesCommonDenominator,
  calculateRewardDistribution,
  initialize,
  PRECISION,
  LPData,
  PositionState,
} from "../calculators/TELxRewardsCalculator";

const LP_A = getAddress("0x000000000000000000000000000000000000000a");
const LP_B = getAddress("0x000000000000000000000000000000000000000b");
const LP_C = getAddress("0x000000000000000000000000000000000000000c");

function makeLP(fees0: bigint, fees1: bigint): LPData {
  return {
    periodFeesCurrency0: fees0,
    periodFeesCurrency1: fees1,
    periodFeesCurrency0Weighted: fees0,
    periodFeesCurrency1Weighted: fees1,
  };
}

function makeLPMap(
  entries: Array<[Address, bigint, bigint]>,
): Map<Address, LPData> {
  const m = new Map<Address, LPData>();
  for (const [addr, f0, f1] of entries) m.set(addr, makeLP(f0, f1));
  return m;
}

describe("deriveVwapResult", () => {
  it("A1: both deltas non-zero, denomIsCurrency0=true → vwap price = delta0/delta1 scaled", () => {
    const result = deriveVwapResult(100n, 50n, true);
    expect(result.kind).to.equal("vwap");
    if (result.kind === "vwap") {
      expect(result.priceScaled).to.equal((100n * PRECISION) / 50n);
    }
  });

  it("A2: both deltas non-zero, denomIsCurrency0=false → vwap price = delta1/delta0 scaled", () => {
    const result = deriveVwapResult(100n, 50n, false);
    expect(result.kind).to.equal("vwap");
    if (result.kind === "vwap") {
      expect(result.priceScaled).to.equal((50n * PRECISION) / 100n);
    }
  });

  it("A3: only currency0 grew → singleSided with growingIsCurrency0=true", () => {
    const result = deriveVwapResult(100n, 0n, false);
    expect(result).to.deep.equal({
      kind: "singleSided",
      growingIsCurrency0: true,
    });
  });

  it("A4: only currency1 grew → singleSided with growingIsCurrency0=false", () => {
    const result = deriveVwapResult(0n, 100n, true);
    expect(result).to.deep.equal({
      kind: "singleSided",
      growingIsCurrency0: false,
    });
  });

  it("A5: both flat → singleSided (terminal; downstream empty-map guard pays zero rewards)", () => {
    const result = deriveVwapResult(0n, 0n, true);
    expect(result.kind).to.equal("singleSided");
  });

  it("A6: both flat → full pipeline yields empty reward map (no rewards paid)", async () => {
    const vwapResult = deriveVwapResult(0n, 0n, true);
    const lpData = makeLPMap([
      [LP_A, 0n, 0n],
      [LP_B, 0n, 0n],
    ]);
    if (vwapResult.kind !== "singleSided")
      throw new Error("expected singleSided");
    const populated = await populateTotalFeesCommonDenominator(
      lpData,
      vwapResult,
      true,
    );
    const rewards = calculateRewardDistribution(populated, 1_000_000n);
    expect(rewards.size).to.equal(0);
  });

  it("A7: equal non-zero deltas → priceScaled === PRECISION on both denom orientations", () => {
    const resultDenom0 = deriveVwapResult(100n, 100n, true);
    if (resultDenom0.kind !== "vwap") throw new Error("expected vwap");
    expect(resultDenom0.priceScaled).to.equal(PRECISION);

    const resultDenom1 = deriveVwapResult(100n, 100n, false);
    if (resultDenom1.kind !== "vwap") throw new Error("expected vwap");
    expect(resultDenom1.priceScaled).to.equal(PRECISION);
  });
});

describe("populateTotalFeesCommonDenominator", () => {
  it("B1: vwap path, denomIs0=true → total = fees0 + fees1 * priceScaled / PRECISION", async () => {
    const lpData = makeLPMap([
      [LP_A, 100n, 50n],
      [LP_B, 40n, 60n],
    ]);
    const result = await populateTotalFeesCommonDenominator(
      lpData,
      { kind: "vwap", priceScaled: 2n * PRECISION },
      true,
    );
    expect(result.get(LP_A)?.totalFeesCommonDenominatorWeighted).to.equal(
      100n + 50n * 2n,
    );
    expect(result.get(LP_B)?.totalFeesCommonDenominatorWeighted).to.equal(
      40n + 60n * 2n,
    );
  });

  it("B2: vwap path, denomIs0=false → total = fees1 + fees0 * priceScaled / PRECISION", async () => {
    const lpData = makeLPMap([
      [LP_A, 100n, 50n],
      [LP_B, 40n, 60n],
    ]);
    const result = await populateTotalFeesCommonDenominator(
      lpData,
      { kind: "vwap", priceScaled: 3n * PRECISION },
      false,
    );
    expect(result.get(LP_A)?.totalFeesCommonDenominatorWeighted).to.equal(
      50n + 100n * 3n,
    );
    expect(result.get(LP_B)?.totalFeesCommonDenominatorWeighted).to.equal(
      60n + 40n * 3n,
    );
  });

  it("B3: singleSided growingIsCurrency0=true → total = periodFeesCurrency0Weighted", async () => {
    // When the pool earns no currency1 fees globally, no LP can accrue currency1
    // fees either (per-LP fees are drawn from the global accumulator). Fixtures
    // reflect that by setting the flat side to zero for every LP.
    const lpData = makeLPMap([
      [LP_A, 100n, 0n],
      [LP_B, 40n, 0n],
    ]);
    const result = await populateTotalFeesCommonDenominator(
      lpData,
      { kind: "singleSided", growingIsCurrency0: true },
      false,
    );
    expect(result.get(LP_A)?.totalFeesCommonDenominatorWeighted).to.equal(100n);
    expect(result.get(LP_B)?.totalFeesCommonDenominatorWeighted).to.equal(40n);
  });

  it("B4: singleSided growingIsCurrency0=false → total = periodFeesCurrency1Weighted", async () => {
    const lpData = makeLPMap([
      [LP_A, 0n, 50n],
      [LP_B, 0n, 60n],
    ]);
    const result = await populateTotalFeesCommonDenominator(
      lpData,
      { kind: "singleSided", growingIsCurrency0: false },
      true,
    );
    expect(result.get(LP_A)?.totalFeesCommonDenominatorWeighted).to.equal(50n);
    expect(result.get(LP_B)?.totalFeesCommonDenominatorWeighted).to.equal(60n);
  });

  it("B5: singleSided; LP was out of range on growing side → total = 0", async () => {
    // An LP whose position sat outside the active tick range during the period
    // accrues zero on the growing side even though the pool as a whole earned
    // fees there. Such an LP should receive no ranking weight.
    const lpData = makeLPMap([
      [LP_A, 0n, 0n],
      [LP_B, 40n, 0n],
    ]);
    const result = await populateTotalFeesCommonDenominator(
      lpData,
      { kind: "singleSided", growingIsCurrency0: true },
      false,
    );
    expect(result.get(LP_A)?.totalFeesCommonDenominatorWeighted).to.equal(0n);
    expect(result.get(LP_B)?.totalFeesCommonDenominatorWeighted).to.equal(40n);
  });
});

describe("distribution equivalence when one side is globally flat", () => {
  // In production a singleSided period has no observable VWAP (one side's fee
  // growth is flat, so delta1/delta0 is undefined). These tests feed the same
  // fixture through both branches to show that *if* a VWAP could be computed,
  // the singleSided fallback and the VWAP path would rank LPs identically.
  // The price is a scalar that cancels in the single sided case. This is what justifies using
  // the growing side alone as the ranking metric.
  const REWARD = 1_000_000n;
  const entries: Array<[Address, bigint, bigint]> = [
    [LP_A, 100n, 0n],
    [LP_B, 250n, 0n],
    [LP_C, 75n, 0n],
  ];

  it("C1: zero currency1 fees pool-wide; singleSided(cur0) ≡ vwap with denomIs0=false", async () => {
    const lpX = makeLPMap(entries);
    await populateTotalFeesCommonDenominator(
      lpX,
      { kind: "vwap", priceScaled: 2n * PRECISION },
      false,
    );
    const rewardsX = calculateRewardDistribution(lpX, REWARD);

    const lpY = makeLPMap(entries);
    await populateTotalFeesCommonDenominator(
      lpY,
      { kind: "singleSided", growingIsCurrency0: true },
      false,
    );
    const rewardsY = calculateRewardDistribution(lpY, REWARD);

    for (const [addr] of entries) {
      expect(rewardsX.get(addr)?.reward).to.equal(rewardsY.get(addr)?.reward);
    }
  });

  it("C2: zero currency1 fees pool-wide; singleSided(cur0) ≡ vwap with denomIs0=true", async () => {
    const lpX = makeLPMap(entries);
    await populateTotalFeesCommonDenominator(
      lpX,
      { kind: "vwap", priceScaled: 5n * PRECISION },
      true,
    );
    const rewardsX = calculateRewardDistribution(lpX, REWARD);

    const lpY = makeLPMap(entries);
    await populateTotalFeesCommonDenominator(
      lpY,
      { kind: "singleSided", growingIsCurrency0: true },
      true,
    );
    const rewardsY = calculateRewardDistribution(lpY, REWARD);

    for (const [addr] of entries) {
      expect(rewardsX.get(addr)?.reward).to.equal(rewardsY.get(addr)?.reward);
    }
  });

  const entriesCur1Only: Array<[Address, bigint, bigint]> = [
    [LP_A, 0n, 100n],
    [LP_B, 0n, 250n],
    [LP_C, 0n, 75n],
  ];

  it("C3: zero currency0 fees pool-wide; singleSided(cur1) ≡ vwap with denomIs0=true", async () => {
    const lpX = makeLPMap(entriesCur1Only);
    await populateTotalFeesCommonDenominator(
      lpX,
      { kind: "vwap", priceScaled: 2n * PRECISION },
      true,
    );
    const rewardsX = calculateRewardDistribution(lpX, REWARD);

    const lpY = makeLPMap(entriesCur1Only);
    await populateTotalFeesCommonDenominator(
      lpY,
      { kind: "singleSided", growingIsCurrency0: false },
      true,
    );
    const rewardsY = calculateRewardDistribution(lpY, REWARD);

    for (const [addr] of entriesCur1Only) {
      expect(rewardsX.get(addr)?.reward).to.equal(rewardsY.get(addr)?.reward);
    }
  });

  it("C4: zero currency0 fees pool-wide; singleSided(cur1) ≡ vwap with denomIs0=false", async () => {
    const lpX = makeLPMap(entriesCur1Only);
    await populateTotalFeesCommonDenominator(
      lpX,
      { kind: "vwap", priceScaled: 5n * PRECISION },
      false,
    );
    const rewardsX = calculateRewardDistribution(lpX, REWARD);

    const lpY = makeLPMap(entriesCur1Only);
    await populateTotalFeesCommonDenominator(
      lpY,
      { kind: "singleSided", growingIsCurrency0: false },
      false,
    );
    const rewardsY = calculateRewardDistribution(lpY, REWARD);

    for (const [addr] of entriesCur1Only) {
      expect(rewardsX.get(addr)?.reward).to.equal(rewardsY.get(addr)?.reward);
    }
  });
});

describe("initialize burned-position handling", () => {
  const CHECKPOINT_END = 1000n;
  const START_BLOCK = CHECKPOINT_END + 1n;
  const END_BLOCK = 2000n;
  const POSITION_MANAGER = getAddress(
    "0x0000000000000000000000000000000000000001",
  );

  // keys: 100 active, 200 liquidity-0 but still alive on-chain, 300 fully burned
  const BURNED_KEY = 300n;

  function makePosition(liquidity: bigint): PositionState {
    return {
      lastOwner: zeroAddress,
      tickLower: -100,
      tickUpper: 100,
      liquidity,
      feeGrowthInsidePeriod0: 123n,
      feeGrowthInsidePeriod1: 456n,
      feeGrowthInsidePeriod0Weighted: 0n,
      feeGrowthInsidePeriod1Weighted: 0n,
      liquidityModifications: [
        {
          blockNumber: 999n,
          newLiquidityAmount: liquidity,
          owner: zeroAddress,
          isSubscribed: false,
          type: "synthetic",
        },
      ],
      designation: "ACTIVE",
    };
  }

  // positionInfo returns 0n only for the fully-burned token, non-zero otherwise
  const client = {
    readContract: async ({ args }: { args: readonly bigint[] }) =>
      args[0] === BURNED_KEY ? 0n : 1n,
  } as unknown as PublicClient;

  let checkpointFile: string;

  beforeEach(async () => {
    checkpointFile = join(tmpdir(), `telx-init-test-${Date.now()}.json`);
    const checkpoint = {
      blockRange: { network: "polygon", startBlock: 1n, endBlock: CHECKPOINT_END },
      poolId: zeroAddress,
      denominator: zeroAddress,
      currency0: zeroAddress,
      currency1: zeroAddress,
      positions: [
        [100n, makePosition(5n)],
        [200n, makePosition(0n)],
        [BURNED_KEY, makePosition(0n)],
      ],
      lpData: [],
    };
    await writeFile(
      checkpointFile,
      JSON.stringify(checkpoint, (_k, v) =>
        typeof v === "bigint" ? v.toString() + "n" : v,
      ),
      "utf-8",
    );
  });

  afterEach(async () => {
    await unlink(checkpointFile).catch(() => {});
  });

  it("deletes a fully-burned position instead of re-touching the deleted key", async () => {
    const positions = await initialize(
      checkpointFile,
      1,
      START_BLOCK,
      END_BLOCK,
      client,
      POSITION_MANAGER,
    );

    // burned position dropped; the other two survive
    expect(positions.has(BURNED_KEY)).to.equal(false);
    expect(positions.has(100n)).to.equal(true);
    expect(positions.has(200n)).to.equal(true);
  });

  it("wipes per-period fees and modifications on surviving positions", async () => {
    const positions = await initialize(
      checkpointFile,
      1,
      START_BLOCK,
      END_BLOCK,
      client,
      POSITION_MANAGER,
    );

    // including the liquidity-0 position that stayed alive on-chain (200)
    for (const key of [100n, 200n]) {
      const p = positions.get(key)!;
      expect(p.feeGrowthInsidePeriod0).to.equal(0n);
      expect(p.feeGrowthInsidePeriod1).to.equal(0n);
      expect(p.liquidityModifications).to.deep.equal([]);
    }
  });
});
