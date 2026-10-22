# @x2c-fun/casinovault-backend

Reference **settlement backend** for the [Casino Vault](https://github.com/X2C-fun/casinovaultinfra). This is the component that actually keeps the pool solvent — the vault program is custody-only and cannot tell whether two approvals spend the same balance, so every balance rule lives here.

It implements [`docs/backend-integration.md`](../../docs/backend-integration.md):

- **Balance holds / debit-at-approval** — the balance is moved to a hold *before* the withdraw is signed, closing the race where one balance funds many approvals. The payout always goes to the owner's own wallet.
- **`request_id` matching** — each hold gets a random, unique u64 `request_id`, echoed in `WithdrawEvent`, so settlement is exact, never by amount.
- **A finalized-only event listener** — reads `emit_cpi!` events (truncation-proof) from **finalized** transactions only, skips failed ones, pages back until it positively finds its cursor, and de-duplicates by source position (`vaultEventKey`), never by content. Seen-marking and the balance effect are one DB transaction.
- **Incident response** — any WithdrawEvent that is not the expected settlement of an open hold sets a durable **kill-switch** (no more approvals) and pauses the vault, retrying every cycle until it is paused.
- **Expiry release** — a hold is released only after the listener drained every finalized signature in a cycle that started with the finalized tip past the hold's `lastValidBlockHeight` + margin, only while the finalized pool balance covers every ledger liability (solvency gate), and never while an incident is open.
- **Reconciliation** — checks `pool balance === Σ player balances + house bankroll + rent reserve` at `finalized`, reading the ledger read-only.

> **Devnet only, and NOT production-hardened.** The API's bearer token only keeps strangers off a backend-to-backend API. It does **not** authenticate players: a real deployment must authenticate the player (session / JWT / wallet signature) and derive `owner` from that session, never from the request body. See the repo [SECURITY.md](../../SECURITY.md).

## Architecture

```
HTTP API ──approveWithdrawal──▶ kill-switch? caps? ▶ Ledger.placeHold (debit at approval)
                               └▶ build + admin-sign withdraw tx ──▶ user signs & submits
Listener ──getSignaturesForAddress(finalized, paged)──▶ getTransaction ──▶ decodeVaultTransactionEvents(cpi)
   │        ├─ DepositEvent  → Ledger.applyDepositEvent  (player, or house bankroll if depositor = admin)
   │        └─ WithdrawEvent → Ledger.applyWithdrawEvent (settle, or incident → kill-switch → pause)
   └─ releaseExpiredHolds (only after a full drain; tip measured before it; solvency gate)
Operator CLIs ── house-withdraw, incident status|clear
Reconcile job ── reconcilePoolLive (finalized) ── pool vs ledger (DB opened read-only)
```

The ledger interface is **synchronous** on purpose: `placeHold` must check the balance and move it to a hold with no `await` in between. Two implementations ship:

- **`SqliteLedger`** (default) — durable; holds, the listener cursor and the kill-switch survive a restart. **The API, the listener, the reconcile job and the CLIs must all use the same `DB_PATH`.** Request IDs and lamports are stored as TEXT (full u64). Every write runs in an `IMMEDIATE` transaction, so two processes on one WAL database wait on `busy_timeout` instead of failing with `SQLITE_BUSY_SNAPSHOT`.
- **`MemoryLedger`** — for tests only. Refused unless `NODE_ENV=test` or `ALLOW_MEMORY_LEDGER=true`.

## Run

Requires **Node.js >= 22.9** (`engines` in package.json): every runtime script runs `tsx --env-file-if-exists=.env …`, and Node added `--env-file-if-exists` in 22.9.0 (tsx forwards Node flags).

```bash
cd packages/sdk && npm ci && npm run build     # the backend depends on file:../sdk
cd ../backend && npm ci
cp .env.example .env    # set ADMIN_SECRET_KEY, RPC_URL, API_TOKEN, and UPGRADE_SLOT or START_AFTER_SIGNATURE
```

`npm run start|dev|api|listener|reconcile|house-withdraw|incident` load `./.env` (relative to the directory npm runs the script in, i.e. `packages/backend`) when it exists; a missing `.env` is not an error. Variables already set in the process environment take precedence over `.env`. Running an entry point with plain `node`/`tsx` (not through npm) does not load `.env` unless you pass the flag yourself.

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

With no stored cursor, the listener **refuses to start** unless `UPGRADE_SLOT` or `START_AFTER_SIGNATURE` is set, so it never replays the program's whole history. For the canonical devnet deployment (`EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7`) the v0.1 → v0.2 upgrade slot is `512813387`.

**Ledger binding.** On first open the ledger stores the cluster's genesis hash (`getGenesisHash()` from `RPC_URL`) and `VAULT_PROGRAM_ID`. Every process (`start`, `dev`, `api`, `listener`, `house-withdraw`, `incident`, `reconcile`) compares them at startup and **refuses to run** on a mismatch: wrong cluster, wrong deployment, or a `DB_PATH` meant for another one. `reconcile` and `incident` only compare; they never write the binding.

**Do not run the frontend's demo `/api/withdraw` route against the same vault as this backend.** That route signs withdrawals with the admin key but places no hold in this ledger, so the listener sees each demo payout as a WithdrawEvent with an unknown `request_id`: every demo withdrawal opens an incident (kill-switch + vault pause). Give the demo its own vault deployment.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `RPC_URL` | devnet | Solana RPC; needs full transaction history (BigTable / archival); prefer one consistent endpoint |
| `VAULT_PROGRAM_ID` | SDK default | Vault deployment |
| `ADMIN_SECRET_KEY` | — | Admin co-signer (API, listener, house-withdraw) |
| `LEDGER` / `DB_PATH` | `sqlite` / `casinovault.db` | Shared ledger |
| `ALLOW_MEMORY_LEDGER` | — | `true` to allow `LEDGER=memory` outside tests |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | API bind address |
| `API_TOKEN` | — (empty in `.env.example`) | Bearer token for every route except `/health`; required, ≥ 16 chars, values starting with `change-me` are refused |
| `ALLOW_UNAUTHENTICATED` | — | `true` = no token; local development only, refused unless `HOST` is `127.0.0.1`, `::1` or `localhost` |
| `COMPUTE_UNIT_PRICE_MICRO_LAMPORTS` / `COMPUTE_UNIT_LIMIT` | — | Optional priority fee. Validated at startup: limit in `1..1400000`, and `ceil(price × (limit ?? 1400000) / 1e6)` ≤ the SDK's `MAX_PRIORITY_FEE_LAMPORTS` (1,000,000) |
| `UPGRADE_SLOT` | — | Listener skips program transactions at or before this slot (v0.1 layout); devnet: `512813387` |
| `START_AFTER_SIGNATURE` | — | Listener's initial cursor when the ledger has none |
| `LISTENER_MAX_BACKLOG` | `10000` | ≥ 1000. Alert threshold for pending signatures in one listener cycle (with a cursor the backlog is still processed); on first start a larger backlog is refused |
| `LISTENER_NOT_FOUND_INCIDENT_CYCLES` | `10` | Consecutive cursor-not-found cycles before the listener opens an incident and pauses the vault (it halts and alerts before that) |
| `HOUSE_BANKROLL_LAMPORTS` | `0` | House funds in the pool the ledger cannot see; a liability for `reconcile` and the listener's solvency gate |

## HTTP API (reference)

All routes except `/health` require `Authorization: Bearer <API_TOKEN>`.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ ok }` |
| GET | `/vault` | — | program id + decoded vault state |
| GET | `/balance` | `?owner=<wallet>` | `{ ownerKey, available, pending }` |
| POST | `/withdraw` | `{ owner, amountLamports, destination? }` | `{ requestId, transactionBase64, lastValidBlockHeight, amountLamports }` |

`/withdraw` rules: body ≤ 16 KB; unknown fields (including `house`) are rejected; `amountLamports` must be a decimal **string** (no JSON numbers, hex, signs or exponents) in `1..u64::MAX`; `destination`, if sent, must equal `owner` (the payout always goes to the owner's own wallet, since deposits are credited to the depositor's wallet); `owner` may not be the admin wallet (`admin_owner`: admin deposits are the house bankroll, paid out only by `house-withdraw`). The approval checks the kill-switch, the pause flag, the per-transaction cap, the remaining per-window allowance, pool liquidity, and that a payout to an empty wallet is at least `getMinimumBalanceForRentExemption(0)`. Refusals return `{ error, code }` with a safe message; internal failures return a generic `{ error: "internal error" }` and are logged server-side.

The client deserializes `transactionBase64`, calls `assertSafeWithdrawTx` from the SDK, signs, and submits. Deposits are credited by the listener from chain — there is deliberately no deposit-credit endpoint.

## Operator commands

```bash
npm run house-withdraw -- <lamports>   # house payout to the ADMIN wallet only
npm run incident -- status             # kill-switch state + incident log (DB opened read-only)
npm run incident -- clear              # manual: re-enable approvals
npm run incident -- clear --force      # ... even while mismatched holds are open
```

`incident` and `house-withdraw` fail if `DB_PATH` does not exist; they never create an empty ledger. `incident -- clear` **refuses** (exit 3) while a hold named by a `WithdrawEvent mismatch` incident is still open, and lists those holds. Such a hold stays open after the mismatch, so clearing the kill-switch would let the listener release it on expiry and hand back a balance whose `request_id` was already used on chain. Resolve each one first (it settles, or you correct the books by hand), or pass `--force` deliberately.

**House bankroll.** Deposits made from the admin wallet are credited to the house bankroll (not a player balance). `house-withdraw` draws on that bankroll, registers a house hold (destination must be the admin key) *before* signing, signs as admin + fee payer and submits. The listener settles it like any hold; a settled house withdrawal reduces the bankroll, an expired one is released back to it. Game P&L moved between players and the house is outside this reference — post it to your own ledger.

**Kill-switch.** Opened (durably, in the ledger) on any unmatched / mismatched / replayed WithdrawEvent, a WithdrawEvent for a released hold, a house hold paid to a non-admin, an undecodable vault event, or a listener cursor the RPC listing has not contained for 10 consecutive cycles. While it is open, every approval is refused (including one whose transaction was being built when the switch opened: it is re-checked after signing and the hold released), expired holds are not released, and the listener retries `set_paused(true)` every cycle until the vault reads paused. Only `npm run incident -- clear` re-enables approvals (refused while mismatched holds are open, see above); unpause the vault separately (root `npm run set-paused`) after investigating and reconciling.

**Upgrades from v0.1.** v0.1 events do not decode with the v0.2 IDL. Set `UPGRADE_SLOT` (and/or `START_AFTER_SIGNATURE`) so v0.1-era history is skipped, after reconciling v0.1 balances separately. An undecodable event after that point opens the kill-switch and is recorded; the listener does not loop on it.

## Reconcile

`npm run reconcile` opens `DB_PATH` **read-only** and fails if the file does not exist, so a wrong path cannot "reconcile" an empty ledger. It prints the pool, player and house totals, the listener's cursor slot and the number of open (unsettled) holds. An `INSOLVENT` result (exit 2) while the listener is behind the chain can be transient: finalized withdrawals the listener has not applied yet still count as liabilities. Re-run once the listener has caught up before acting.

## Listener guarantees

**RPC requirements.** The listener needs an RPC endpoint with **full transaction history** (BigTable-backed or an archival node), so `getSignaturesForAddress` can always page back to the cursor. On a node that prunes history, an idle vault's cursor eventually falls out of the node's window and the listener halts (no processing, no releases; an incident after 10 consecutive misses, see below). Prefer **one consistent RPC endpoint** (one provider, ideally sticky to one node) over a pool of unrelated nodes: the safeguards below make disagreeing nodes safe, but every disagreement costs a halted cycle. An optional, not implemented, way to keep an idle vault's cursor fresh is a periodic heartbeat transaction that references the program (e.g. a tiny deposit from the admin wallet, which the ledger credits to the house bankroll) so the cursor stays recent.

- **Positive proof of a complete scan.** Each cycle pages `getSignaturesForAddress` backwards with `before` only, never `until`: the RPC omits the `until` signature, so "reached the cursor" and "this node's history ends here" would both look like an empty page. The scan counts as complete only when the **cursor signature** (or another signature already processed in the cursor's slot) is listed **in a response that also lists an older slot** — that response then holds the cursor's slot whole (see slot-aligned pages), so every unprocessed signature of that slot came with it. An empty page, or an entry from a slot older than the cursor's, before that means the cursor is **not found**: the cycle halts, processes nothing and releases nothing, and the operator is alerted on the first miss. Only `LISTENER_NOT_FOUND_INCIDENT_CYCLES` (default 10) **consecutive** misses (about 40 s at the default 4 s poll) open the kill-switch and pause the vault, so one flaky or pruned load-balanced node does not pause everyone; refusing to release is what keeps funds safe in the meantime. A pruned or lagging node can therefore not make the listener miss a withdrawal and release its hold.
- On first start (no cursor), `START_AFTER_SIGNATURE` must likewise be listed, and with `UPGRADE_SLOT` the listing must reach an entry at or below that slot (the upgrade transaction itself). Otherwise the listener halts with an alert and processes nothing. With `START_AFTER_SIGNATURE`, every transaction in the start transaction's slot is skipped (treated as v0.1-era), not only the ones before it. A start (or legacy-cursor) lookup that `getTransaction` does not answer is treated as a lagging node: halt and retry, no incident.
- **Slot-aligned pages.** The order of transactions inside one slot can differ between nodes, and `before` is applied in the answering node's order. A page that ended in the middle of a slot could therefore make the next page (from another node) skip part of that slot for good. So the **oldest slot of every response is dropped** and `before` is set to the oldest entry of a newer slot: each slot is trusted only from a response that also lists an older slot, and everything is de-duplicated by signature. This includes **short** pages: Agave fills a short blockstore answer from BigTable (in BigTable's own intra-slot order, dropping duplicates), so a page can be shorter than `limit` while part of its oldest slot, and older history, was never returned. A short page therefore never proves the end of history.
- Consequence: if the cursor's slot is the oldest slot the node has at all, completeness cannot be proven and the listener halts (no release). That does not happen in practice — the program's deploy / upgrade / initialize transactions are older than any vault transaction — so an idle vault still drains: its listing is the cursor's slot followed by older history in one response. For a brand-new deployment start with `UPGRADE_SLOT` (any entry at or below it ends the scan), not with the deploy signature as `START_AFTER_SIGNATURE`.
- **Progress guarantees.** A page that adds no new signature (a single-slot page, or only the rest of `before`'s slot) is retried once with the maximum limit (1000); if it still adds nothing the listener halts with an alert (`scan_stalled`; a slot with more than 1000 vault signatures halts as `slot_too_large`) instead of looping or skipping. At most 2,000 pages per scan (then `scan_stalled`), and the scan re-checks the listener lease every 50 pages. Pages are 1000 signatures (the RPC maximum).
- **Lagging nodes.** Each cycle reads the finalized slot and block height from one `getEpochInfo("finalized")` response and passes that slot as `minContextSlot` to every `getSignaturesForAddress` call. A load-balanced node that is behind then errors instead of answering; the cycle stops (nothing processed past that point, no release) and is retried. `getTransaction` has no `minContextSlot` in the RPC API; a node without the transaction returns `null`, which stops the cycle as described below.
- **Same-slot ordering.** The ledger remembers every signature already processed in the cursor's slot (stored with the cursor, written after the transaction's events were applied). A signature of that slot that a node lists after the cursor and that is not in that set is processed; the ones in it are never fetched again. Re-applying a transaction is a no-op anyway: events are de-duplicated by `vaultEventKey`, atomically with their effect.
- Processes oldest-first and advances the cursor (and its slot) only after each transaction is fully applied.
- **Backlog.** Everything listed in a cycle is processed in that cycle (no re-paging). `LISTENER_MAX_BACKLOG` (≥ 1000) is an alert threshold: with a cursor, a larger backlog raises an alert (once per cycle) and is still processed; a hold is released only by a cycle that processed everything it listed. Above a hard safety cap of 1,000,000 pending signatures the listener halts with an alert. Without a cursor (first start), a backlog above `LISTENER_MAX_BACKLOG` is refused (check the start point).
- **Failed transactions** are skipped using the signature index's `err` field, without fetching them. That field is the same `TransactionError` the node stores as the transaction's `meta.err` (both come from one execution result), and a failed transaction's effects, including its `emit_cpi!` events, are rolled back. A fetched transaction with `meta.err` also decodes to no events.
- If `getTransaction` returns `null` or lacks data, the cycle stops **without** advancing the cursor and retries next poll; after 10 consecutive cycles stuck on the same signature it alerts (and again every 10).
- Any other cycle error, or a halt (lagging node, cursor or start not found, oversized backlog or slot), is logged and retried; after **5 consecutive failed cycles** the operator is alerted (and again every 5).
- Hold release runs only in a cycle that drained the whole backlog, using the finalized block height measured **before** the drain: any withdraw that could still settle the hold landed in a block at or below that height, which was finalized before the signatures were listed by a node at or past that slot, so the drain saw it. The listener re-checks its lease right before releasing. No release happens while an incident is open.
- **Solvency gate (backstop against RPC listing gaps).** Independently of pagination, before releasing ANY expired hold the listener reads the pool PDA's balance at `finalized` with `minContextSlot` = the cycle's finalized slot (a lagging node errors → the cycle halts, no release) and checks `pool >= Σ player available + pending + house bankroll (available + pending) + HOUSE_BANKROLL_LAMPORTS + rent-exempt reserve` — the same math as `npm run reconcile` (`src/services/solvency.ts`, SDK `reconcilePool`). A release moves `pending` back to `available`, so it does not change liabilities; but a withdrawal that landed while the listing missed it has already left the pool, so the pool is short by its amount and the release is refused. On a shortfall nothing is released that cycle, it is logged, and after 5 consecutive shortfall cycles the operator is alerted (no immediate incident: a withdrawal settling on chain between the listing and the balance read causes a one-cycle shortfall). It is defence in depth, not a proof: a deposit landing in the same window can mask a shortfall of equal size. The balance is read only in cycles that have an expired hold to release.

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
