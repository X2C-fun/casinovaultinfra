# @x2c-fun/casinovault-backend

Reference **settlement backend** for the [Casino Vault](https://github.com/X2C-fun/casinovaultinfra). This is the component that actually keeps the pool solvent — the vault program is custody-only and cannot tell whether two approvals spend the same balance, so every balance rule lives here.

It implements [`docs/backend-integration.md`](../../docs/backend-integration.md):

- **Balance holds / debit-at-approval** — the balance is moved to a hold *before* the withdraw is signed, closing the race where one balance funds many approvals. The payout always goes to the owner's own wallet.
- **`request_id` matching** — each hold gets a random, unique u64 `request_id`, echoed in `WithdrawEvent`, so settlement is exact, never by amount.
- **A finalized-only event listener** — reads `emit_cpi!` events (truncation-proof) from **finalized** transactions only, skips any with `meta.err`, pages through the full backlog, and de-duplicates by source position (`vaultEventKey`), never by content. Seen-marking and the balance effect are one DB transaction.
- **Incident response** — any WithdrawEvent that is not the expected settlement of an open hold sets a durable **kill-switch** (no more approvals) and pauses the vault, retrying every cycle until it is paused.
- **Expiry release** — a hold is released only after the listener drained every finalized signature in a cycle that started with the finalized tip past the hold's `lastValidBlockHeight` + margin, and never while an incident is open.
- **Reconciliation** — checks `pool balance === Σ player balances + house bankroll + rent reserve` at `finalized`, reading the ledger read-only.

> **Devnet only, and NOT production-hardened.** The API's bearer token only keeps strangers off a backend-to-backend API. It does **not** authenticate players: a real deployment must authenticate the player (session / JWT / wallet signature) and derive `owner` from that session, never from the request body. See the repo [SECURITY.md](../../SECURITY.md).

## Architecture

```
HTTP API ──approveWithdrawal──▶ kill-switch? caps? ▶ Ledger.placeHold (debit at approval)
                               └▶ build + admin-sign withdraw tx ──▶ user signs & submits
Listener ──getSignaturesForAddress(finalized, paged)──▶ getTransaction ──▶ decodeVaultTransactionEvents(cpi)
   │        ├─ DepositEvent  → Ledger.applyDepositEvent  (player, or house bankroll if depositor = admin)
   │        └─ WithdrawEvent → Ledger.applyWithdrawEvent (settle, or incident → kill-switch → pause)
   └─ releaseExpiredHolds (only after a full drain; tip measured before it)
Operator CLIs ── house-withdraw, incident status|clear
Reconcile job ── reconcilePoolLive (finalized) ── pool vs ledger (DB opened read-only)
```

The ledger interface is **synchronous** on purpose: `placeHold` must check the balance and move it to a hold with no `await` in between. Two implementations ship:

- **`SqliteLedger`** (default) — durable; holds, the listener cursor and the kill-switch survive a restart. **The API, the listener, the reconcile job and the CLIs must all use the same `DB_PATH`.** Request IDs and lamports are stored as TEXT (full u64). Every write runs in an `IMMEDIATE` transaction, so two processes on one WAL database wait on `busy_timeout` instead of failing with `SQLITE_BUSY_SNAPSHOT`.
- **`MemoryLedger`** — for tests only. Refused unless `NODE_ENV=test` or `ALLOW_MEMORY_LEDGER=true`.

## Run

```bash
cd packages/sdk && npm ci && npm run build     # the backend depends on file:../sdk
cd ../backend && npm ci
cp .env.example .env    # set ADMIN_SECRET_KEY, RPC_URL, API_TOKEN, and UPGRADE_SLOT or START_AFTER_SIGNATURE
```

Pick ONE layout (same `DB_PATH` throughout):

```bash
npm run start        # API + listener in one process
# — or —
npm run api          # API only
npm run listener     # listener only (a separate process)
```

Do not combine `start` with `listener`: that is two listeners on one ledger. The listener takes a **lease row** in the ledger (holder id + expiry, renewed every cycle and after every transaction); a second listener refuses to start, and a listener that loses the lease stops writing. The lease is released on SIGINT/SIGTERM and otherwise expires after 2 minutes.

```bash
npm run reconcile    # read-only; does not load ADMIN_SECRET_KEY
```

`ADMIN_SECRET_KEY` is verified against the on-chain admin at startup; a mismatch exits immediately. Key-parsing errors never echo the key, and logged error messages are redacted (the configured `RPC_URL`, URL credentials, and `api-key`/`apikey`/`token`/`key`-style query parameters).

With no stored cursor, the listener **refuses to start** unless `UPGRADE_SLOT` or `START_AFTER_SIGNATURE` is set, so it never replays the program's whole history.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `RPC_URL` | devnet | Solana RPC |
| `VAULT_PROGRAM_ID` | SDK default | Vault deployment |
| `ADMIN_SECRET_KEY` | — | Admin co-signer (API, listener, house-withdraw) |
| `LEDGER` / `DB_PATH` | `sqlite` / `casinovault.db` | Shared ledger |
| `ALLOW_MEMORY_LEDGER` | — | `true` to allow `LEDGER=memory` outside tests |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | API bind address |
| `API_TOKEN` | — (empty in `.env.example`) | Bearer token for every route except `/health`; required, ≥ 16 chars, values starting with `change-me` are refused |
| `ALLOW_UNAUTHENTICATED` | — | `true` = no token; local development only, refused unless `HOST` is `127.0.0.1`, `::1` or `localhost` |
| `COMPUTE_UNIT_PRICE_MICRO_LAMPORTS` / `COMPUTE_UNIT_LIMIT` | — | Optional priority fee |
| `UPGRADE_SLOT` | — | Listener skips program transactions at or before this slot (v0.1 layout) |
| `START_AFTER_SIGNATURE` | — | Listener's initial cursor when the ledger has none |
| `LISTENER_MAX_BACKLOG` | `10000` | Listener stops and alerts when more signatures than this are pending |
| `HOUSE_BANKROLL_LAMPORTS` | `0` | Reconcile only: house funds the ledger cannot see |

## HTTP API (reference)

All routes except `/health` require `Authorization: Bearer <API_TOKEN>`.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ ok }` |
| GET | `/vault` | — | program id + decoded vault state |
| GET | `/balance` | `?owner=<wallet>` | `{ ownerKey, available, pending }` |
| POST | `/withdraw` | `{ owner, amountLamports, destination? }` | `{ requestId, transactionBase64, lastValidBlockHeight, amountLamports }` |

`/withdraw` rules: body ≤ 16 KB; unknown fields (including `house`) are rejected; `amountLamports` must be a decimal **string** (no JSON numbers, hex, signs or exponents) in `1..u64::MAX`; `destination`, if sent, must equal `owner` (the payout always goes to the owner's own wallet, since deposits are credited to the depositor's wallet). The approval checks the kill-switch, the pause flag, the per-transaction cap, the remaining per-window allowance, pool liquidity, and that a payout to an empty wallet is at least `getMinimumBalanceForRentExemption(0)`. Refusals return `{ error, code }` with a safe message; internal failures return a generic `{ error: "internal error" }` and are logged server-side.

The client deserializes `transactionBase64`, calls `assertSafeWithdrawTx` from the SDK, signs, and submits. Deposits are credited by the listener from chain — there is deliberately no deposit-credit endpoint.

## Operator commands

```bash
npm run house-withdraw -- <lamports>   # house payout to the ADMIN wallet only
npm run incident -- status             # kill-switch state + incident log
npm run incident -- clear              # manual: re-enable approvals
```

**House bankroll.** Deposits made from the admin wallet are credited to the house bankroll (not a player balance). `house-withdraw` draws on that bankroll, registers a house hold (destination must be the admin key) *before* signing, signs as admin + fee payer and submits. The listener settles it like any hold; a settled house withdrawal reduces the bankroll, an expired one is released back to it. Game P&L moved between players and the house is outside this reference — post it to your own ledger.

**Kill-switch.** Opened (durably, in the ledger) on any unmatched / mismatched / replayed WithdrawEvent, a WithdrawEvent for a released hold, a house hold paid to a non-admin, an undecodable vault event, or a listener cursor the RPC no longer has. While it is open, every approval is refused (including one whose transaction was being built when the switch opened: it is re-checked after signing and the hold released), expired holds are not released, and the listener retries `set_paused(true)` every cycle until the vault reads paused. Only `npm run incident -- clear` re-enables approvals; unpause the vault separately (root `npm run set-paused`) after investigating and reconciling.

**Upgrades from v0.1.** v0.1 events do not decode with the v0.2 IDL. Set `UPGRADE_SLOT` (and/or `START_AFTER_SIGNATURE`) so v0.1-era history is skipped, after reconciling v0.1 balances separately. An undecodable event after that point opens the kill-switch and is recorded; the listener does not loop on it.

## Reconcile

`npm run reconcile` opens `DB_PATH` **read-only** and fails if the file does not exist, so a wrong path cannot "reconcile" an empty ledger. It prints the pool, player and house totals, the listener's cursor slot and the number of open (unsettled) holds. An `INSOLVENT` result (exit 2) while the listener is behind the chain can be transient: finalized withdrawals the listener has not applied yet still count as liabilities. Re-run once the listener has caught up before acting.

## Listener guarantees

- Pages `getSignaturesForAddress` backwards with `before` until it reaches the cursor, then processes oldest-first and advances the cursor (and its slot) only after each transaction is fully applied.
- Paging is bounded. If a page reaches a slot older than the stored cursor's slot without finding the cursor (pruned history, wrong RPC or cluster), the listener opens the kill-switch, alerts and processes nothing, instead of rescanning all history. More than `LISTENER_MAX_BACKLOG` pending signatures stops the cycle with an alert. A `START_AFTER_SIGNATURE` the RPC cannot find halts with an alert.
- If `getTransaction` returns `null` or lacks data, the cycle stops **without** advancing the cursor and retries next poll; after 10 consecutive cycles stuck on the same signature it alerts (and again every 10). Only transactions with `err`/`meta.err` are skipped.
- Hold release runs only in a cycle that drained the whole backlog, using the finalized block height measured **before** the drain: any withdraw that could still settle the hold landed in a block at or below that height, which was finalized before the signatures were listed, so the drain saw it. No release happens while an incident is open.

## What this is NOT

- Not player-authenticated — the bearer token is a placeholder for your auth.
- Not audited, not for mainnet funds.
- Not a full accounting system — it demonstrates the solvency-critical path; your production ledger will carry game history, bets, bonuses, etc.

## Test

```bash
(cd ../sdk && npm run build) && npm test   # ledgers (memory + sqlite), listener, API — no chain, no network
```

## License

MIT
