import { expect } from "chai";
import { getAddress, type Address } from "viem";
import {
  deriveVwapResult,
  populateTotalFeesCommonDenominator,
  calculateRewardDistribution,
  PRECISION,
  LPData,
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
});
