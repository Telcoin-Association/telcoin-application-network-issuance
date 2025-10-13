#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const STATE_VIEW_ABI = [
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
  "function getTickBitmap(bytes32 poolId, int16 wordPosition) view returns (uint256)",
  "function getTickInfo(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross,int128 liquidityNet,uint256 feeGrowthOutside0X128,uint256 feeGrowthOutside1X128)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getFeeGrowthGlobals(bytes32 poolId) view returns (uint256, uint256)"
];

const Q128 = 2n ** 128n;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) die(`Unexpected arg ${argv[i]}`);
    const key = argv[i].slice(2);
    const val = argv[i + 1];
    if (!val || val.startsWith("--")) die(`Missing value for --${key}`);
    out[key] = val;
    i += 1;
  }
  ["checkpoint","tokenId","poolId","stateView","tickSpacing","rpc"].forEach((k)=>{
    if (!(k in out)) die(`Missing --${k}`);
  });
  out.tickSpacing = Number(out.tickSpacing);
  out.tokenId = BigInt(out.tokenId);
  if ("startBlock" in out) out.startBlock = BigInt(out.startBlock);
  if ("endBlock" in out) out.endBlock = BigInt(out.endBlock);
  return out;
}

function parseBigInt(str) {
  if (typeof str === "bigint") return str;
  if (typeof str === "number") return BigInt(str);
  if (typeof str === "string") {
    const s = str.endsWith("n") ? str.slice(0, -1) : str;
    return BigInt(s);
  }
  die(`Cannot parse bigint from ${str}`);
}

function tickToWord(tick, spacing) {
  let compressed = Math.floor(tick / spacing);
  if (tick < 0 && tick % spacing !== 0) compressed -= 1;
  return compressed >> 8;
}

async function getTickBitmap(contract, poolId, word, blockTag) {
  return contract.getTickBitmap(poolId, word, { blockTag });
}

async function findInitializedTickUnder(contract, poolId, tick, spacing, blockTag, searchLimit = 2560) {
  const startWord = tickToWord(tick, spacing);
  let startCompressed = Math.floor(tick / spacing);
  if (tick < 0 && tick % spacing !== 0) startCompressed -= 1;
  const startBitPos = startCompressed & 255;
  for (let wordOffset = 0; wordOffset < searchLimit; wordOffset++) {
    const currentWord = startWord - wordOffset;
    const bitmap = await getTickBitmap(contract, poolId, currentWord, blockTag);
    if (bitmap === 0n) continue;
    const startBit = wordOffset === 0 ? startBitPos : 255;
    for (let bit = startBit; bit >= 0; bit--) {
      if ((bitmap & (1n << BigInt(bit))) !== 0n) {
        return (currentWord * 256 + bit) * spacing;
      }
    }
  }
  return null;
}

async function findInitializedTickAbove(contract, poolId, tick, spacing, blockTag, searchLimit = 2560) {
  const startWord = tickToWord(tick, spacing);
  let startCompressed = Math.floor(tick / spacing);
  if (tick < 0 && tick % spacing !== 0) startCompressed -= 1;
  const startBitPos = startCompressed & 255;
  for (let wordOffset = 0; wordOffset < searchLimit; wordOffset++) {
    const currentWord = startWord + wordOffset;
    const bitmap = await getTickBitmap(contract, poolId, currentWord, blockTag);
    if (bitmap === 0n) continue;
    const startBit = wordOffset === 0 ? startBitPos : 0;
    for (let bit = startBit; bit < 256; bit++) {
      if ((bitmap & (1n << BigInt(bit))) !== 0n) {
        return (currentWord * 256 + bit) * spacing;
      }
    }
  }
  return null;
}

function feeDelta(start, end) {
  const MOD = 2n ** 256n;
  return (end - start + MOD) % MOD;
}

function computeFees(liquidity, delta) {
  return (liquidity * delta) / Q128;
}

async function main() {
  const args = parseArgs();
  const checkpointPath = path.resolve(args.checkpoint);
  const json = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  const entry = json.positions.find(([id]) => parseBigInt(id) === args.tokenId);
  if (!entry) die(`Token ${args.tokenId} not found`);
  const [, state] = entry;
  const liquidity = parseBigInt(state.liquidity);
  if (liquidity === 0n) die("Token has zero liquidity");

  const blockRange = json.blockRange || {};
  const startBlock = args.startBlock ?? parseBigInt(blockRange.startBlock);
  const endBlock = args.endBlock ?? parseBigInt(blockRange.endBlock);

  const provider = new ethers.JsonRpcProvider(args.rpc);
  const contract = new ethers.Contract(args.stateView, STATE_VIEW_ABI, provider);
  const poolId = args.poolId;

  const tickLower = state.tickLower;
  const tickUpper = state.tickUpper;

  const [slot0, feeGlobals] = await Promise.all([
    contract.getSlot0(poolId, { blockTag: endBlock }),
    contract.getFeeGrowthGlobals(poolId, { blockTag: endBlock }),
  ]);
  const currentTick = slot0[1];

  const [startOrig, endOrig] = await Promise.all([
    contract.getFeeGrowthInside(poolId, tickLower, tickUpper, { blockTag: startBlock }),
    contract.getFeeGrowthInside(poolId, tickLower, tickUpper, { blockTag: endBlock }),
  ]);

  const safeLower = await findInitializedTickUnder(contract, poolId, tickLower, args.tickSpacing, endBlock);
  const safeUpper = await findInitializedTickAbove(contract, poolId, tickUpper, args.tickSpacing, endBlock);

  const [startSafe, endSafe] = await Promise.all([
    contract.getFeeGrowthInside(poolId, safeLower ?? tickLower, safeUpper ?? tickUpper, { blockTag: startBlock }),
    contract.getFeeGrowthInside(poolId, safeLower ?? tickLower, safeUpper ?? tickUpper, { blockTag: endBlock }),
  ]);

  const deltaOrig0 = feeDelta(BigInt(startOrig[0]), BigInt(endOrig[0]));
  const deltaOrig1 = feeDelta(BigInt(startOrig[1]), BigInt(endOrig[1]));
  const deltaSafe0 = feeDelta(BigInt(startSafe[0]), BigInt(endSafe[0]));
  const deltaSafe1 = feeDelta(BigInt(startSafe[1]), BigInt(endSafe[1]));

  console.log("=== Input Summary ===");
  console.log(`Checkpoint : ${checkpointPath}`);
  console.log(`Token ID   : ${args.tokenId}`);
  console.log(`Tick range : [${tickLower}, ${tickUpper}]`);
  console.log(`Safe range : [${safeLower}, ${safeUpper}]`);
  console.log(`Liquidity  : ${liquidity}`);
  console.log(`Blocks     : ${startBlock} -> ${endBlock}`);
  console.log("");

  console.log("=== Fee Growth Deltas ===");
  console.log(`Original Δ0: ${deltaOrig0}`);
  console.log(`Original Δ1: ${deltaOrig1}`);
  console.log(`Safe Δ0    : ${deltaSafe0}`);
  console.log(`Safe Δ1    : ${deltaSafe1}`);
  console.log("");

  console.log("=== Implied Fees (liquidity * Δ / Q128) ===");
  console.log(`Original token0: ${computeFees(liquidity, deltaOrig0)}`);
  console.log(`Original token1: ${computeFees(liquidity, deltaOrig1)}`);
  console.log(`Safe token0    : ${computeFees(liquidity, deltaSafe0)}`);
  console.log(`Safe token1    : ${computeFees(liquidity, deltaSafe1)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
