import type { Address, PublicClient } from "viem";
import {
  calculateFeeGrowthInside,
  calculateFees,
  findInitializedTickAbove,
} from "../calculators/TELxRewardsCalculator";

type BitmapMap = Record<number, bigint>;

const MOCK_POOL_ID =
  "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20" as `0x${string}`;
const MOCK_STATE_VIEW =
  "0x0000000000000000000000000000000000000001" as Address;

describe("findInitializedTickAbove", () => {
  it("returns the starting tick when it is already initialized", async () => {
    const { client } = createMockClient({ 0: 1n << 17n });

    const result = await findInitializedTickAbove(
      client,
      MOCK_POOL_ID,
      MOCK_STATE_VIEW,
      1020,
      60,
      1n
    );

    expect(result).toBe(1020);
  });

  it("finds the nearest initialized tick in the same word", async () => {
    const { client } = createMockClient({ 0: 1n << 20n });

    const result = await findInitializedTickAbove(
      client,
      MOCK_POOL_ID,
      MOCK_STATE_VIEW,
      1020,
      60,
      1n
    );

    const expectedTick = (20 * 60);
    expect(result).toBe(expectedTick);
  });

  it("searches subsequent words when necessary", async () => {
    const { client } = createMockClient({ 1: 1n });

    const result = await findInitializedTickAbove(
      client,
      MOCK_POOL_ID,
      MOCK_STATE_VIEW,
      0,
      60,
      1n
    );

    const expectedTick = (256 * 60);
    expect(result).toBe(expectedTick);
  });

  it("handles negative tick ranges", async () => {
    const { client } = createMockClient({ [-1]: 1n << 253n });

    const result = await findInitializedTickAbove(
      client,
      MOCK_POOL_ID,
      MOCK_STATE_VIEW,
      -30,
      10,
      1n
    );

    expect(result).toBe(-30);
  });

  it("returns null when no initialized tick is found within the search limit", async () => {
    const { client, readContractMock } = createMockClient({});

    const result = await findInitializedTickAbove(
      client,
      MOCK_POOL_ID,
      MOCK_STATE_VIEW,
      0,
      60,
      1n,
      2
    );

    expect(result).toBeNull();
    expect(readContractMock).toHaveBeenCalledTimes(2);
  });
});

describe("calculateFeeGrowthInside", () => {
  it("wraps negative results using uint256 modulo", () => {
    const maxUint256 = 2n ** 256n;
    const result = calculateFeeGrowthInside(10n, 20n, 25n);
    expect(result).toBe((10n - 20n - 25n + maxUint256) % maxUint256);
  });
});

describe("calculateFees", () => {
  it("handles wrap-around when end < start", () => {
    const maxUint256 = 2n ** 256n;
    const start = maxUint256 - 5n;
    const end = 3n;
    const liquidity = 1n << 128n;
    const { token0Fees } = calculateFees(liquidity, end, 0n, start, 0n);
    // fee delta is 8 (wrap from end-start modulo 2^256)
    expect(token0Fees).toBe(8n);
  });
});

function createMockClient(bitmaps: BitmapMap): {
  client: PublicClient;
  readContractMock: jest.Mock;
} {
  const readContractMock = jest.fn(
    async ({ args }: { args: readonly [`0x${string}`, number] }) => {
      const [, wordPosition] = args;
      return bitmaps[wordPosition] ?? 0n;
    }
  );

  const client = {
    readContract: readContractMock,
  } as unknown as PublicClient;

  return { client, readContractMock };
}
