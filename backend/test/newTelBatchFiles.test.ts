import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { getAddress } from "viem";
import { ChainId } from "../config";
import {
  BatchFile,
  removeStaleBatchFiles,
  render,
  reload,
  writeVerified,
} from "../newTelBatchFiles";
import {
  AccountingError,
  buildTanBatches,
  TAN_SAFE,
  toSafeTxBuilderJson,
} from "../newTelDistribution";

const A = getAddress("0x00000000000000000000000000000000000000a1");
const B = getAddress("0x00000000000000000000000000000000000000b2");
const END_BLOCK = 1_000n;
const batches = buildTanBatches(
  [
    { address: A, amount: 1n },
    { address: B, amount: 2n },
  ],
  END_BLOCK,
  1,
);

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tan-batches-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function batchFile(i: number, filePath = path.join(dir, `safe_batch_period_7_tan_${i}.json`)): BatchFile {
  return {
    filePath,
    chainId: ChainId.Polygon,
    safeAddress: TAN_SAFE,
    json: toSafeTxBuilderJson(batches[i], { name: `n${i}`, description: "d", safeAddress: TAN_SAFE }),
  };
}

async function listDir() {
  return (await fs.readdir(dir)).sort();
}

describe("reload", () => {
  it("returns the original batches and the sha256 of the exact bytes", () => {
    const files = [batchFile(0), batchFile(1)];
    const contents = files.map(render);
    const reloaded = reload(files, contents);
    expect(reloaded.batches).toEqual(batches);
    expect(reloaded.hashes).toEqual(
      contents.map((c) => createHash("sha256").update(c).digest("hex")),
    );
  });

  it("rejects a file whose Safe differs from the expected one", () => {
    const file = { ...batchFile(0), safeAddress: A };
    expect(() => reload([file], [render(batchFile(0))])).toThrow(AccountingError);
  });
});

describe("removeStaleBatchFiles", () => {
  it("removes every batch file of the period and nothing else", async () => {
    for (const name of [
      "safe_batch_period_7_tan_0.json",
      "safe_batch_period_7_tan_4.json",
      "safe_batch_period_70_tan_0.json",
      "safe_param_period_7_telx_base-ETH-TEL_chunk_0.json",
    ])
      await fs.writeFile(path.join(dir, name), "{}");

    const removed = await removeStaleBatchFiles(dir, 7);

    expect(removed.sort()).toEqual(["safe_batch_period_7_tan_0.json", "safe_batch_period_7_tan_4.json"]);
    expect(await listDir()).toEqual([
      "safe_batch_period_70_tan_0.json",
      "safe_param_period_7_telx_base-ETH-TEL_chunk_0.json",
    ]);
  });
});

describe("writeVerified", () => {
  it("writes the files, verifies what was read back, and returns their sha256s", async () => {
    const files = [batchFile(0), batchFile(1)];
    let verified: unknown;
    const hashes = await writeVerified(dir, files, 7, (reloaded) => {
      verified = reloaded;
    });

    expect(verified).toEqual(batches);
    expect(await listDir()).toEqual(["safe_batch_period_7_tan_0.json", "safe_batch_period_7_tan_1.json"]);
    expect(hashes).toEqual(reload(files, files.map(render)).hashes);
  });

  it("replaces stale chunks of the same period", async () => {
    await fs.writeFile(path.join(dir, "safe_batch_period_7_tan_9.json"), "{}");
    await writeVerified(dir, [batchFile(0)], 7, () => {});
    expect(await listDir()).toEqual(["safe_batch_period_7_tan_0.json"]);
  });

  it("leaves no files behind when verification fails", async () => {
    const failure = new AccountingError("mismatch");
    await expect(
      writeVerified(dir, [batchFile(0), batchFile(1)], 7, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await listDir()).toEqual([]);
  });

  it("removes already-written files when a later write fails, and rethrows the write error", async () => {
    const unwritable = batchFile(1, path.join(dir, "missing-subdir", "safe_batch_period_7_tan_1.json"));
    await expect(writeVerified(dir, [batchFile(0), unwritable], 7, () => {})).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await listDir()).toEqual([]);
  });
});
