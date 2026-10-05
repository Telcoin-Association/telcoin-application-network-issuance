import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { Address } from "viem";
import { ChainId } from "./config";
import {
  batchFilesToRemove,
  SafeBatch,
  safeBatchFromJson,
  SafeTxBuilderJson,
} from "./newTelDistribution";

/// TAN batch file handling for safeTxArrayBuilder: rendering, stale cleanup, and write-then-verify

export type BatchFile = {
  filePath: string;
  json: SafeTxBuilderJson;
  chainId: ChainId;
  safeAddress: Address;
};

/// exact bytes written to disk; deterministic, so the sha256 is reproducible by anyone with the same inputs
export function render(file: BatchFile): string {
  return JSON.stringify(file.json, null, 2) + "\n";
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

/// parses rendered contents back into batches, rejecting a chain or Safe other than expected
export function reload(
  files: BatchFile[],
  contents: string[],
): { batches: SafeBatch[]; hashes: string[] } {
  return {
    batches: files.map((file, i) =>
      safeBatchFromJson(JSON.parse(contents[i]) as SafeTxBuilderJson, {
        chainId: file.chainId,
        safeAddress: file.safeAddress,
      }),
    ),
    hashes: contents.map(sha256),
  };
}

/// best effort, so a cleanup error never masks the failure that triggered it
async function removeFiles(files: BatchFile[]) {
  await Promise.allSettled(files.map(({ filePath }) => fs.rm(filePath, { force: true })));
}

/// deletes every earlier batch file of this period so stale chunks cannot be imported; returns the names removed
export async function removeStaleBatchFiles(dir: string, period: number): Promise<string[]> {
  const stale = batchFilesToRemove(await fs.readdir(dir), period);
  for (const name of stale) await fs.rm(path.join(dir, name), { force: true });
  return stale;
}

/**
 * Removes stale files of `period` (if given), writes `files`, reads them back and runs `verify` on what was read.
 * Any failure removes every file of this run, so a failed build leaves no batch files behind.
 */
export async function writeVerified(
  dir: string,
  files: BatchFile[],
  period: number | null,
  verify: (batches: SafeBatch[]) => void,
): Promise<string[]> {
  try {
    await fs.mkdir(dir, { recursive: true });
    if (period !== null) {
      for (const name of await removeStaleBatchFiles(dir, period))
        console.log(`Removed stale batch file ${name}`);
    }
    const contents: string[] = [];
    for (const file of files) {
      await fs.writeFile(file.filePath, render(file));
      contents.push(await fs.readFile(file.filePath, "utf-8"));
    }
    const { batches, hashes } = reload(files, contents);
    verify(batches);
    return hashes;
  } catch (err) {
    await removeFiles(files);
    throw err;
  }
}
