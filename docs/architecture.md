# Architecture and trust model

How the program is laid out, which keys control what, what the program
guarantees, and what it deliberately does not do yet.

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
├── docs/                       # architecture, deployment, backend integration, reference, troubleshooting
├── .github/                    # CI workflow, Dependabot, issue / PR templates, CODEOWNERS
├── SECURITY.md                 # vulnerability reporting, key powers, accepted advisories
├── CONTRIBUTING.md / CODE_OF_CONDUCT.md / CHANGELOG.md / LICENSE (MIT)
├── keys/                       # admin, deployer and test keypairs — GIT-IGNORED, never committed
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

| Limitation | Impact | Possible future change |
| ---------- | ------ | -------------- |
| `initialize` can be front-run | Whoever lands `initialize` first owns the vault. | Require the signer to be the program's upgrade authority. |
| No admin rotation | A leaked admin can unpause as easily as you can pause; recovery needs a program upgrade. | Two-step `propose_admin` / `accept_admin`, controlled by the upgrade authority. |
| No request ID on `withdraw` | Backends must hold balances at approval time, allow one open hold per user, and match events by user (see above). | `request_id: u64` argument echoed in `WithdrawEvent`. |
| Single hot admin key, no on-chain limits | A backend compromise can drain the pool. | Optional per-transaction / per-epoch cap in `VaultState`. |
| Events only in logs | Log truncation in large composed transactions can hide events. | `emit_cpi!`, or decode instruction data in the listener. |
| Admin must be a keypair | `withdraw` must be a top-level instruction, so a multisig (e.g. Squads) or PDA admin, which signs through CPI, cannot approve withdrawals. `set_paused` still works from a multisig. | Keep the admin in an HSM/KMS or signer service; use a multisig for the upgrade authority. |
