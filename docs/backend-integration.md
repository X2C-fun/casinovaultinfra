# Backend integration

What a casino backend must do to use the vault safely: hold the admin key,
read vault state, approve withdrawals, and credit and debit from events.
Read the withdraw flow and listener rules in full before building on it.

## Using the admin key in a backend (`ADMIN_SECRET_KEY`)

Backends (your game server, or `casinovault-frontend/src/app/api/withdraw` in the demo)
co-sign withdrawals with the admin key, loaded from the `ADMIN_SECRET_KEY`
environment variable. It accepts either format:

**JSON array** (exact contents of `keys/admin.json`):

```bash
cat keys/admin.json
# → [12,34,56,...]
```

```env
ADMIN_SECRET_KEY=[12,34,56,...]
```

**Base58** (single string):

```bash
node -e "const {bs58}=require('@coral-xyz/anchor').utils.bytes;console.log(bs58.encode(Uint8Array.from(require('./keys/admin.json'))))"
```

```env
ADMIN_SECRET_KEY=5Kd3...base58...
```

Rules:

- Server-side only. Never put it in a `NEXT_PUBLIC_*` variable or ship it to a
  browser.
- Set it in your host's secret store (Railway / Vercel / Fly env vars), not in
  committed files.
- The backend must check the user's off-chain balance **before** co-signing.
- If the backend logs `ADMIN_SECRET_KEY does not match on-chain admin`, the key
  in env is not the one that ran `initialize`.

---

## Reads (no instruction — plain RPC fetches)

| What you need            | How                                               |
| ------------------------ | ------------------------------------------------- |
| Admin, pause, caps       | `program.account.vaultState.fetch(vaultStatePda)` |
| Pool SOL balance         | `connection.getBalance(poolVaultPda)`             |
| Withdrawable SOL         | `poolBalance - rentExemptMinimum(0)`              |
| Whether vault is live    | Account exists at `["vault_state_v2"]`            |

```ts
const [vaultState] = PublicKey.findProgramAddressSync([Buffer.from("vault_state_v2")], PROGRAM_ID);
const [poolVault] = PublicKey.findProgramAddressSync([Buffer.from("pool_vault")], PROGRAM_ID);

const state = await program.account.vaultState.fetch(vaultState);
const poolLamports = await connection.getBalance(poolVault);
const rent = await connection.getMinimumBalanceForRentExemption(0);
const withdrawable = Math.max(0, poolLamports - rent);
```

---

## Backend withdraw flow

> **Debit at approval, not at confirmation.** Each approval is an independent
> transaction with its own blockhash; the program cannot tell whether two
> approvals spend the same off-chain balance. If you only debit after a
> `WithdrawEvent` lands, a user with 1 SOL can request N approvals in a few
> seconds — each passes the balance check — and submit all N for N SOL.

The safe sequence:

1. Authenticate the user and lock their balance row (database transaction /
   `SELECT … FOR UPDATE`, or an atomic conditional update).
2. Check balance, limits, and anti-cheat. Reject if `available < amount`.
   Allocate a **withdrawal ID** that fits in a u64 (for example the hold
   table's primary key). It becomes the transaction's `request_id`, which the
   program echoes in `WithdrawEvent`, so the listener can match the event to
   exactly this hold. Make it unique in the database; the program does not
   enforce uniqueness.
3. Fetch a blockhash and build the transaction yourself: exactly one
   `withdraw(amount, request_id)` instruction, optionally preceded by
   ComputeBudget instructions you choose (a priority fee helps on a congested
   cluster; the user cannot add one, because you sign the whole message), with
   the user's wallet as `user` and fee payer. The user must already hold
   enough SOL for the fee, and a payout to an empty wallet must be at least the
   rent-exempt minimum for an empty account
   (`getMinimumBalanceForRentExemption(0)`) or it fails. Check the amount
   against the on-chain caps (`max_withdraw_per_tx`, the current window) so the
   user gets a clear error instead of a failed transaction.
   **Never co-sign a transaction you did not build.** A user-built
   transaction could wrap `withdraw` in other instructions or programs, and
   your settlement logic would no longer see what you approved.
4. In one database transaction, **place the hold** for `amount` (move it from
   `available` to `pending_withdrawal`), store the withdrawal ID, the
   destination wallet and `lastValidBlockHeight` on it, and commit. Only then
   partially sign with the **admin** key and return the transaction. A crash
   before the commit leaves nothing signed; a crash after it leaves a hold that
   step 6 releases once it expires.

   Do **not** expect to store the transaction signature here. A transaction's
   signature is its fee payer's signature, which is the user's, and it does
   not exist until the user signs.
5. The user signs and submits it, either through your backend or straight to
   an RPC node; your backend cannot prevent the latter, so settlement must not
   depend on seeing the signed transaction.
6. Settle the hold from finalized chain data:
   - A finalized, successful transaction contains a `WithdrawEvent` whose
     `request_id` matches an open hold, and whose `user` and `amount` match
     that hold → convert the hold to a debit and record the transaction
     signature.
   - A `WithdrawEvent` whose `request_id` matches no open hold, or whose
     `user` or `amount` differ from it (other than a house withdrawal, below),
     means an approval leaked or your accounting is wrong. Treat it as an
     incident: alert and `set_paused true` before anything else.
   - The listener has processed every finalized block up to a block height
     greater than the hold's `lastValidBlockHeight`, and no matching event
     was seen → the transaction can no longer land; release the hold back to
     `available`.
   - Never release a hold before both conditions of the previous point hold.
     A block-height check alone is not enough if your listener is lagging.

House withdrawals (admin as both user and admin) skip the user-balance hold,
but **not** the matching. Register each one in a `house_withdrawals` record
before signing and use its ID as `request_id`. A `WithdrawEvent` with no
matching hold or house record is exactly what a leaked admin key produces, so
it must raise the incident in step 6, whoever the recipient is.

Rules for the listener. [`packages/backend`](../packages/backend) is a
reference implementation of them, and the SDK's `decodeVaultTransactionEvents`
and `vaultEventKey` ([`packages/sdk`](../packages/sdk/README.md)) handle the
decoding, the failed-transaction check and the key below.

- **Ignore every transaction whose `meta.err` is set.** A failed transaction is
  rolled back, but its logs and its inner instructions still contain every
  event emitted before the failing instruction. Example:
  `[deposit(1 SOL), a transfer that fails]` moves nothing, yet it carries a
  `DepositEvent` for 1 SOL in both places; crediting it hands out free balance
  that can be withdrawn as real SOL. Anchor's `program.addEventListener`
  already skips failed transactions; if you fetch transactions with
  `getTransaction`, you must check `meta.err` yourself (see `getTxDetails`
  in `tests/utils.ts`).
- Credit and debit only from **finalized** transactions. Use the websocket
  feed for fast UI updates, not for balances.
- `DepositEvent` and `WithdrawEvent` arrive twice per instruction, once in the
  logs (`emit!`) and once as a self-CPI (`emit_cpi!`). Consume **one** of the
  two sources (see [Events and errors](reference.md#events-and-errors)).
- **De-duplicate by position, never by contents.** Use
  `(transaction signature, source, instruction index, event index)` as a
  unique key in your database, and consume one source so each event is
  stored once (`vaultEventKey` builds this key). Two identical deposits in
  one slot, or one transaction, produce identical events, so content-based
  de-duplication drops one; no de-duplication at all credits twice when the
  listener restarts or backfills.
- Never settle a hold by amount or wallet alone; match on `request_id` first
  and then check `user` and `amount` (see step 6).
- Events from before a v0.1 → v0.2 upgrade use the v0.1 layout (`WithdrawEvent`
  had no `request_id`; `VaultInitializedEvent` had no `authority` or
  `vault_balance`). Record the upgrade's slot and decode older transactions
  with the v0.1 IDL, or skip them once v0.1 balances are reconciled. Decoding
  them with the v0.2 IDL fails or misreads fields.
- The program rejects `deposit`/`withdraw` called through CPI
  (`CpiNotAllowed`), so every one that succeeds is a top-level instruction
  whose event Anchor's parser can read.
- SOL sent to the pool PDA with a plain System transfer produces **no**
  `DepositEvent`. Never credit balances from pool balance changes; the
  reconciliation in the [Mainnet checklist](deployment.md#mainnet-checklist) covers the
  difference.

The reference frontend's demo route (`/api/withdraw`) has no ledger, so it
skips the hold entirely; it is not an implementation of this flow.
