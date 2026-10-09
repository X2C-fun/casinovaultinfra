# Casino Vault Infra — Solana pooled custody program

An Anchor program that holds SOL for a casino backend in **one shared pool**. It
is a custody layer only: it moves SOL in and out under strict authority checks
and emits an event for every change. It knows nothing about balances, bets, wins,
losses, leaderboards, house accounting or game history — all of that lives in the
backend database, which is driven by the events emitted here.

| Item              | Value                                          |
| ----------------- | ---------------------------------------------- |
| Program ID        | `EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7` |
| Anchor            | `0.32.1`                                       |
| Solana / Agave    | `2.3.13`                                       |
| Rust (SBF)        | `1.84.0`, edition 2021                         |
| Deployed clusters | none yet (devnet deployment pending)           |

> **Status: not audited, not for mainnet funds.** v0.1.1 is a fresh deployment
> under the program ID above. An earlier v0.1.0 build at
> `DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY` was deployed by another team; this repository
> neither controls nor upgrades it. Read
> [Backend withdraw flow](#backend-withdraw-flow) and [Known limitations](#known-limitations)
> before building on it.

---

## Contents

1. [Repository layout](#repository-layout)
2. [Architecture](#architecture)
3. [The three keys you must understand](#the-three-keys-you-must-understand)
4. [Step-by-step: deploy from a fresh clone](#step-by-step-deploy-from-a-fresh-clone)
5. [Step-by-step: create and register the admin key](#step-by-step-create-and-register-the-admin-key)
6. [Using the admin key in a backend (`ADMIN_SECRET_KEY`)](#using-the-admin-key-in-a-backend-admin_secret_key)
7. [Deploying under a new program ID](#deploying-under-a-new-program-id)
8. [Upgrading the deployed program](#upgrading-the-deployed-program)
9. [Mainnet checklist](#mainnet-checklist)
10. [Instruction reference](#instruction-reference)
11. [Events and errors](#events-and-errors)
12. [Frontend (`casinovault-frontend/`)](#frontend-casinovault-frontend)
13. [Local tests](#local-tests)
14. [Troubleshooting](#troubleshooting)
15. [Trust model](#trust-model)
16. [Known limitations](#known-limitations)

---

## Repository layout

```
.
├── Anchor.toml                 # clusters, program IDs, provider wallet path
├── Cargo.toml / Cargo.lock     # Rust workspace (lockfile pinned to v3, see Troubleshooting)
├── programs/casino_vault/      # the on-chain program (Rust / Anchor)
│   └── src/
│       ├── lib.rs              # declare_id! + instruction entrypoints
│       ├── instructions/       # initialize, deposit, withdraw, set_paused
│       ├── state.rs            # VaultState
│       ├── events.rs / errors.rs / constants.rs / utils.rs
├── programs/cpi_probe/         # TEST FIXTURE ONLY: forwards vault calls via CPI; never deploy
├── scripts/                    # CLI scripts (read / initialize / deposit / withdraw / set_paused)
├── tests/                      # anchor test integration suite
├── casinovault-frontend/       # Next.js reference UI (deposit + admin co-signed withdraw)
├── .github/workflows/ci.yml    # CI: clippy, cargo + anchor tests, IDL drift, frontend build
├── SECURITY.md                 # vulnerability reporting, key powers, accepted advisories
├── CONTRIBUTING.md / CODE_OF_CONDUCT.md / CHANGELOG.md / LICENSE (MIT)
├── keys/                       # admin keypair lives here — GIT-IGNORED, never committed
└── wallet.json                 # deployer / upgrade-authority keypair — GIT-IGNORED
```

Files that are **never** committed (see `.gitignore`): `wallet.json`, `keys/`,
`*-keypair.json`, `target/` (which contains `target/deploy/casino_vault-keypair.json`),
`.anchor/`, `node_modules/`, and every `.env*` file except `.env.example`.

---

## Architecture

```
User wallet ──deposit──> Pool Vault PDA ──withdraw (user + admin)──> User wallet
House wallet ─deposit──>  (all funds)
                              │
                       Deposit / Withdraw events
                              │
                              v
                     Backend listener ──> Database (balances)
```

| PDA         | Seeds             | Owner          | Contents                |
| ----------- | ----------------- | -------------- | ----------------------- |
| Vault state | `["vault_state"]` | This program   | `VaultState` (42 bytes) |
| Pool vault  | `["pool_vault"]`  | System Program | All SOL, no data        |

```rust
pub struct VaultState {
    pub admin: Pubkey,   // backend authority; approves withdrawals, owns pause
    pub vault_bump: u8,  // canonical bump of ["pool_vault"]
    pub paused: bool,    // emergency switch
}
```

---

## The three keys you must understand

| Key                    | File                                      | Role                                                                                       | Lose it and…                                                     |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| **Deployer / upgrade** | `wallet.json`                             | Pays to upload the program. Becomes the program's **upgrade authority**.                   | You can never upgrade or close the program.                      |
| **Program keypair**    | `target/deploy/casino_vault-keypair.json` | Its pubkey **is** the program ID. Only needed for the first deploy to that address.        | You cannot deploy fresh to the same address (upgrades still work). |
| **Admin**              | `keys/admin.json`                         | Written into `VaultState.admin` by `initialize`. Co-signs every withdrawal, owns pause.    | Withdrawals and pause are permanently frozen.                    |

All three are secrets. Back them up offline (password manager / encrypted
drive / hardware wallet / multisig for mainnet) **before** you deploy. Use three
different keypairs — do not reuse the deployer as the admin in production.

---

## Step-by-step: deploy from a fresh clone

These steps take you from `git clone` to a live, initialized vault on devnet.

### Step 1 — Install the toolchain

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Solana / Agave CLI 2.3.13
sh -c "$(curl -sSfL https://release.anza.xyz/v2.3.13/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Anchor 0.32.1 via avm
cargo install --git https://github.com/coral-xyz/anchor --tag v0.32.1 avm --locked --force
avm install 0.32.1 && avm use 0.32.1

# Node.js >= 20 (https://nodejs.org)
```

Verify:

```bash
solana --version   # solana-cli 2.3.13
anchor --version   # anchor-cli 0.32.1
```

### Step 2 — Clone

```bash
git clone https://github.com/X2C-fun/casinovaultinfra.git
cd casinovaultinfra
npm install
```

### Step 3 — Create the deployer wallet (`wallet.json`)

`Anchor.toml` points `[provider] wallet = "wallet.json"`. This wallet pays for
the program upload and becomes the upgrade authority.

```bash
solana-keygen new -o wallet.json --no-bip39-passphrase
solana-keygen pubkey wallet.json          # note this address

solana config set --url https://api.devnet.solana.com
solana config set --keypair ./wallet.json

solana airdrop 5
solana balance                            # program upload needs ~2–3 SOL
```

Devnet airdrops are rate-limited. If `solana airdrop` fails, use
https://faucet.solana.com and paste the `wallet.json` pubkey.

> Already have a deployer keypair (e.g. the original team's `wallet.json`)?
> Copy it into the repo root instead of generating a new one. It is git-ignored.

### Step 4 — Decide the program ID

`target/` is not in git, so a fresh clone has **no**
`target/deploy/casino_vault-keypair.json`.

- **Upgrading this repository's devnet program
  (`EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7`)** — you need its upgrade
  authority keypair. Do **not** run `anchor deploy`: a fresh
  clone's generated `target/deploy/casino_vault-keypair.json` is a different
  key, so it would create a new program at a random address. Build (Step 5),
  then follow [Upgrading the deployed program](#upgrading-the-deployed-program)
  instead of Step 6.
- **Deploying your own copy** — follow
  [Deploying under a new program ID](#deploying-under-a-new-program-id) first,
  then come back to Step 5.

### Step 5 — Build

```bash
anchor build
```

This produces:

- `target/deploy/casino_vault.so` — the program binary
- `target/idl/casino_vault.json` — the IDL
- `target/types/casino_vault.ts` — TypeScript types the `scripts/` import

> The `scripts/` and `tests/` import `../target/types/casino_vault`, so run
> `anchor build` before any `npm run …` script.

### Step 6 — Deploy to devnet

Only for a program ID whose keypair you hold (a new deployment). To change
the existing devnet program, use [Upgrading](#upgrading-the-deployed-program).

```bash
anchor deploy -p casino_vault --provider.cluster devnet
# or: npm run deploy:devnet
```

`-p casino_vault` matters: a plain `anchor deploy` also deploys
`programs/cpi_probe`, a test fixture.

Confirm it is on-chain and that the upgrade authority is your `wallet.json`:

```bash
solana program show <PROGRAM_ID> --url https://api.devnet.solana.com
```

### Step 7 — Create the admin key and initialize

Do this **immediately** after deploy. Follow
[Step-by-step: create and register the admin key](#step-by-step-create-and-register-the-admin-key).

### Step 8 — Smoke test

```bash
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET=./keys/admin.json

npm run read                 # admin = your admin pubkey, paused = false
npm run deposit -- 0.5       # house bankroll into the pool
npm run withdraw -- 0.1      # admin signs as both user and admin
npm run read                 # pool balance reflects the moves
```

Explorer: https://explorer.solana.com/?cluster=devnet — paste the program ID or
any tx signature.

---

## Step-by-step: create and register the admin key

The admin is **not** configured in `Anchor.toml` or in the program source. It is
set on-chain by the `initialize` instruction:

> **Whoever signs `initialize` becomes `VaultState.admin` permanently.** There
> is no `update_admin` instruction yet; changing admin needs a program upgrade.

### 1. Generate a dedicated admin keypair

Never use a player wallet or the deployer wallet for this.

```bash
mkdir -p keys
solana-keygen new -o keys/admin.json --no-bip39-passphrase
solana-keygen pubkey keys/admin.json
```

Write the printed pubkey down — this is your **admin address**.

`keys/admin.json` is a JSON array of 64 numbers (the full secret key):

```json
[12,34,56, ... 64 numbers total ... ,78]
```

If the file is empty, `[]`, or has fewer than 64 numbers, it is not a valid
keypair — regenerate it with the command above.

### 2. Back it up

Copy `keys/admin.json` to secure offline storage now. If it is lost after
`initialize`, withdrawals and pause are frozen forever.

### 3. Fund the admin

`initialize` pays rent for both PDAs (~0.002 SOL). The admin does **not** pay
fees for player withdrawals — the user is the fee payer, both in the reference
API route and in `scripts/withdraw.ts` with `ADMIN_WALLET`. The admin pays only
when it is also the recipient (house withdrawals).

```bash
solana airdrop 2 $(solana-keygen pubkey keys/admin.json) --url https://api.devnet.solana.com
solana balance $(solana-keygen pubkey keys/admin.json) --url https://api.devnet.solana.com
```

### 4. Run `initialize` signed by the admin

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=./keys/admin.json \
npm run initialize
```

The script refuses to run twice and prints a warning if the on-chain admin does
not match your wallet.

### 5. Verify

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=./keys/admin.json \
npm run read
```

`admin:` must equal `solana-keygen pubkey keys/admin.json`. If it does not,
someone else initialized the vault first — **do not accept deposits**; redeploy
under a new program ID.

### Rules

- `initialize` runs **once** per program ID. A second call fails with
  "account already in use".
- Send `initialize` right after deploy. The current program lets **any**
  signer initialize, so whoever lands first becomes admin (see
  [Known limitations](#known-limitations)).
- Before routing real money, every backend should assert
  `vault_state.admin == <expected admin pubkey>` at startup.

---

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
node -e "const bs58=require('bs58');const k=require('./keys/admin.json');console.log((bs58.default||bs58).encode(Uint8Array.from(k)))"
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

## Deploying under a new program ID

Use this when you deploy your own copy (new cluster, new environment, or the
original program keypair is unavailable).

```bash
# 1. Build once — Anchor generates target/deploy/casino_vault-keypair.json if missing
anchor build

# 2. Read the new program ID
solana-keygen pubkey target/deploy/casino_vault-keypair.json

# 3. Write it into declare_id! and Anchor.toml automatically
anchor keys sync
```

`anchor keys sync` updates `programs/casino_vault/src/lib.rs` and
`Anchor.toml`. Update the remaining hardcoded references by hand:

| File                                          | What to change            |
| --------------------------------------------- | ------------------------- |
| `casinovault-frontend` env                    | `NEXT_PUBLIC_VAULT_PROGRAM_ID` (read by `src/lib/constants.ts`; falls back to the devnet demo ID) |
| Your own backend                              | wherever it configures the program ID |

Then rebuild (the ID is compiled into the binary), deploy, and initialize:

```bash
anchor build
anchor deploy -p casino_vault --provider.cluster devnet
# then: create admin + initialize (section above)
```

Copy the new IDL into the frontend:

```bash
cp target/idl/casino_vault.json casinovault-frontend/src/idl/casino_vault.json
cp target/types/casino_vault.ts casinovault-frontend/src/idl/casino_vault.ts
```

Back up `target/deploy/casino_vault-keypair.json` — `target/` is git-ignored.

---

## Upgrading the deployed program

Only the upgrade authority (`wallet.json` that deployed it) can upgrade.

A program account has a fixed size. If the new `.so` is larger than the
deployed one, the upgrade is rejected until you extend the account. Compare
`solana program show <PROGRAM_ID>` (`Data Length`) with
`ls -l target/deploy/casino_vault.so`, and extend by at least the difference:

```bash
solana program extend <PROGRAM_ID> <ADDITIONAL_BYTES> \
  --url https://api.devnet.solana.com
```

```bash
anchor build
anchor upgrade target/deploy/casino_vault.so \
  --program-id EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7 \
  --provider.cluster devnet
```

`VaultState` and the pool balance survive upgrades. Do **not** change the
`VaultState` layout or PDA seeds without a migration plan.

Rotate the upgrade authority (for example, to a multisig):

```bash
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <NEW_AUTHORITY_PUBKEY> \
  --url https://api.devnet.solana.com
```

Make the program immutable (irreversible):

```bash
solana program set-upgrade-authority <PROGRAM_ID> --final --url <RPC_URL>
```

---

## Mainnet checklist

1. Separate keypairs for deployer, program, and admin — none reused from devnet.
2. Upgrade authority moved to a multisig (e.g. Squads) after deploy.
3. Admin key in an HSM / KMS or a dedicated signer service, not a plain env file
   on a shared machine.
4. `anchor build --verifiable` and publish the verified build hash.
5. Set `Anchor.toml` `[programs.mainnet]` and use a paid RPC (Helius, Triton,
   QuickNode, Alchemy).
6. Fund the deployer with enough SOL for the program upload (check
   `solana rent <bytes>` against the `.so` size, ×2 buffer).
7. Deploy → `initialize` with the admin in the same session → `npm run read`
   to confirm admin.
8. Backend asserts on-chain admin at startup and reconciles
   `pool balance` vs `sum(db balances) + house bankroll + rent reserve`.
9. Rehearse `set_paused true/false` before going live.

---

## Instruction reference

| Instruction  | Args           | Who signs        | What it does                                   |
| ------------ | -------------- | ---------------- | ---------------------------------------------- |
| `initialize` | —              | **admin**        | Creates PDAs, sets `admin`, parks rent reserve |
| `deposit`    | `amount: u64`  | **depositor**    | Wallet → pool, emits `DepositEvent`            |
| `withdraw`   | `amount: u64`  | **user + admin** | Pool → user, emits `WithdrawEvent`             |
| `set_paused` | `paused: bool` | **admin**        | Freezes / unfreezes deposits and withdrawals   |

Amounts are **lamports** (`1 SOL = 1_000_000_000`). The CLI scripts take SOL and
convert.

All scripts read two env vars:

| Variable              | Example                         |
| --------------------- | ------------------------------- |
| `ANCHOR_PROVIDER_URL` | `https://api.devnet.solana.com` |
| `ANCHOR_WALLET`       | `./keys/admin.json`             |

### `initialize` — create vault + set admin

Accounts: `admin` (signer, payer), `vault_state`, `pool_vault`, `system_program`

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=./keys/admin.json npm run initialize
```

```ts
await program.methods
  .initialize()
  .accountsPartial({ admin: adminPubkey, vaultState, poolVault, systemProgram: SystemProgram.programId })
  .signers([adminKeypair])
  .rpc();
```

One-shot setup. Pays rent for both PDAs. Emits `VaultInitializedEvent`. Fails if
already initialized.

### `deposit` — fund the pool

Accounts: `depositor` (signer), `vault_state`, `pool_vault`, `system_program`

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=./keys/player.json npm run deposit -- 0.25
```

```ts
await program.methods
  .deposit(new BN(250_000_000)) // 0.25 SOL
  .accountsPartial({ depositor: playerPubkey, vaultState, poolVault, systemProgram: SystemProgram.programId })
  .signers([playerKeypair])
  .rpc();
```

Anyone may deposit; the backend credits `DepositEvent.user`. Rejects
`amount == 0`, insufficient balance, overflow, or `paused == true`. There is no
on-chain per-user balance.

Must be a top-level instruction. A deposit forwarded by another program (a
multisig, router or smart wallet) fails with `CpiNotAllowed` (6006), because
Anchor's event parser cannot see events from a CPI'd call and the deposit
would never be credited. A multisig can still top up the bankroll with a plain
System transfer to the pool PDA; that is uncredited by design (see the
reconciliation step in the [Mainnet checklist](#mainnet-checklist)).

### `withdraw` — release SOL (admin-approved)

Accounts: `user` (signer, recipient), `admin` (signer), `vault_state`,
`pool_vault`, `system_program`

```bash
# Player withdraw with admin co-sign
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=./keys/player.json \
ADMIN_WALLET=./keys/admin.json \
npm run withdraw -- 0.1

# House withdraw (admin is both user and admin)
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=./keys/admin.json npm run withdraw -- 0.1
```

```ts
await program.methods
  .withdraw(new BN(100_000_000)) // 0.1 SOL
  .accountsPartial({ user: playerPubkey, admin: adminPubkey, vaultState, poolVault, systemProgram: SystemProgram.programId })
  .signers([playerKeypair, adminKeypair])
  .rpc();
```

- Requires **both** signatures; a user alone cannot drain the pool.
- Must be a top-level instruction; CPI fails with `CpiNotAllowed` (6006).
- Funds always go to the signing `user` (no destination parameter).
- Capped at pool balance minus the rent reserve.
- Emits `WithdrawEvent`; debit the DB only **after** confirmation.
- Fails if admin ≠ `VaultState.admin`, amount is 0, insufficient funds, or paused.

### `set_paused` — emergency switch

Accounts: `admin` (signer), `vault_state`

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=./keys/admin.json npm run set-paused -- true
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=./keys/admin.json npm run set-paused -- false
```

```ts
await program.methods.setPaused(true).accountsPartial({ admin: adminPubkey, vaultState }).signers([adminKeypair]).rpc();
```

While paused, `deposit` and `withdraw` return `VaultPaused` (6005). Emits
`PauseStateChangedEvent`.

### Reads (no instruction — plain RPC fetches)

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

### Backend withdraw flow

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
3. Fetch a blockhash and build the `withdraw` transaction yourself: exactly
   one `withdraw` instruction, the user's wallet as `user` and fee payer.
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
  reconciliation in the [Mainnet checklist](#mainnet-checklist) covers the
  difference.

The reference frontend's demo route (`/api/withdraw`) has no ledger, so it
skips the hold entirely; it is not an implementation of this flow.

---

## Events and errors

| Event                    | Fields                                                  |
| ------------------------ | ------------------------------------------------------- |
| `VaultInitializedEvent`  | `admin`, `vault_bump`, `rent_reserve`, `timestamp`      |
| `DepositEvent`           | `user`, `amount`, `vault_balance`, `timestamp`          |
| `WithdrawEvent`          | `user`, `admin`, `amount`, `vault_balance`, `timestamp` |
| `PauseStateChangedEvent` | `admin`, `paused`, `timestamp`                          |

| Code | Name                      | Meaning                          |
| ---- | ------------------------- | -------------------------------- |
| 6000 | `Unauthorized`            | Wrong admin                      |
| 6001 | `InvalidAmount`           | Zero amount                      |
| 6002 | `InsufficientFunds`       | Not enough lamports              |
| 6003 | `VaultAlreadyInitialized` | Client mapping for init race     |
| 6004 | `MathOverflow`            | Checked math overflow            |
| 6005 | `VaultPaused`             | Deposits / withdrawals suspended |
| 6006 | `CpiNotAllowed`           | `deposit` / `withdraw` called via CPI |

The rent reserve — whatever `getMinimumBalanceForRentExemption(0)` returns on
that cluster — stays in the pool permanently.
**Never credit it as user balance.** The program and scripts read it dynamically.

Events are emitted with `emit!`, i.e. into program logs. The runtime truncates
logs at 10 KB per transaction. A plain vault instruction never comes close, but
a composed transaction (many instructions, or another program CPI-ing in) can,
and a log-only listener would then miss the event. Index by transaction and
decode instruction data as a fallback.

---

## Frontend (`casinovault-frontend/`)

Next.js reference UI: connect wallet, read pool status, deposit, and withdraw
with server-side admin co-signing via `/api/withdraw`.

> **The withdraw route is a demo.** It has no user accounts or balances, so it
> would co-sign a withdrawal for anyone. It returns **501** unless you set
> `VAULT_DEMO_UNSAFE_WITHDRAW=true`, and even then caps each request at
> `VAULT_DEMO_MAX_WITHDRAW_SOL` (default 0.1) and rate-limits per wallet and per
> client (see `VAULT_DEMO_TRUSTED_PROXY_HOPS`). Never
> enable it with a funded mainnet admin key. A real backend follows
> [Backend withdraw flow](#backend-withdraw-flow).

```bash
cd casinovault-frontend
cp .env.example .env.local
# devnet demo only: set ADMIN_SECRET_KEY and VAULT_DEMO_UNSAFE_WITHDRAW=true
npm install
npm run dev        # http://localhost:3000
```

| Variable                       | Where       | Purpose                                              |
| ------------------------------ | ----------- | ---------------------------------------------------- |
| `NEXT_PUBLIC_SOLANA_RPC_URL`   | browser     | RPC endpoint; shipped to every browser, so no API keys |
| `SOLANA_RPC_URL`               | server only | RPC for `/api/withdraw` (may carry a key); falls back to the public one |
| `NEXT_PUBLIC_SOLANA_CLUSTER`   | browser     | `devnet` / `mainnet-beta` for explorer links         |
| `NEXT_PUBLIC_VAULT_PROGRAM_ID` | browser     | Your program ID (defaults to the devnet demo)        |
| `ADMIN_SECRET_KEY`             | server only | Admin keypair; co-signs withdrawals                  |
| `VAULT_DEMO_UNSAFE_WITHDRAW`   | server only | Must be `true` to enable the demo withdraw route     |
| `VAULT_DEMO_MAX_WITHDRAW_SOL`  | server only | Per-request cap for the demo route (default `0.1`)   |
| `VAULT_DEMO_TRUSTED_PROXY_HOPS` | server only | Proxies that append to `X-Forwarded-For` (Vercel `1`); `0` = one shared rate-limit bucket |

Before asking the wallet to sign, the UI decodes the server's transaction and
refuses anything other than a single `withdraw` of the requested amount to the
connected wallet, with the connected wallet as fee payer
(`src/lib/withdrawTx.ts`). Integrators should keep that check.

See `casinovault-frontend/README.md` for details.

---

## Local tests

`anchor test` needs a provider wallet at `wallet.json` (see `Anchor.toml`).
Any keypair works on localnet:

```bash
[ -f wallet.json ] || solana-keygen new -o wallet.json --no-bip39-passphrase
anchor test      # spins up a local validator and runs the integration suite
```

---

## Troubleshooting

### `lock file version 4` during `anchor build`

```text
lock file version 4 was found, but this version of Cargo does not understand this lock file
```

Host Cargo rewrote `Cargo.lock` as v4, which Solana platform-tools (Cargo 1.84)
cannot read. Regenerate and pin back to v3:

```bash
rm -f Cargo.lock
cargo +nightly generate-lockfile -Zmsrv-policy \
  --config 'resolver.incompatible-rust-versions="fallback"'
# edit Cargo.lock: change `version = 4` → `version = 3`
anchor build
```

Commit the fixed `Cargo.lock`. Avoid a bare `cargo update` on a newer host.

### `Cannot find module '../target/types/casino_vault'`

Run `anchor build` first; `target/` is not committed.

### `ANCHOR_PROVIDER_URL is not set` / `ANCHOR_WALLET is not set`

Export both before running any `npm run` script (see
[Instruction reference](#instruction-reference)).

### `Admin mismatch` / `ADMIN_SECRET_KEY does not match on-chain admin`

The key you are signing with is not the one that ran `initialize`. Run
`npm run read` to see the on-chain admin.

### `Blockhash not found` / `429 Too Many Requests`

Public devnet RPC is flaky; scripts retry automatically. For anything serious
use a dedicated RPC URL in `ANCHOR_PROVIDER_URL`.

### `insufficient funds` on deploy

Top up `wallet.json` — program upload needs a few SOL on devnet.

---

## Trust model

The program guarantees only:

1. Pool lamports move only through this program.
2. Withdrawals need **user + admin** signatures.
3. Payouts go only to the signing user.

The admin key can approve any withdrawal to any cooperating wallet. Protect it
like the entire pool balance.

---

## Known limitations

None of these is a bug in the current code; each is a property a reusable
custody protocol should have and this program (v0.1) does not yet.

| Limitation | Impact | Planned change |
| ---------- | ------ | -------------- |
| `initialize` can be front-run | Whoever lands `initialize` first owns the vault. | Require the signer to be the program's upgrade authority. |
| No admin rotation | A leaked admin can unpause as easily as you can pause; recovery needs a program upgrade. | Two-step `propose_admin` / `accept_admin`, controlled by the upgrade authority. |
| No request ID on `withdraw` | Backends must hold balances at approval time, allow one open hold per user, and match events by user (see above). | `request_id: u64` argument echoed in `WithdrawEvent`. |
| Single hot admin key, no on-chain limits | A backend compromise can drain the pool. | Optional per-transaction / per-epoch cap in `VaultState`. |
| Events only in logs | Log truncation in large composed transactions can hide events. | `emit_cpi!`, or decode instruction data in the listener. |
