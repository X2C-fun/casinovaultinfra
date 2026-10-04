# Casino Vault Infra — Solana pooled custody program

An Anchor program that holds SOL for a casino backend in **one shared pool**. It
is a custody layer only: it moves SOL in and out under strict authority checks
and emits an event for every change. It knows nothing about balances, bets, wins,
losses, leaderboards, house accounting or game history — all of that lives in the
backend database, which is driven by the events emitted here.

| Item              | Value                                          |
| ----------------- | ---------------------------------------------- |
| Program ID        | `DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY` |
| Anchor            | `0.32.1`                                       |
| Solana / Agave    | `2.3.13`                                       |
| Rust (SBF)        | `1.84.0`, edition 2021                         |
| Deployed clusters | devnet                                         |

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
├── scripts/                    # CLI scripts (read / initialize / deposit / withdraw / set_paused)
├── tests/                      # anchor test integration suite
├── casinovault-frontend/       # Next.js reference UI (deposit + admin co-signed withdraw)
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
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.32.1 && avm use 0.32.1

# Node.js >= 20, then the script/test dependencies
npm install
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

- **Upgrading the existing devnet program
  (`DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY`)** — you need the original
  `wallet.json` (upgrade authority). Skip to Step 5; `anchor deploy` /
  `anchor upgrade` will work against the existing address. See
  [Upgrading the deployed program](#upgrading-the-deployed-program).
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

```bash
anchor deploy --provider.cluster devnet
# or: npm run deploy:devnet
```

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

`initialize` pays rent for both PDAs (~0.002 SOL), and the admin pays fees for
every withdrawal it co-signs.

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
- Send `initialize` right after deploy so nobody front-runs you and becomes
  admin.
- Before routing real money, every backend should assert
  `vault_state.admin == <expected admin pubkey>` at startup.

---

## Using the admin key in a backend (`ADMIN_SECRET_KEY`)

Backends (the Cliffhanger API, `casinovault-frontend/src/app/api/withdraw`)
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
| `scripts/common.ts`                           | `PROGRAM_ID`              |
| `casinovault-frontend/src/lib/constants.ts`   | program ID constant       |
| Any backend env (e.g. `NEXT_PUBLIC_VAULT_PROGRAM_ID`) | new program ID     |

Then rebuild (the ID is compiled into the binary), deploy, and initialize:

```bash
anchor build
anchor deploy --provider.cluster devnet
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

```bash
anchor build
anchor upgrade target/deploy/casino_vault.so \
  --program-id DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY \
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

### Typical backend withdraw flow

1. User requests a withdrawal in your API.
2. Backend checks DB balance, limits, and anti-cheat.
3. Backend builds `withdraw` and partially signs with the **admin** key.
4. User signs in their wallet; the transaction is submitted.
5. On a finalized `WithdrawEvent`, debit the DB.

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

The rent reserve (~890,880 lamports) stays in the pool permanently. **Never
credit it as user balance.**

---

## Frontend (`casinovault-frontend/`)

Next.js reference UI: connect wallet, read pool status, deposit, and withdraw
with server-side admin co-signing via `/api/withdraw`.

```bash
cd casinovault-frontend
cp .env.example .env.local
# set ADMIN_SECRET_KEY to the contents of ../keys/admin.json
npm install
npm run dev        # http://localhost:3000
```

| Variable                     | Where       | Purpose                                     |
| ---------------------------- | ----------- | ------------------------------------------- |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | browser     | RPC endpoint                                |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | browser     | `devnet` / `mainnet-beta` for explorer links |
| `ADMIN_SECRET_KEY`           | server only | Admin keypair; co-signs withdrawals         |

See `casinovault-frontend/README.md` for details.

---

## Local tests

```bash
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
like the entire pool balance. Roadmap: `update_admin`, Ed25519 approvals,
nonces / expiry, on-chain rate limits.
