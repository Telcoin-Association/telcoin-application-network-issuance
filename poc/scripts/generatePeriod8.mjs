#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const checkpoint = path.resolve(repoRoot, "backend/checkpoints/polygon-ETH-TEL-8.json");
const outputJson = path.resolve(repoRoot, "staker_incentives.json");
const outputXlsx = path.resolve(repoRoot, "staker_incentives.xlsx");
const legacyJson = path.resolve(repoRoot, "staker_incentives.period8.json");
const legacyXlsx = path.resolve(repoRoot, "staker_incentives.period8.xlsx");

const startBlock = BigInt("75697435");
const endBlock = BigInt("75981194");

console.log(`Rebuilding period 8 using block range ${startBlock}:${endBlock}`);

const args = ["dist/app.js", `polygon=${startBlock}:${endBlock}`];
const env = { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" };

const child = spawn("node", args, {
  cwd: repoRoot,
  env,
  stdio: "inherit",
});

child.on("close", async (code) => {
  if (code !== 0) {
    console.error(`dist/app.js exited with code ${code}`);
    process.exit(code);
  }

  // copy the outputs to period8-* files so we don't overwrite new runs later
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const periodJson = path.resolve(repoRoot, `staker_incentives.period8.${timestamp}.json`);
  const periodXlsx = path.resolve(repoRoot, `staker_incentives.period8.${timestamp}.xlsx`);

  try {
    await fs.copyFile(outputJson, periodJson);
    await fs.copyFile(outputXlsx, periodXlsx);
    console.log(`Copied outputs to:\n  ${periodJson}\n  ${periodXlsx}`);
  } catch (err) {
    console.error("Failed to copy outputs", err);
    process.exit(1);
  }

  process.exit(0);
});
