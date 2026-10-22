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
│       ├── instructions/       # initialize, deposit, withdraw, set_paused, admin (rotation + caps)
│       ├── state.rs            # VaultState
│       ├── events.rs / errors.rs / constants.rs / utils.rs
├── programs/cpi_probe/         # TEST FIXTURE ONLY: forwards vault calls via CPI; never deploy
├── reference/casino_fair/      # VRF coin-flip reference; standalone crate (own Cargo.lock), not built by `anchor build`
├── packages/sdk/               # @x2c-fun/casinovault-sdk: TypeScript SDK (publishable)
├── packages/backend/           # reference settlement backend (private, not published)
├── scripts/                    # CLI scripts (read / initialize / deposit / withdraw / set_paused / propose_admin / accept_admin / set_limits)
├── tests/                      # anchor test integration suite
├── casinovault-frontend/       # Next.js reference UI (deposit + admin co-signed withdraw)
├── docs/                       # architecture, deployment, backend integration, reference, fairness, releasing, troubleshooting
├── AGENTS.md                   # orientation and rules for coding agents (and humans)
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

| PDA             | Seeds                   | Owner          | Contents                 |
| --------------- | ----------------------- | -------------- | ------------------------ |
| Vault state     | `["vault_state_v2"]`    | This program   | `VaultState` (175 bytes) |
| Pool vault      | `["pool_vault"]`        | System Program | All SOL, no data         |
| Event authority | `["__event_authority"]` | —              | Signs `emit_cpi!` events |

```rust
pub struct VaultState {
    pub admin: Pubkey,                 // backend authority; approves withdrawals, owns pause
    pub vault_bump: u8,                // canonical bump of ["pool_vault"]
    pub paused: bool,                  // emergency switch
    pub pending_admin: Option<Pubkey>, // proposed by the upgrade authority
    pub max_withdraw_per_tx: u64,      // 0 = no cap
    pub max_withdraw_per_window: u64,  // 0 = no cap
    pub window_seconds: u32,           // window length for the cap above
    pub window_start: i64,             // unix time the current window began
    pub window_withdrawn: u64,         // lamports withdrawn in the current window
    pub reserved: [u8; 64],            // room for future fields
}
```

The upgrade authority controls who the admin is and how much can leave the
pool; the admin approves individual withdrawals and can pause.

---

## The three keys you must understand

| Key                    | File                                      | Role                                                                                       | Lose it and…                                                     |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| **Deployer / upgrade** | `wallet.json`                             | Pays to upload the program. Becomes the **upgrade authority**: runs `initialize`, rotates the admin, sets withdrawal caps. | You can never upgrade the program, rotate the admin, or change caps. |
| **Program keypair**    | `target/deploy/casino_vault-keypair.json` | Its pubkey **is** the program ID. Only needed for the first deploy to that address.        | You cannot deploy fresh to the same address (upgrades still work). |
| **Admin**              | `keys/admin.json`                         | Written into `VaultState.admin` by `initialize`. Co-signs every withdrawal, owns pause.    | Withdrawals stop until the upgrade authority rotates in a new admin. |

All three are secrets. Back them up offline (password manager / encrypted
drive / hardware wallet / multisig for mainnet) **before** you deploy. Use three
different keypairs — do not reuse the deployer as the admin in production.

---

## Trust model

The program guarantees only:

1. Pool lamports move only through this program.
2. Withdrawals need **user + admin** signatures.
3. Payouts go only to the signing user.
4. Only the upgrade authority can initialize, rotate the admin, or change caps.
5. If caps are set, no single withdrawal exceeds the per-transaction cap, and
   withdrawals inside one window never total more than the window cap. Across
   a window boundary they can total up to twice the window cap (see
   [Known limitations](#known-limitations)).

The admin key can still approve any withdrawal within the caps to any
cooperating wallet; protect it accordingly. The upgrade authority can replace
the program outright, so it is the real root of trust — put it in a multisig
or make the program immutable once you are confident in it.

---

## Known limitations

v0.2 closed the earlier limitations: `initialize` is restricted to the
upgrade authority, the admin can be rotated, `withdraw` carries a
`request_id`, withdrawals can be capped on-chain, and deposit and withdraw
events are also emitted with `emit_cpi!`. What remains:

| Limitation | Impact | Mitigation |
| ---------- | ------ | ---------- |
| Upgrade authority is all-powerful | It can ship new code that moves every lamport. | Multisig (e.g. Squads) with a timelock, or `--final` once stable. Immutable programs cannot rotate admins or change caps. |
| `request_id` is not enforced unique | Two approvals with the same ID both succeed on-chain. | Uniqueness belongs to the backend's hold table (primary key). |
| Admin can unpause | A leaked admin can undo a pause. | Rotate the admin (one transaction) instead of relying on pause alone. |
| Direct transfers emit nothing | SOL sent to the pool with a System transfer has no `DepositEvent`. | Never credit from balance changes; reconcile (Mainnet checklist). |
| Not audited | — | Get an independent audit before holding mainnet funds. |
| Admin must be a keypair | `deposit` and `withdraw` must be top-level instructions, so a multisig (e.g. Squads) or PDA admin, which signs through CPI, cannot approve withdrawals. `set_paused` still works from a multisig. | Keep the admin in an HSM/KMS or signer service; use a multisig for the upgrade authority. |
| Window cap is tumbling | A window opens at the first withdrawal after the previous one expired, not at fixed times, so withdrawals at the end of one window and the start of the next can total up to twice `max_withdraw_per_window`. A leaked admin key can take one window's cap per window, indefinitely, until it is rotated. | Set the window cap to half the largest loss you can absorb in a window, alert on every unmatched `WithdrawEvent`, and rotate the admin as soon as one appears. |
