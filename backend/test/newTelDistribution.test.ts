import { describe, it, expect } from "@jest/globals";
import {
  Address,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  Hex,
} from "viem";
import { ChainId, config } from "../config";
import {
  AccountingError,
  assertWithinBudget,
  batchFilesToRemove,
  buildStubSetupBatch,
  buildTanBatches,
  chunkRewards,
  classifyChunk,
  OLD_TO_NEW_TEL_SCALE,
  parsePeriod,
  parseTanRewards,
  RewardEntry,
  SafeBatch,
  safeBatchFromJson,
  selectPolygonRange,
  TAN_BUDGET,
  TAN_ISSUANCE_HISTORY,
  TanIssuanceHistoryWriteAbi,
  toNewTel,
  toSafeTxBuilderJson,
  verifyTanBatches,
} from "../newTelDistribution";

const NEW_TEL = config.rewardTelToken.address;
const A = getAddress("0x00000000000000000000000000000000000000a1");
const B = getAddress("0x00000000000000000000000000000000000000b2");
const C = getAddress("0x00000000000000000000000000000000000000c3");
const D = getAddress("0x00000000000000000000000000000000000000d4");
const E = getAddress("0x00000000000000000000000000000000000000e5");
const END_BLOCK = 80_000_000n;

const tanRewards: RewardEntry[] = [
  { address: A, amount: 123_456n },
  { address: B, amount: 1n },
  { address: C, amount: 99_999_999n },
];

function encodeTransfer(to: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
  });
}

function encodeRecord(rewards: RewardEntry[], endBlock: bigint): Hex {
  return encodeFunctionData({
    abi: TanIssuanceHistoryWriteAbi,
    functionName: "increaseClaimableByBatch",
    args: [
      rewards.map((r) => ({ account: r.address, amount: r.amount })),
      endBlock,
    ],
  });
}

function clone(batches: SafeBatch[]): SafeBatch[] {
  return batches.map((b) => ({
    ...b,
    transactions: b.transactions.map((tx) => ({ ...tx })),
  }));
}

describe("unit conversion", () => {
  it("scales 2-decimal old TEL to 18-decimal new TEL", () => {
    expect(OLD_TO_NEW_TEL_SCALE).toBe(10n ** 16n);
    expect(toNewTel(0n)).toBe(0n);
    expect(toNewTel(1n)).toBe(10_000_000_000_000_000n);
    expect(toNewTel(12_345n)).toBe(123_450_000_000_000_000_000n);
  });

  it("rejects negative amounts", () => {
    expect(() => toNewTel(-1n)).toThrow();
  });
});

describe("reward parsing", () => {
  it("parses TAN rewards and drops zero entries", () => {
    const parsed = parseTanRewards({
      blockRanges: [],
      stakerIncentives: [
        { address: A, reward: "100" as unknown as bigint },
        { address: B, reward: "0" as unknown as bigint },
        { address: C, reward: "7" as unknown as bigint },
      ],
    });
    expect(parsed).toEqual([
      { address: A, amount: 100n },
      { address: C, amount: 7n },
    ]);
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "  "],
    ["hex", "0x10"],
    ["a decimal fraction", "1.5"],
    ["a negative", "-1"],
    ["a JSON number", 123],
  ])("rejects a reward given as %s", (_, reward) => {
    expect(() =>
      parseTanRewards({
        blockRanges: [],
        stakerIncentives: [{ address: A, reward: reward as unknown as bigint }],
      }),
    ).toThrow(AccountingError);
  });
});

describe("selectPolygonRange", () => {
  it("returns the single polygon range as bigints, ignoring other networks", () => {
    expect(
      selectPolygonRange([
        { network: "mainnet", startBlock: "1", endBlock: "2" },
        { network: "polygon", startBlock: "900", endBlock: "1000" },
      ] as never),
    ).toEqual({ startBlock: 900n, endBlock: 1000n });
  });

  it.each([
    ["no polygon range", [{ network: "mainnet", startBlock: "1", endBlock: "2" }]],
    [
      "two polygon ranges",
      [
        { network: "polygon", startBlock: "1", endBlock: "2" },
        { network: "polygon", startBlock: "3", endBlock: "4" },
      ],
    ],
    ["a non-decimal block", [{ network: "polygon", startBlock: "0x10", endBlock: "20" }]],
    ["an empty block", [{ network: "polygon", startBlock: "1", endBlock: "" }]],
    ["start after end", [{ network: "polygon", startBlock: "5", endBlock: "4" }]],
  ])("rejects %s", (_, ranges) => {
    expect(() => selectPolygonRange(ranges as never)).toThrow(AccountingError);
  });
});

describe("chunk status", () => {
  const chunk: RewardEntry[] = [
    { address: A, amount: 100n },
    { address: B, amount: 5n },
  ];
  const deltas = (a: bigint, b: bigint) =>
    new Map<Address, bigint>([
      [A, a],
      [B, b],
    ]);

  it("chunks rewards the same way buildTanBatches does", () => {
    const rewards = [A, B, C].map((address, i) => ({ address, amount: BigInt(i + 1) }));
    expect(chunkRewards(rewards, 2)).toEqual([rewards.slice(0, 2), rewards.slice(2)]);
    expect(buildTanBatches(rewards, END_BLOCK, 2)).toHaveLength(2);
  });

  it("is executed when every rewardee's recorded delta equals its reward", () => {
    expect(classifyChunk(chunk, deltas(100n, 5n))).toBe("executed");
  });

  it("is pending when nothing was recorded for any rewardee", () => {
    expect(classifyChunk(chunk, deltas(0n, 0n))).toBe("pending");
    expect(classifyChunk(chunk, new Map())).toBe("pending");
  });

  it.each([
    ["recorded twice", 200n, 10n],
    ["partly recorded", 100n, 0n],
    ["recorded with a different amount", 99n, 5n],
  ])("is inconsistent when %s", (_, a, b) => {
    expect(classifyChunk(chunk, deltas(a, b))).toBe("inconsistent");
  });
});

describe("buildTanBatches", () => {
  it("pairs one record call with the matching new-TEL transfers in a single batch", () => {
    const batches = buildTanBatches(tanRewards, END_BLOCK);
    expect(batches).toHaveLength(1);

    const [batch] = batches;
    expect(batch.chainId).toBe(ChainId.Polygon);
    expect(batch.transactions).toHaveLength(1 + tanRewards.length);

    const [record, ...transfers] = batch.transactions;
    expect(record.to).toBe(TAN_ISSUANCE_HISTORY);
    expect(record.value).toBe("0");
    const decoded = decodeFunctionData({
      abi: TanIssuanceHistoryWriteAbi,
      data: record.data,
    });
    expect(decoded.functionName).toBe("increaseClaimableByBatch");
    expect(decoded.args[0]).toEqual(
      tanRewards.map((r) => ({ account: r.address, amount: r.amount })),
    );
    expect(decoded.args[1]).toBe(END_BLOCK);

    transfers.forEach((tx, i) => {
      expect(tx.to).toBe(NEW_TEL);
      expect(tx.value).toBe("0");
      expect(tx.data).toBe(
        encodeTransfer(tanRewards[i].address, toNewTel(tanRewards[i].amount)),
      );
    });
  });

  it("chunks into self-contained batches", () => {
    const rewards = [A, B, C, D, E].map((address, i) => ({
      address,
      amount: BigInt(i + 1),
    }));
    const batches = buildTanBatches(rewards, END_BLOCK, 2);
    expect(batches.map((b) => b.transactions.length)).toEqual([3, 3, 2]);

    batches.forEach((batch, i) => {
      const chunk = rewards.slice(i * 2, i * 2 + 2);
      expect(batch.transactions[0].data).toBe(encodeRecord(chunk, END_BLOCK));
      chunk.forEach((r, j) =>
        expect(batch.transactions[1 + j].data).toBe(
          encodeTransfer(r.address, toNewTel(r.amount)),
        ),
      );
    });
  });

  it("rejects the zero address", () => {
    expect(() =>
      buildTanBatches(
        [{ address: getAddress("0x0000000000000000000000000000000000000000"), amount: 1n }],
        END_BLOCK,
      ),
    ).toThrow(AccountingError);
  });

  it("rejects zero amounts and duplicate rewardees", () => {
    expect(() =>
      buildTanBatches([{ address: A, amount: 0n }], END_BLOCK),
    ).toThrow(AccountingError);
    expect(() =>
      buildTanBatches(
        [
          { address: A, amount: 1n },
          { address: A, amount: 2n },
        ],
        END_BLOCK,
      ),
    ).toThrow(AccountingError);
  });
});

describe("verifyTanBatches", () => {
  const batches = buildTanBatches(tanRewards, END_BLOCK);
  const expectedOld = 123_456n + 1n + 99_999_999n;

  it("reports matching totals in both units", () => {
    const report = verifyTanBatches(tanRewards, END_BLOCK, batches);
    expect(report.expectedOldTotal).toBe(expectedOld);
    expect(report.recordedOldTotal).toBe(expectedOld);
    expect(report.transferredNewTotal).toBe(expectedOld * 10n ** 16n);
    expect(report.recipients).toBe(3);
    expect(report.oldTotalFormatted).toBe("1001234.56");
    expect(report.newTotalFormatted).toBe("1001234.56");
  });

  it("passes for chunked batches", () => {
    const chunked = buildTanBatches(tanRewards, END_BLOCK, 1);
    expect(() => verifyTanBatches(tanRewards, END_BLOCK, chunked)).not.toThrow();
  });

  it("fails when a transfer is off by one wei", () => {
    const tampered = clone(batches);
    tampered[0].transactions[1].data = encodeTransfer(
      A,
      toNewTel(123_456n) + 1n,
    );
    expect(() => verifyTanBatches(tanRewards, END_BLOCK, tampered)).toThrow(
      AccountingError,
    );
  });

  it("fails when a transfer is left in old-TEL units", () => {
    const tampered = clone(batches);
    tampered[0].transactions[1].data = encodeTransfer(A, 123_456n);
    expect(() => verifyTanBatches(tanRewards, END_BLOCK, tampered)).toThrow(
      AccountingError,
    );
  });

  it("fails when a transfer targets the old TEL token", () => {
    const tampered = clone(batches);
    tampered[0].transactions[1].to = config.telToken[ChainId.Polygon].address;
    expect(() => verifyTanBatches(tanRewards, END_BLOCK, tampered)).toThrow(
      AccountingError,
    );
  });

  it("fails when a recorded amount differs from the rewards file", () => {
    const tampered = clone(batches);
    tampered[0].transactions[0].data = encodeRecord(
      [{ address: A, amount: 123_457n }, ...tanRewards.slice(1)],
      END_BLOCK,
    );
    expect(() => verifyTanBatches(tanRewards, END_BLOCK, tampered)).toThrow(
      AccountingError,
    );
  });

  it("fails when the record uses a different endBlock", () => {
    const tampered = clone(batches);
    tampered[0].transactions[0].data = encodeRecord(tanRewards, END_BLOCK + 1n);
    expect(() => verifyTanBatches(tanRewards, END_BLOCK, tampered)).toThrow(
      AccountingError,
    );
  });

  it("fails when a transfer is missing", () => {
    const tampered = clone(batches);
    tampered[0].transactions.pop();
    expect(() => verifyTanBatches(tanRewards, END_BLOCK, tampered)).toThrow(
      AccountingError,
    );
  });

  it("fails when an extra transfer is added", () => {
    const tampered = clone(batches);
    tampered[0].transactions.push({
      to: NEW_TEL,
      value: "0",
      data: encodeTransfer(D, 1n),
    });
    expect(() => verifyTanBatches(tanRewards, END_BLOCK, tampered)).toThrow(
      AccountingError,
    );
  });

  it("fails when transfer recipients are swapped", () => {
    const tampered = clone(batches);
    tampered[0].transactions[1].data = encodeTransfer(B, toNewTel(123_456n));
    tampered[0].transactions[2].data = encodeTransfer(A, toNewTel(1n));
    expect(() => verifyTanBatches(tanRewards, END_BLOCK, tampered)).toThrow(
      AccountingError,
    );
  });

  it("fails when a transfer is moved out of its record's batch", () => {
    const chunked = clone(buildTanBatches(tanRewards, END_BLOCK, 2));
    const moved = chunked[0].transactions.pop()!;
    chunked[1].transactions.push(moved);
    expect(() => verifyTanBatches(tanRewards, END_BLOCK, chunked)).toThrow(
      AccountingError,
    );
  });

  it("fails on a non-zero native value", () => {
    const tampered = clone(batches);
    tampered[0].transactions[1].value = "1" as "0";
    expect(() => verifyTanBatches(tanRewards, END_BLOCK, tampered)).toThrow(
      AccountingError,
    );
  });
});

describe("buildStubSetupBatch", () => {
  it("points TANIssuanceHistory at the record-only plugin", () => {
    const stub = getAddress("0x00000000000000000000000000000000000057b0");
    const batch = buildStubSetupBatch(stub);
    expect(batch.chainId).toBe(ChainId.Polygon);
    expect(batch.transactions).toEqual([
      {
        to: TAN_ISSUANCE_HISTORY,
        value: "0",
        data: encodeFunctionData({
          abi: TanIssuanceHistoryWriteAbi,
          functionName: "setTanIssuancePlugin",
          args: [stub],
        }),
      },
    ]);
  });
});

describe("toSafeTxBuilderJson", () => {
  it("produces a Safe Transaction Builder batch file", () => {
    const [batch] = buildTanBatches(tanRewards, END_BLOCK);
    const json = toSafeTxBuilderJson(batch, {
      name: "TAN period 51",
      description: "record + pay",
      safeAddress: getAddress("0x8Dcf8d134F22aC625A7aFb39514695801CD705b5"),
    });

    expect(json).toEqual({
      version: "1.0",
      chainId: "137",
      createdAt: 0,
      meta: {
        name: "TAN period 51",
        description: "record + pay",
        txBuilderVersion: "1.16.5",
        createdFromSafeAddress: "0x8Dcf8d134F22aC625A7aFb39514695801CD705b5",
        createdFromOwnerAddress: "",
      },
      transactions: batch.transactions.map((tx) => ({
        to: tx.to,
        value: "0",
        data: tx.data,
        contractMethod: null,
        contractInputsValues: null,
      })),
    });
  });

  it("is deterministic so signers can reproduce each file's sha256", () => {
    const meta = { name: "n", description: "d", safeAddress: A };
    const [batch] = buildTanBatches(tanRewards, END_BLOCK);
    expect(JSON.stringify(toSafeTxBuilderJson(batch, meta))).toBe(
      JSON.stringify(toSafeTxBuilderJson(buildTanBatches(tanRewards, END_BLOCK)[0], meta)),
    );
  });
});

describe("budget caps", () => {
  it("allows totals up to and including the budget", () => {
    expect(() => assertWithinBudget("TAN", tanRewards, 100_123_456n)).not.toThrow();
  });

  it("fails when the total exceeds the budget by one unit", () => {
    expect(() => assertWithinBudget("TAN", tanRewards, 100_123_455n)).toThrow(
      AccountingError,
    );
  });

  it("caps TAN at the configured staker incentives amount", () => {
    expect(TAN_BUDGET).toBe(config.incentivesAmounts.stakerIncentivesAmount);
  });

});

describe("parsePeriod", () => {
  it("accepts non-negative integers", () => {
    expect(parsePeriod("0")).toBe(0);
    expect(parsePeriod("51")).toBe(51);
  });

  it.each(["", "5a", "-1", "1.5", "../5", "5/../../x"])(
    "rejects %p",
    (value) => {
      expect(() => parsePeriod(value)).toThrow();
    },
  );
});

describe("batchFilesToRemove", () => {
  const files = [
    "safe_batch_period_5_tan_0.json",
    "safe_batch_period_5_tan_3.json",
    "safe_batch_period_51_tan_0.json",
    "safe_batch_period_5_telx_polygon_0.json",
    "safe_param_period_5_tan_chunk_0.json",
    "safe_param_period_5_telx_polygon-ETH-TEL_chunk_0.json",
    "safe_batch_tan_setup_record_only_plugin.json",
  ];

  it("selects every TAN batch file of the same period only", () => {
    expect(batchFilesToRemove(files, 5)).toEqual([
      "safe_batch_period_5_tan_0.json",
      "safe_batch_period_5_tan_3.json",
    ]);
  });
});

describe("safeBatchFromJson", () => {
  const [batch] = buildTanBatches(tanRewards, END_BLOCK);
  const safe = getAddress("0x8Dcf8d134F22aC625A7aFb39514695801CD705b5");
  const json = toSafeTxBuilderJson(batch, {
    name: "n",
    description: "d",
    safeAddress: safe,
  });

  it("round-trips a batch when chain and Safe match", () => {
    expect(
      safeBatchFromJson(JSON.parse(JSON.stringify(json)), {
        chainId: ChainId.Polygon,
        safeAddress: safe,
      }),
    ).toEqual(batch);
  });

  it("fails on a chain mismatch", () => {
    expect(() =>
      safeBatchFromJson({ ...json, chainId: "8453" }, {
        chainId: ChainId.Polygon,
        safeAddress: safe,
      }),
    ).toThrow(AccountingError);
  });

  it("fails on a Safe mismatch", () => {
    expect(() =>
      safeBatchFromJson(json, { chainId: ChainId.Polygon, safeAddress: A }),
    ).toThrow(AccountingError);
  });
});
