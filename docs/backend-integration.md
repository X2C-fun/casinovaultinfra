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
| Admin, pause, vault bump | `program.account.vaultState.fetch(vaultStatePda)` |
| Pool SOL balance         | `connection.getBalance(poolVaultPda)`             |
| Withdrawable SOL         | `poolBalance - rentExemptMinimum(0)`              |
| Whether vault is live    | Account exists at `["vault_state"]`               |

```ts
const [vaultState] = PublicKey.findProgramAddressSync([Buffer.from("vault_state")], PROGRAM_ID);
const [poolVault] = PublicKey.findProgramAddressSync([Buffer.from("pool_vault")], PROGRAM_ID);

const state = await program.account.vaultState.fetch(vaultState);
const poolLamports = await connection.getBalance(poolVault);
const rent = await connection.getMinimumBalanceForRentExemption(0);
const withdrawable = Math.max(0, poolLamports - rent);
```

---

## Backend withdraw flow

> **Debit at approval, not at confirmation.** The program has no request ID or
> nonce on `withdraw`, so it cannot tell two approvals apart. If you only debit
> after a `WithdrawEvent` lands, a user with 1 SOL can request N approvals in a
> few seconds — each gets a fresh blockhash, each passes the balance check —
> and submit all N for N SOL.

The safe sequence:

1. Authenticate the user and lock their balance row (database transaction /
   `SELECT … FOR UPDATE`, or an atomic conditional update).
2. Check balance, limits, and anti-cheat. Reject if `available < amount`.
   Also reject if this account **or the destination wallet** already has an
   open hold. One open hold per destination wallet is required, not optional:
   v0.1 `withdraw` carries no request ID, so the listener matches a
   `WithdrawEvent` to its hold by `user` (the wallet), and two holds on one
   wallet would be ambiguous.

   Locking the account's own balance row (step 1) does **not** enforce this:
   two accounts withdrawing concurrently to the same wallet each lock only
   their own row, and both holds get placed. Enforce it in the database, for
   example with a unique partial index on the holds table,
   `UNIQUE (destination_wallet) WHERE status = 'open'`, so the second insert
   fails.
3. Fetch a blockhash and build the `withdraw` transaction yourself: exactly
   one `withdraw` instruction, optionally preceded by ComputeBudget
   instructions you choose (a priority fee helps on a congested cluster; the
   user cannot add one, because you sign the whole message), with the user's
   wallet as `user` and fee payer. The user must already hold enough SOL for
   the fee, and a payout to an empty wallet must be at least the rent-exempt
   minimum (about 0.00089 SOL) or it fails.
   **Never co-sign a transaction you did not build.** A user-built
   transaction could wrap `withdraw` in other instructions or programs, and
   your settlement logic would no longer see what you approved.
4. In one database transaction, **place the hold** for `amount` (move it from
   `available` to `pending_withdrawal`), store the destination wallet and
   `lastValidBlockHeight` on it, and commit. Only then partially sign with
   the **admin** key and return the transaction. A crash before the commit
   leaves nothing signed; a crash after it leaves a hold that step 6 releases
   once it expires.

   Do **not** expect to store the transaction signature here. A transaction's
   signature is its fee payer's signature, which is the user's, and it does
   not exist until the user signs.
5. The user signs and submits it, either through your backend or straight to
   an RPC node; your backend cannot prevent the latter, so settlement must not
   depend on seeing the signed transaction.
6. Settle the hold from finalized chain data:
   - A finalized, successful transaction contains a `WithdrawEvent` whose
     `user` has an open hold and whose `amount` equals it → convert the hold
     to a debit and record the transaction signature.
   - A `WithdrawEvent` for a wallet with **no** open hold, or with a different
     `amount` (other than a house withdrawal, below), means an approval leaked
     or your accounting is wrong. Treat it as an incident: alert and
     `set_paused true` before anything else.
   - The listener has processed every finalized block up to a block height
     greater than the hold's `lastValidBlockHeight`, and no matching event
     was seen → the transaction can no longer land; release the hold back to
     `available`.
   - Never release a hold before both conditions of the previous point hold.
     A block-height check alone is not enough if your listener is lagging.

House withdrawals (admin as both user and admin) bypass this flow; exclude the
admin key when matching events to holds.

Rules for the listener:

- **Ignore every transaction whose `meta.err` is set.** A failed transaction is
  rolled back, but its logs still contain every event emitted before the
  failing instruction. Example: `[deposit(1 SOL), a transfer that fails]`
  moves nothing, yet its logs carry a `DepositEvent` for 1 SOL; crediting it
  hands out free balance that can be withdrawn as real SOL. Anchor's
  `program.addEventListener` already skips failed transactions; if you fetch
  transactions with `getTransaction` and parse them with `EventParser`, you
  must check `meta.err` yourself (see `getTxDetails` in `tests/utils.ts`).
- Credit and debit only from **finalized** transactions. Use the websocket
  feed for fast UI updates, not for balances.
- **De-duplicate by source, never by contents.** Use
  `(transaction signature, instruction index, event index)` as a unique key
  in your database. Two identical deposits in one slot produce identical
  events, so content-based de-duplication drops one; no de-duplication at all
  credits twice when the listener restarts or backfills.
- Never settle a hold by amount alone; match on `user` first (see step 6).
- The program rejects `deposit`/`withdraw` called through CPI
  (`CpiNotAllowed`), so every one that succeeds is a top-level instruction
  whose event Anchor's parser can read.
- SOL sent to the pool PDA with a plain System transfer produces **no**
  `DepositEvent`. Never credit balances from pool balance changes; the
  reconciliation in the [Mainnet checklist](deployment.md#mainnet-checklist) covers the
  difference.

The reference frontend's demo route (`/api/withdraw`) has no ledger, so it
skips the hold entirely; it is not an implementation of this flow.
