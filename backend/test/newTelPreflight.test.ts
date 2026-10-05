import { describe, it, expect } from "@jest/globals";
import { Address, getAddress } from "viem";
import {
  NEW_TEL,
  OLD_TEL,
  RewardEntry,
  STAKING_MODULE,
  TAN_ISSUANCE_HISTORY,
  TAN_SAFE,
  toNewTel,
} from "../newTelDistribution";
import {
  ContractReader,
  ISIMPLE_PLUGIN_INTERFACE_ID,
  PreflightError,
  preflightStubSetup,
  preflightTan,
} from "../newTelPreflight";

const STUB = getAddress("0x00000000000000000000000000000000000057b0");
const ORIGINAL_PLUGIN = getAddress("0xCAa823Fd48bec0134c8285Fd3C34F9D95CF3280f");
const A = getAddress("0x00000000000000000000000000000000000000a1");
const B = getAddress("0x00000000000000000000000000000000000000b2");
const C = getAddress("0x00000000000000000000000000000000000000c3");
const START_BLOCK = 900n;
const END_BLOCK = 1_000n; // 100-block period
const PINNED_BLOCK = 1_234n; // block every preflight read must be pinned to

// two chunks as the builder would cut them
const CHUNKS: RewardEntry[][] = [
  [
    { address: A, amount: 100n },
    { address: B, amount: 50n },
  ],
  [{ address: C, amount: 25n }],
];
const TOTAL_NEW = toNewTel(175n);

type StakeEvent = { account: Address; oldStake: bigint; newStake: bigint; blockNumber: bigint };

type ChainState = {
  plugin: Address;
  lastSettlementBlock: bigint;
  stubTel: Address;
  stubIncreaser: Address;
  stubTotalClaimable: bigint;
  stubSupportsSimplePlugin: boolean;
  newTelDecimals: number;
  newTelBalances: Record<Address, bigint>;
  historyOldTel: bigint;
  cumulativeBefore: Record<Address, bigint>; // cumulative rewards at endBlock - 1
  recordedAtEnd: Record<Address, bigint>; // amount recorded at endBlock (this period)
  stakeAtEnd: Record<Address, bigint>; // stakedByAt(endBlock - 1), the calculator's no-event fallback
  stakeEvents: StakeEvent[];
  revert: Set<string>; // `${address}:${functionName}` that revert
  /// what an unpinned ("latest") read sees, e.g. a lagging load-balanced node; unpinned reads throw when unset
  unpinned?: Partial<ChainState>;
};

function healthyState(overrides: Partial<ChainState> = {}): ChainState {
  return {
    plugin: STUB,
    lastSettlementBlock: START_BLOCK - 1n,
    stubTel: OLD_TEL.address,
    stubIncreaser: TAN_ISSUANCE_HISTORY,
    stubTotalClaimable: 0n,
    stubSupportsSimplePlugin: true,
    newTelDecimals: 18,
    newTelBalances: { [TAN_SAFE]: TOTAL_NEW },
    historyOldTel: 0n,
    cumulativeBefore: {},
    // no StakeChanged events, so caps come from stakedByAt(endBlock - 1); B is exactly at its cap
    stakeAtEnd: { [A]: 1_000n, [B]: 50n, [C]: 100n },
    recordedAtEnd: {},
    stakeEvents: [],
    revert: new Set(),
    ...overrides,
  };
}

function fakeReader(pinnedState: ChainState): ContractReader {
  return {
    async readContract({ address, functionName, args, blockNumber }) {
      let state = pinnedState;
      if (blockNumber === undefined) {
        if (!pinnedState.unpinned) throw new Error(`unpinned read of ${functionName}`);
        state = { ...pinnedState, ...pinnedState.unpinned };
      } else if (blockNumber !== PINNED_BLOCK) {
        throw new Error(`read of ${functionName} pinned to ${blockNumber}, expected ${PINNED_BLOCK}`);
      }
      const key = `${getAddress(address)}:${functionName}`;
      if (state.revert.has(key)) throw new Error(`execution reverted: ${key}`);

      switch (key) {
        case `${TAN_ISSUANCE_HISTORY}:tanIssuancePlugin`:
          return state.plugin;
        case `${TAN_ISSUANCE_HISTORY}:lastSettlementBlock`:
          return state.lastSettlementBlock;
        case `${TAN_ISSUANCE_HISTORY}:cumulativeRewardsAtBlock`: {
          const [account, block] = args as [Address, bigint];
          const before = state.cumulativeBefore[getAddress(account)] ?? 0n;
          const recorded = state.recordedAtEnd[getAddress(account)] ?? 0n;
          if (block === END_BLOCK) return before + recorded;
          if (block === END_BLOCK - 1n) return before;
          throw new Error(`cumulativeRewardsAtBlock queried at unexpected block ${block}`);
        }
        case `${STAKING_MODULE}:stakedByAt`: {
          const [account, block] = args as [Address, bigint];
          if (block !== END_BLOCK - 1n) throw new Error(`stakedByAt queried at unexpected block ${block}`);
          return state.stakeAtEnd[getAddress(account)] ?? 0n;
        }
        case `${STUB}:tel`:
          return state.stubTel;
        case `${STUB}:increaser`:
          return state.stubIncreaser;
        case `${STUB}:totalClaimable`:
          return state.stubTotalClaimable;
        case `${STUB}:supportsInterface`:
          return (
            args![0] === ISIMPLE_PLUGIN_INTERFACE_ID &&
            state.stubSupportsSimplePlugin
          );
        case `${NEW_TEL.address}:decimals`:
          return state.newTelDecimals;
        case `${NEW_TEL.address}:balanceOf`:
          return state.newTelBalances[getAddress(args![0] as Address)] ?? 0n;
        case `${OLD_TEL.address}:balanceOf`:
          return getAddress(args![0] as Address) === TAN_ISSUANCE_HISTORY
            ? state.historyOldTel
            : 0n;
      }
      throw new Error(`execution reverted: unmocked ${key}`);
    },
    async getLogs({ address, args, fromBlock, toBlock }) {
      expect(getAddress(address)).toBe(STAKING_MODULE);
      expect([fromBlock, toBlock]).toEqual([START_BLOCK, END_BLOCK]);
      const accounts = new Set((args?.account ?? []).map((a) => getAddress(a)));
      return pinnedState.stakeEvents
        .filter((e) => accounts.has(e.account))
        .map(({ blockNumber, ...eventArgs }) => ({ args: eventArgs, blockNumber }));
    },
  };
}

const params = {
  startBlock: START_BLOCK,
  endBlock: END_BLOCK,
  chunks: CHUNKS,
  recordOnlyPlugin: STUB as Address | null,
  atBlock: PINNED_BLOCK,
};

async function failuresOf(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(PreflightError);
    return (err as PreflightError).failures;
  }
  throw new Error("expected preflight to fail");
}

describe("ISIMPLE_PLUGIN_INTERFACE_ID", () => {
  it("matches the Solidity type(ISimplePlugin).interfaceId", () => {
    // XOR of increaseClaimableBy(address,uint256), tel(), totalClaimable(), deactivated()
    expect(ISIMPLE_PLUGIN_INTERFACE_ID).toBe("0xdc8646c1");
  });
});

describe("preflightTan: wiring and funding", () => {
  it("passes on a fresh period and marks every chunk pending", async () => {
    const result = await preflightTan(fakeReader(healthyState()), params);
    expect(result.pendingChunks).toEqual([0, 1]);
    expect(result.passed.length).toBeGreaterThanOrEqual(8);
  });

  it("fails when the record-only plugin is not configured", async () => {
    const failures = await failuresOf(
      preflightTan(fakeReader(healthyState()), { ...params, recordOnlyPlugin: null }),
    );
    expect(failures.join()).toMatch(/RECORD_ONLY_PLUGIN/);
  });

  it("fails when the history still points at the original plugin", async () => {
    const failures = await failuresOf(
      preflightTan(fakeReader(healthyState({ plugin: ORIGINAL_PLUGIN })), params),
    );
    expect(failures.join()).toMatch(/tanIssuancePlugin/);
  });

  it("fails when the stub reports the wrong token or increaser", async () => {
    const failures = await failuresOf(
      preflightTan(
        fakeReader(healthyState({ stubTel: NEW_TEL.address, stubIncreaser: TAN_SAFE })),
        params,
      ),
    );
    expect(failures).toHaveLength(2);
  });

  it("fails when the history holds old TEL (the original plugin could pull it after a rollback)", async () => {
    const failures = await failuresOf(
      preflightTan(fakeReader(healthyState({ historyOldTel: 1n })), params),
    );
    expect(failures.join()).toMatch(/old TEL/);
  });

  it("fails when new TEL does not report 18 decimals", async () => {
    const failures = await failuresOf(
      preflightTan(fakeReader(healthyState({ newTelDecimals: 2 })), params),
    );
    expect(failures.join()).toMatch(/decimals/);
  });

  it("fails when the TAN Safe holds less new TEL than the pending total, passes at exactly the total", async () => {
    const failures = await failuresOf(
      preflightTan(
        fakeReader(healthyState({ newTelBalances: { [TAN_SAFE]: TOTAL_NEW - 1n } })),
        params,
      ),
    );
    expect(failures.join()).toMatch(/balance/);

    await expect(
      preflightTan(fakeReader(healthyState({ newTelBalances: { [TAN_SAFE]: TOTAL_NEW } })), params),
    ).resolves.toBeDefined();
  });

  it("reports every failure, not just the first", async () => {
    const failures = await failuresOf(
      preflightTan(
        fakeReader(healthyState({ historyOldTel: 1n, newTelBalances: {} })),
        params,
      ),
    );
    expect(failures).toHaveLength(2);
  });

  it("reports a reverting read as a failure", async () => {
    const failures = await failuresOf(
      preflightTan(fakeReader(healthyState({ revert: new Set([`${STUB}:tel`]) })), params),
    );
    expect(failures.join()).toMatch(/tel\(\)/);
  });
});

describe("preflightTan: settlement order", () => {
  it.each([
    ["a gap", START_BLOCK - 2n],
    ["an overlap", START_BLOCK],
  ])("fails when the rewards file leaves %s after the last settlement", async (_, lastSettlementBlock) => {
    const failures = await failuresOf(
      preflightTan(fakeReader(healthyState({ lastSettlementBlock })), params),
    );
    expect(failures.join()).toMatch(/startBlock/);
  });

  it("fails when a later period has already been settled", async () => {
    const failures = await failuresOf(
      preflightTan(fakeReader(healthyState({ lastSettlementBlock: END_BLOCK + 1n })), params),
    );
    expect(failures.join()).toMatch(/later period/);
  });
});

describe("preflightTan: partially settled period", () => {
  const settledAtEnd = (recordedAtEnd: Record<Address, bigint>, extra: Partial<ChainState> = {}) =>
    healthyState({ lastSettlementBlock: END_BLOCK, recordedAtEnd, ...extra });

  it("returns only the chunks not yet recorded and funds only those", async () => {
    const result = await preflightTan(
      fakeReader(
        settledAtEnd({ [A]: 100n, [B]: 50n }, { newTelBalances: { [TAN_SAFE]: toNewTel(25n) } }),
      ),
      params,
    );
    expect(result.pendingChunks).toEqual([1]);
  });

  it("returns no pending chunks when the whole period is recorded", async () => {
    const result = await preflightTan(
      fakeReader(settledAtEnd({ [A]: 100n, [B]: 50n, [C]: 25n }, { newTelBalances: {} })),
      params,
    );
    expect(result.pendingChunks).toEqual([]);
  });

  it("fails when a chunk was recorded twice", async () => {
    const failures = await failuresOf(
      preflightTan(fakeReader(settledAtEnd({ [A]: 200n, [B]: 100n })), params),
    );
    expect(failures.join()).toMatch(/chunk 0/);
  });

  it("fails when a chunk is only partly recorded (rewards file changed since execution)", async () => {
    const failures = await failuresOf(
      preflightTan(fakeReader(settledAtEnd({ [A]: 100n })), params),
    );
    expect(failures.join()).toMatch(/chunk 0/);
  });
});

describe("preflightTan: stake cap matches the calculator", () => {
  it("fails when reward plus prior cumulative rewards exceeds the rewardee's stake", async () => {
    const failures = await failuresOf(
      preflightTan(fakeReader(healthyState({ cumulativeBefore: { [B]: 1n } })), params),
    );
    expect(failures.join()).toMatch(/stake/);
    expect(failures.join()).toContain(B);
  });

  it("fails for an unstaked rewardee", async () => {
    const failures = await failuresOf(
      preflightTan(fakeReader(healthyState({ stakeAtEnd: { [A]: 1_000n, [B]: 50n } })), params),
    );
    expect(failures.join()).toContain(C);
  });

  it("refuses a stake made in the period's last block (zero weight in the calculator's average)", async () => {
    const state = healthyState({
      stakeAtEnd: { [A]: 1_000n, [B]: 0n, [C]: 100n },
      stakeEvents: [{ account: B, oldStake: 0n, newStake: 1_000n, blockNumber: END_BLOCK }],
    });
    const failures = await failuresOf(preflightTan(fakeReader(state), params));
    expect(failures.join()).toContain(B);
  });

  it("refuses a brief stake mid-period: 1000 for 1 of 100 blocks averages 10", async () => {
    const state = healthyState({
      stakeAtEnd: { [A]: 1_000n, [B]: 0n, [C]: 100n },
      stakeEvents: [
        { account: B, oldStake: 0n, newStake: 1_000n, blockNumber: START_BLOCK + 10n },
        { account: B, oldStake: 1_000n, newStake: 0n, blockNumber: START_BLOCK + 11n },
      ],
    });
    const failures = await failuresOf(preflightTan(fakeReader(state), params));
    expect(failures.join()).toContain(`${B} (reward 50 + prior 0 > stake 10)`);
  });

  it("uses the exact time-weighted average: 100 for half the period passes a reward of 50 and refuses 51", async () => {
    const halfStaked = (overrides: Partial<ChainState> = {}) =>
      healthyState({
        stakeAtEnd: { [A]: 1_000n, [B]: 0n, [C]: 100n },
        stakeEvents: [{ account: B, oldStake: 100n, newStake: 0n, blockNumber: START_BLOCK + 50n }],
        ...overrides,
      });
    await expect(preflightTan(fakeReader(halfStaked()), params)).resolves.toBeDefined();

    const over: RewardEntry[][] = [[CHUNKS[0][0], { address: B, amount: 51n }], CHUNKS[1]];
    const failures = await failuresOf(
      preflightTan(fakeReader(halfStaked({ newTelBalances: { [TAN_SAFE]: toNewTel(176n) } })), {
        ...params,
        chunks: over,
      }),
    );
    expect(failures.join()).toContain(`${B} (reward 51 + prior 0 > stake 50)`);
  });
});

describe("preflightTan: reads pinned to one block", () => {
  it("rejects nothing on a consistent pinned view, and every read carries the pinned block", async () => {
    // the fake throws on any unpinned read or any read pinned to another block
    await expect(preflightTan(fakeReader(healthyState()), params)).resolves.toBeDefined();
  });

  it("is not fooled by a lagging node: a stale latest lastSettlementBlock must not re-mark executed chunks pending", async () => {
    // chunk 0 executed at endBlock; a lagging node still reports the previous settlement for unpinned reads
    const state = healthyState({
      lastSettlementBlock: END_BLOCK,
      recordedAtEnd: { [A]: 100n, [B]: 50n },
      newTelBalances: { [TAN_SAFE]: toNewTel(25n) },
      unpinned: { lastSettlementBlock: START_BLOCK - 1n },
    });
    const result = await preflightTan(fakeReader(state), params);
    expect(result.pendingChunks).toEqual([1]);
  });

  it("refuses a fresh period when amounts are already recorded at endBlock (inconsistent view)", async () => {
    const failures = await failuresOf(
      preflightTan(fakeReader(healthyState({ recordedAtEnd: { [A]: 100n, [B]: 50n } })), params),
    );
    expect(failures.join()).toMatch(/chunk 0/);
  });

  it("refuses when the pinned block is before the period's endBlock", async () => {
    const failures = await failuresOf(
      preflightTan(fakeReader(healthyState()), { ...params, atBlock: END_BLOCK - 1n }),
    );
    expect(failures.join()).toMatch(/endBlock/);
  });
});

describe("preflightStubSetup", () => {
  const preSetup = (overrides: Partial<ChainState> = {}) =>
    healthyState({ plugin: ORIGINAL_PLUGIN, ...overrides });

  it("passes for a correctly wired stub before the switch", async () => {
    await expect(preflightStubSetup(fakeReader(preSetup()), STUB, PINNED_BLOCK)).resolves.toBeDefined();
  });

  it.each([
    ["wrong token", { stubTel: NEW_TEL.address }],
    ["wrong increaser", { stubIncreaser: TAN_SAFE }],
    ["non-zero totalClaimable", { stubTotalClaimable: 1n }],
    ["no ISimplePlugin support", { stubSupportsSimplePlugin: false }],
    ["already set", { plugin: STUB }],
  ])("fails on %s", async (_, overrides) => {
    const failures = await failuresOf(
      preflightStubSetup(fakeReader(preSetup(overrides as Partial<ChainState>)), STUB, PINNED_BLOCK),
    );
    expect(failures).toHaveLength(1);
  });

  it("fails when the address is not a contract", async () => {
    const failures = await failuresOf(
      preflightStubSetup(
        fakeReader(
          preSetup({
            revert: new Set(
              ["tel", "increaser", "totalClaimable", "supportsInterface"].map(
                (fn) => `${STUB}:${fn}`,
              ),
            ),
          }),
        ),
        STUB,
        PINNED_BLOCK,
      ),
    );
    expect(failures).toHaveLength(4);
  });
});
