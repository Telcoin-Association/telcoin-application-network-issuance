# TAN issuance: Tel V3 cutover runbook

This is the order the code requires to move TAN issuance on Polygon from the V2 `TANIssuanceHistory`
to the V3 one. Every step fails closed if it is attempted early, but several of them are only
recoverable by redeploying, so we follow the order rather than relying on the checks.

## Address books

| File | Holds | Read by |
|---|---|---|
| `deployments/deployments.json` | The predecessor V2 contracts. **Frozen.** | `backend/buildBackfill.ts`, the legacy fork test |
| `deployments/polygon.json` | The V3 stack: TelcoinV3, the V3 `StakingModule`, `SimplePlugin_TAN`, the TAN Safe, the plugin owner Safe, and the V3 history once deployed | The deploy script, `TANIssuanceSafeOps`, the backend |

Two different Safes are involved on Polygon. The **TAN Safe** owns `TANIssuanceHistory` and proposes
every backfill, seal, and settlement. The **plugin owner Safe** owns `SimplePlugin_TAN` and is the only
one that can call `setIncreaser`. `TANIssuanceSafeOps` checks which one `DEPLOYER_SAFE_ADDRESS` points at
for each entrypoint.

Scripts touching the V3 contracts run under `FOUNDRY_PROFILE=cancun`, since the deployed V3 bytecode
uses Cancun opcodes.

## Sequence

1. **Settle every remaining V2 period from `master`** before the V3 branch merges. On the V3 branch a
   Polygon run refuses to start until the V3 history exists and its backfill is sealed, so V2 periods
   cannot be run from it.

2. **Freeze the predecessor.** Remove the V2 history as `increaser` on the V2 plugin, so no further
   settlement can change the values the backfill reads. The builder warns while it is still the
   increaser.

3. **Build the backfill.**
   ```
   yarn ts-node backend/buildBackfill.ts
   ```
   The cutover block is the predecessor's own `lastSettlementBlock`, read onchain. Every seed is keyed
   there, and the first V3 period starts one block later, so no fee volume falls between the two
   systems. The builder reconciles three sources (period files, onchain credit logs, the predecessor's
   getter) and writes the chunks plus `backend/temp/safe_param_backfill_manifest.json`.

4. **Deploy the V3 history** against `SimplePlugin_TAN`, owned by the TAN Safe.
   ```
   FOUNDRY_PROFILE=cancun forge script script/DeployTANIssuanceHistory.s.sol \
     --rpc-url $POLYGON_RPC_URL --private-key $PRIVATE_KEY --broadcast --verify -vvvv
   ```
   Only a broadcast writes the address into `deployments/polygon.json`.

5. **Wire it in as increaser**, proposed from the plugin owner Safe:
   ```
   FOUNDRY_PROFILE=cancun forge script script/safe/TANIssuanceSafeOps.s.sol \
     --sig "setIncreaser()" --rpc-url $POLYGON_RPC_URL --ffi -vvvv
   ```

6. **Submit every backfill chunk** from the TAN Safe, one proposal per chunk:
   ```
   FOUNDRY_PROFILE=cancun forge script script/safe/TANIssuanceSafeOps.s.sol \
     --sig "backfillChunk(string)" safe_param_backfill_chunk_0.json --rpc-url $POLYGON_RPC_URL --ffi -vvvv
   ```
   The key block comes from the manifest, and each chunk must match the manifest's account count and
   total. Chunks are order independent and safe to repeat. **Send nothing else to the history until
   every chunk has landed:** a settlement that credits any non-zero amount seals the backfill.

7. **Verify, then seal.**
   ```
   yarn ts-node backend/buildBackfill.ts --verify --new-history <address>
   ```
   This checks every account against the predecessor times 1e16, that the predecessor has not settled
   since the build, and that nothing was seeded outside the recipient set. While unsealed, a wrong seed
   is corrected by resubmitting its chunk with the right value. Once verification passes, propose
   `sealBackfill()`. A sealed seed is final.

8. **Run and settle the first V3 period**, starting at the backfill block plus one. Fund the TAN Safe
   with TelcoinV3 first; `settleChunk` transfers each chunk's total to the history in the same Safe
   transaction as the settlement.

## Fee token versus reward token

Fee volume is detected as transfers of `config.feeToken` into AmirX, and rewards settle in
`config.telToken`. The deployed AmirX contracts hardcode legacy TEL, so on Polygon the fee token stays
legacy TEL until AmirX is upgraded, while rewards are TelcoinV3 from the cutover onward. The calculator
scales every fee into reward-token units, so the rebate cap compares like with like. When AmirX moves
to TelcoinV3, only `config.feeToken` changes.

## Contract invariants

| Invariant | Enforced by |
|---|---|
| An account's cumulative rewards never decrease once sealed | Settlement only adds; backfill is closed by the seal |
| Checkpoint keys never exceed `lastSettlementBlock`, and it never decreases | `InvalidBlock` on settlement and on the first backfill |
| Every seed shares one key, `backfillBlock` | `BackfillBlockMismatch` |
| A crediting settlement ends after `backfillBlock` | `InvalidBlock` |
| Unsealed implies every checkpoint is a seed | Zero rows write nothing; any non-zero credit seals |
| `backfillSealed` is one-way | No path clears it |
| A crediting chunk is applied at most once | `settledChunks` and `ChunkAlreadySettled` |
| Exactly the chunk total leaves the contract, and no allowance remains | Approve, pull, reset to zero |
| The plugin's reward token never changes | `IncompatiblePlugin` |
| Native value is only accepted when TEL is native | `UnexpectedNative` |
| Ownership cannot be renounced or mistyped away | `RenounceOwnershipDisabled`, `Ownable2Step` |

## Operator preconditions

- The history holds the chunk total when a settlement executes. `settleChunk` guarantees this by
  batching the transfer with the settlement.
- `SimplePlugin_TAN.increaser()` is the V3 history.
- Settlement chunks are at most 200 recipients and backfill chunks at most 300 accounts, which keeps
  the worst case under Polygon's 32M per-transaction gas cap with room for Safe overhead.
