import { describe, it, expect } from "@jest/globals";
import { readFile } from "fs/promises";

function parseBigIntJson(text: string) {
  return JSON.parse(text, (_, v) =>
    typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  );
}

function stripVwapResult<T extends Record<string, unknown>>(obj: T) {
  const { vwapResult, ...rest } = obj as T & { vwapResult?: unknown };
  return rest;
}

describe("checkpoint rerun equivalence", () => {
  it("polygon ETH-TEL period 34 matches old checkpoint apart from vwapResult", async () => {
    const oldCheckpoint = parseBigIntJson(
      await readFile("backend/checkpoints/polygon-ETH-TEL-34.json", "utf-8"),
    );
    const rerunCheckpoint = parseBigIntJson(
      await readFile(
        "backend/checkpoints/polygon-ETH-TEL-34.rerun.json",
        "utf-8",
      ),
    );

    expect(stripVwapResult(rerunCheckpoint)).toEqual(
      stripVwapResult(oldCheckpoint),
    );
  });
});
