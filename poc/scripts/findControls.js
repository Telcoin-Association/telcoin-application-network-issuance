#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const STATE_VIEW_ABI = [
  "function getTickBitmap(bytes32 poolId, int16 wordPosition) view returns (uint256)",
];

function die(msg){
  console.error(msg);
  process.exit(1);
}

function compressTick(tick, spacing) {
  let q = Math.trunc(tick / spacing);
  const r = tick % spacing;
  if (r !== 0 && r < 0) q -= 1;
  return q;
}

function tickToWord(compressedTick) {
  return Math.trunc(compressedTick / 256);
}

async function findInitializedTickUnder(contract, poolId, startTick, spacing, blockTag, searchLimit = 2560) {
  let compressed = compressTick(startTick, spacing);
  let word = tickToWord(compressed);
  for (let wordOffset = 0; wordOffset < searchLimit; wordOffset++, word--) {
    const bitmap = await contract.getTickBitmap(poolId, word, { blockTag });
    if (bitmap === 0n) continue;
    const startBit = wordOffset === 0 ? (compressed & 255) : 255;
    for (let bit = startBit; bit >= 0; bit--) {
      if ((bitmap & (1n << BigInt(bit))) !== 0n) {
        const compressedResult = BigInt(word) * 256n + BigInt(bit);
        return Number(compressedResult) * spacing;
      }
    }
  }
  return null;
}

async function main(){
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), null]);
    else acc[acc.length - 1][1] = cur;
    return acc;
  }, []).map(([k, v]) => [k, v]));

  const required = ["checkpoint","poolId","stateView","tickSpacing","rpc"];
  for (const key of required) {
    if (!(key in args)) die(`Missing --${key}`);
  }

  const tickSpacing = Number(args.tickSpacing);
  const checkpointPath = path.resolve(args.checkpoint);
  const json = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  const startBlockStr = json.blockRange && json.blockRange.startBlock;
  if (!startBlockStr) die("Checkpoint missing blockRange startBlock");
  const startBlock = BigInt(startBlockStr.endsWith("n") ? startBlockStr.slice(0, -1) : startBlockStr);

  const provider = new ethers.JsonRpcProvider(args.rpc);
  const contract = new ethers.Contract(args.stateView, STATE_VIEW_ABI, provider);
  const poolIdBytes = args.poolId;

  const controls = [];
  const collapsing = [];
  for (const [tokenId, state] of json.positions) {
    const liq = state.liquidity;
    if (!liq || liq === "0n") continue;
    const lower = state.tickLower;
    const upper = state.tickUpper;
    const clampedLower = await findInitializedTickUnder(contract, poolIdBytes, lower, tickSpacing, startBlock);
    const clampedUpper = await findInitializedTickUnder(contract, poolIdBytes, upper, tickSpacing, startBlock);
    if (clampedLower === lower && clampedUpper === upper) {
      controls.push({ tokenId, owner: state.lastOwner, lower, upper, liquidity: liq });
    } else {
      collapsing.push({
        tokenId,
        owner: state.lastOwner,
        lower,
        upper,
        clampedLower,
        clampedUpper,
        liquidity: liq,
      });
    }
  }

  console.log("Controls (tick bounds unchanged)");
  console.log("TokenId,Owner,TickLower,TickUpper,Liquidity");
  if (controls.length === 0) {
    console.log("<none>");
  } else {
    for (const row of controls) {
      console.log(`${row.tokenId},${row.owner},${row.lower},${row.upper},${row.liquidity}`);
    }
  }
  console.log("");

  console.log("Collapsing (clamped bounds differ)");
  console.log("TokenId,Owner,TickLower,TickUpper,ClampedLower,ClampedUpper,Liquidity");
  if (collapsing.length === 0) {
    console.log("<none>");
  } else {
    for (const row of collapsing) {
      console.log(
        `${row.tokenId},${row.owner},${row.lower},${row.upper},${row.clampedLower},${row.clampedUpper},${row.liquidity}`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
