# @x2c-fun/casinovault-backend

Reference **settlement backend** for the [Casino Vault](https://github.com/X2C-fun/casinovaultinfra). This is the component that actually keeps the pool solvent — the vault program is custody-only and cannot tell whether two approvals spend the same balance, so every balance rule lives here.

It implements [`docs/backend-integration.md`](../../docs/backend-integration.md) in full:

- **Balance holds / debit-at-approval** — the balance is moved to a hold *before* the withdraw is signed, closing the race where one balance funds many approvals.
- **`request_id` matching** — each hold's id is the withdraw `request_id`, echoed in `WithdrawEvent`, so settlement is exact, never by amount.
- **A finalized-only event listener** — credits deposits and settles withdrawals from **finalized** transactions only, skips any with `meta.err`, and de-duplicates by source position, never by content.
- **Incident response** — an unmatched `WithdrawEvent` (the leaked-admin-key shape) pauses the vault immediately.
- **Expiry release** — a hold whose transaction can no longer land is returned to the balance.
- **Reconciliation** — checks `pool balance === Σ player balances + house bankroll + rent reserve`.

> **Devnet only, and NOT production-hardened.** The HTTP API has **no authentication** — you must add your own (session / JWT / wallet-signature) and bind `owner` to the authenticated user before approving a withdrawal. See the repo [SECURITY.md](../../SECURITY.md).

## Architecture

```
HTTP API ──approveWithdrawal──▶ Ledger.placeHold (debit at approval)
                               └▶ build + admin-sign withdraw tx ──▶ user signs & submits
Listener ──getSignaturesForAddress(finalized)──▶ settleTransaction
   │                                                 ├─ DepositEvent  → Ledger.credit
   │                                                 └─ WithdrawEvent → Ledger.settleHold (or incident → pause)
   └─ releaseExpiredHolds (hold can no longer land → back to available)
Reconcile job ── reconcilePoolLive ── pool vs ledger
```

The ledger interface is **synchronous** on purpose: `placeHold` must check the balance and move it to a hold with no `await` in between. Two implementations ship:

- **`SqliteLedger`** (default) — durable, holds survive a restart.
- **`MemoryLedger`** — zero-dependency, for tests and demos only.

## Run

```bash
cp packages/backend/.env.example packages/backend/.env   # set ADMIN_SECRET_KEY, RPC_URL
npm --workspace @x2c-fun/casinovault-backend run start    # API + listener in one process
# or run them separately:
npm --workspace @x2c-fun/casinovault-backend run listener
npm --workspace @x2c-fun/casinovault-backend run reconcile
```

`ADMIN_SECRET_KEY` is verified against the on-chain admin at startup; a mismatch exits immediately.

## HTTP API (reference, unauthenticated)

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ ok }` |
| GET | `/vault` | — | program id + decoded vault state |
| GET | `/balance` | `?owner=<key>` | `{ ownerKey, available, pending }` |
| POST | `/withdraw` | `{ owner, destination, amountLamports, house? }` | `{ requestId, transactionBase64, lastValidBlockHeight }` |

The client deserializes `transactionBase64`, calls `assertSafeWithdrawTx` from the SDK, signs, and submits. Deposits are credited by the listener from chain — there is deliberately no deposit-credit endpoint.

## What this is NOT

- Not authenticated — add auth before exposing `/withdraw`.
- Not audited, not for mainnet funds.
- Not a full accounting system — it demonstrates the solvency-critical path; your production ledger will carry game history, bets, bonuses, etc.

## Test

```bash
npm --workspace @x2c-fun/casinovault-backend run test   # ledger + settlement logic, no chain
```

## License

MIT
