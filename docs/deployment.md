# Deployment and operations

Deploying from a fresh clone, registering the admin key, deploying under a
new program ID, upgrading, and the checklist before any mainnet use.

## Step-by-step: deploy from a fresh clone

These steps take you from `git clone` to a live, initialized vault on devnet.

### Step 1 — Install the toolchain

On Debian/Ubuntu, install the system packages the Solana and Anchor CLIs
compile against first (the Anchor CLI build fails with "Unable to find
libudev" without them):

```bash
sudo apt-get install -y build-essential pkg-config libudev-dev libssl-dev
```

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Solana / Agave CLI 2.3.13
sh -c "$(curl -sSfL https://release.anza.xyz/v2.3.13/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Anchor 0.32.1 via avm
cargo install --git https://github.com/coral-xyz/anchor --tag v0.32.1 avm --locked --force
avm install 0.32.1 && avm use 0.32.1

# Node.js 22 (as CI; 20.17 or later works) and npm 11 (CI pins 11.21.1)
# https://nodejs.org, then: npm install -g npm@11
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

npm run read                 # admin = your admin pubkey, paused = true, your caps
npm run set-paused -- false  # the vault starts paused; the admin opens it
npm run deposit -- 0.5       # house bankroll into the pool
npm run withdraw -- 0.1 1   # admin signs as user and admin; 1 = request_id
npm run read                 # pool balance reflects the moves
```

Explorer: https://explorer.solana.com/?cluster=devnet — paste the program ID or
any tx signature.

---

## Step-by-step: create and register the admin key

The admin is **not** configured in `Anchor.toml` or in the program source. It is
set on-chain by the `initialize` instruction, which only the program's
**upgrade authority** (`wallet.json`) can send. The admin co-signs to prove it
controls the key. Later changes go through
[`propose_admin` / `accept_admin`](reference.md#propose_admin--accept_admin--rotate-the-admin).

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

The upgrade authority pays the rent in `initialize` (~0.002 SOL). The admin does **not** pay
fees for player withdrawals — the user is the fee payer, both in the reference
API route and in `scripts/withdraw.ts` with `ADMIN_WALLET`. The admin pays only
when it is also the recipient (house withdrawals).

```bash
solana airdrop 2 $(solana-keygen pubkey keys/admin.json) --url https://api.devnet.solana.com
solana balance $(solana-keygen pubkey keys/admin.json) --url https://api.devnet.solana.com
```

### 4. Run `initialize` as the upgrade authority, co-signed by the admin

```bash
# Caps as for set-limits: <max_per_tx_sol> <max_per_window_sol> <window_seconds>
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=./wallet.json \
ADMIN_WALLET=./keys/admin.json \
npm run initialize -- 1 5 3600
```

The script sends `initialize`, `set_limits` and `set_paused(true)` in **one**
transaction, so the vault never exists unpaused or without caps. The caps are
required; pass `--no-limits` instead to start without any (withdrawals are then
bounded only by the pool balance). Pass `--unpaused` to skip the pause. It
checks that `ANCHOR_WALLET` is the on-chain upgrade authority and refuses to
run twice.

When the backend is ready, the admin opens the vault:

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=./keys/admin.json \
npm run set-paused -- false
```

### 5. Verify

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=./keys/admin.json \
npm run read
```

`admin:` must equal `solana-keygen pubkey keys/admin.json`, and the caps and
`paused` must be what you asked for.

### Rules

- `initialize` runs **once** per program ID. A second call fails with
  "account already in use".
- Only the upgrade authority can initialize, so nobody can front-run you. Do it
  **before** making the program immutable (`--final`): an immutable program has
  no upgrade authority and can never be initialized.
- Before routing real money, every backend should assert
  `vault_state.admin == <expected admin pubkey>` at startup.

---

## Deploying under a new program ID

Use this when you deploy your own copy (new cluster, new environment, or the
original program keypair is unavailable).

```bash
# 1. Build once — Anchor generates target/deploy/casino_vault-keypair.json if missing
anchor build

# 2. Read the new program ID
solana-keygen pubkey target/deploy/casino_vault-keypair.json

# 3. Write it into declare_id! and Anchor.toml (localnet and devnet sections)
anchor keys sync -p casino_vault
anchor keys sync -p casino_vault --provider.cluster devnet
```

`-p casino_vault` keeps the test fixture `programs/cpi_probe` out of it; a
plain `anchor keys sync` would also rewrite its ID. The two commands update
`programs/casino_vault/src/lib.rs` and the `[programs.localnet]` and
`[programs.devnet]` entries in `Anchor.toml`; check both sections afterwards. Update the remaining hardcoded references by hand:

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

`anchor deploy` also published the IDL on-chain, and `anchor upgrade` does not
update it. After any interface change, upgrade it too, or explorers and
clients that fetch the IDL from chain will decode with the old one:

```bash
anchor idl upgrade --filepath target/idl/casino_vault.json \
  EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7 --provider.cluster devnet
```

`VaultState` and the pool balance survive upgrades. Do **not** change the
`VaultState` layout or PDA seeds without a migration plan; new fields should
come out of `reserved`.

### Upgrading from v0.1.x

v0.2 keeps the pool vault seed (`["pool_vault"]`) and moves the state to a new
seed (`["vault_state_v2"]`), so a v0.1 deployment can be upgraded **in place**
without moving funds:

1. `set_paused true` on v0.1 and stop issuing approvals; let outstanding holds
   expire (see [Backend withdraw flow](backend-integration.md#backend-withdraw-flow)).
2. `anchor build`. The v0.2 binary is about 87 KB larger than v0.1.1 (333,816
   vs 246,816 bytes), so extend the program account first (see above), then
   `anchor upgrade` and `anchor idl upgrade` as above. From this moment every
   instruction fails until step 3 — the v0.1 state account is ignored, not
   misread.
3. Run `npm run initialize -- <max_per_tx_sol> <max_per_window_sol> <window_seconds>`
   with `ANCHOR_WALLET` = upgrade authority and `ADMIN_WALLET` = admin. It
   creates `["vault_state_v2"]` and keeps the existing pool balance (the
   event's `vault_balance` shows it). The v0.1 pause flag does **not** carry
   over, so the same transaction sets the caps and pauses the new state;
   there is no window in which the pool is open without caps. Unpause with
   `npm run set-paused -- false` as the admin once backends are ready.
4. Deploy backends built against the v0.2
   IDL (`withdraw(amount, request_id)`; two extra accounts appended to
   `deposit`/`withdraw`).

If the upgrade authority is already a multisig, `npm run initialize` cannot
sign for it: build the same `initialize`, `set_limits` and `set_paused(true)`
instructions (upgrade authority as `authority`, admin as `admin`) as one
multisig transaction, and have the admin key co-sign the execution.

The old 42-byte `["vault_state"]` account stays behind holding its rent
(`getMinimumBalanceForRentExemption(42)`); it is inert, since every v0.2
instruction derives the `["vault_state_v2"]` address. It shares the
`VaultState` discriminator, though: an off-chain `program.account.vaultState.all()`
or discriminator-filtered `getProgramAccounts` returns it and fails to decode
it. Look the state up by its address instead.

### Upgrade authority

Rotate the upgrade authority (for example, to a multisig). This also hands over
admin rotation and caps:

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
7. Deploy → `npm run initialize -- <caps>` (upgrade authority + admin; sets
   the caps and starts paused in the same transaction) → `npm run read` to
   confirm admin, caps and `paused = true`.
8. Size those caps to what you could lose if the admin key leaked before you
   noticed; change them later with `npm run set-limits`.
9. Backend asserts on-chain admin at startup and reconciles
   `pool balance` vs `sum(db balances) + house bankroll + rent reserve`.
10. Rehearse `set_paused true/false` and an admin rotation before going live.
