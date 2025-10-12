# Fee-Growth Clamp PoC

This document records the exact commands and outputs we used to reproduce the
fee-growth divergence identified in `TELxRewardsCalculator`.
## Why This Matters

The TELx calculator derives fee growth by calling `getFeeGrowthInsideOffchain()` (see `backend/calculators/TELxRewardsCalculator.ts`). That helper clamps both tick bounds by repeatedly calling `findInitializedTickUnder`, but it only searches *downward*. When a position’s upper tick sits above the current price, both "safe" ticks collapse to the same value. `StateView.getFeeGrowthInside` then returns zero – yet the downstream code keeps multiplying the wallet’s original liquidity by that zero-range result and still credits the position with the surrounding pool’s entire fee growth. This shows up in the checkpoint JSON as tens of WETH even though on-chain growth for the original tick span is only a few hundredths.

The PoC below captures those cases and lets you compare the original tick range to the clamped one. If the clamped ticks diverge, the helper reveals the precise delta and reproduces the over-allocation described above.


## Summary

- Two positions with active liquidity – one on Base period 8, one on Polygon
  period 8 – show that the downward-only tick clamping collapses both bounds to
  the same tick, making StateView return zero fee growth while the checkpoint
  still credits those wallets with large WETH payouts.
- The helper script in `poc/scripts/compareFeeGrowth.js` mirrors the current
  implementation and prints the original tick deltas versus the clamped ones so
  the discrepancy is visible in a single command.

## Prerequisites

```bash
cd telcoin-application-network-issuance
npm install ethers@6
```

Use any Base / Polygon RPC provider you trust (Alchemy, Infura, self-hosted, etc.). Both helpers iterate every position in the checkpoint and call StateView twice per entry (once with original ticks, once with clamped ticks), so expect the number of RPC calls to match the number of tokens in the JSON.

## Base Proof (Period 8)

- Checkpoint: `backend/checkpoints/base-ETH-TEL-8.json`
- Token ID: `353422`
- Owner: `0x2fe6f7c52EccC8Fea03289EC10213033a7c364b7`
- Pool ID: `0xb6d004fca4f9a34197862176485c45ceab7117c86f07422d1fe3d9cfd6e9d1da`
- StateView: `0xa3c0c9b65bad0b08107aa264b0f3db444b867a71`
- Tick spacing: `60`

Command:

```bash
node poc/scripts/compareFeeGrowth.js \
  --checkpoint backend/checkpoints/base-ETH-TEL-8.json \
  --tokenId 353422 \
  --poolId 0xb6d004fca4f9a34197862176485c45ceab7117c86f07422d1fe3d9cfd6e9d1da \
  --stateView 0xa3c0c9b65bad0b08107aa264b0f3db444b867a71 \
  --tickSpacing 60 \
  --rpc https://base-mainnet.<provider>.com/v2/<key>
```

Key output:

```
Original ticks: [-230280, -229980]
Clamped  ticks: [-228180, -228180]
Original Δ0: 7566433889569998252881978430112194228237
Clamped  Δ0: 0
```

## Polygon Proof (Period 8)

- Checkpoint: `backend/checkpoints/polygon-ETH-TEL-8.json`
- Token ID: `47658`
- Owner: `0x2fe6f7c52EccC8Fea03289EC10213033a7c364b7`
- Pool ID: `0x9a005a0c12cc2ef01b34e9a7f3fb91a0e6304d377b5479bd3f08f8c29cdf5deb`
- StateView: `0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a`
- Tick spacing: `60`

Command:

```bash
node poc/scripts/compareFeeGrowth.js \
  --checkpoint backend/checkpoints/polygon-ETH-TEL-8.json \
  --tokenId 47658 \
  --poolId 0x9a005a0c12cc2ef01b34e9a7f3fb91a0e6304d377b5479bd3f08f8c29cdf5deb \
  --stateView 0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a \
  --tickSpacing 60 \
  --rpc https://polygon-mainnet.<provider>.com/v2/<key>
```

Key output:

```
Original ticks: [-230280, -230220]
Clamped  ticks: [-227700, -227700]
Original Δ0: 1882482896279730673203047009591254119281
Clamped  Δ0: 0
```

Both proofs show the same pattern: the original tick window reflects the actual
on-chain fee growth, while the clamped window collapses to a single tick and
forces `getFeeGrowthInside` to return zero even though the checkpoint contains
the wallet’s full allocation.

## Control Runs

Run the helper below to discover positions whose clamped tick bounds match the originals **and** those that collapse. It prints two CSV sections: one for controls and one for positions where the clamped ticks differ.

```bash
node poc/scripts/findControls.js \
  --checkpoint backend/checkpoints/base-ETH-TEL-8.json \
  --poolId 0xb6d004fca4f9a34197862176485c45ceab7117c86f07422d1fe3d9cfd6e9d1da \
  --stateView 0xa3c0c9b65bad0b08107aa264b0f3db444b867a71 \
  --tickSpacing 60 \
  --rpc https://base-mainnet.<provider>.com/v2/<key>
```

Run the same command against the Polygon checkpoint to produce Polygon controls:

```bash
node poc/scripts/findControls.js \
  --checkpoint backend/checkpoints/polygon-ETH-TEL-8.json \
  --poolId 0x9a005a0c12cc2ef01b34e9a7f3fb91a0e6304d377b5479bd3f08f8c29cdf5deb \
  --stateView 0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a \
  --tickSpacing 60 \
  --rpc https://polygon-mainnet.<provider>.com/v2/<key>
```

The script emits two CSV blocks. Rows in the *Controls* block keep their original tick spans and are safe to use as controls. Rows in the *Collapsing* block show the clamped lower/upper ticks so you can reproduce the malfunctioning behaviour directly with `compareFeeGrowth.js`.
