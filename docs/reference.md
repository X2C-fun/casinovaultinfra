# Program reference

Every instruction, its accounts and signers, and every event and error code.

## Instruction reference

| Instruction     | Args                                                    | Who signs                         | What it does                                   |
| --------------- | ------------------------------------------------------- | --------------------------------- | ---------------------------------------------- |
| `initialize`    | —                                                       | **upgrade authority + admin**     | Creates state, sets `admin`, parks rent reserve |
| `deposit`       | `amount: u64`                                           | **depositor**                     | Wallet → pool, emits `DepositEvent`            |
| `withdraw`      | `amount: u64`, `request_id: u64`                        | **user + admin**                  | Pool → user, emits `WithdrawEvent`             |
| `set_paused`    | `paused: bool`                                          | **admin**                         | Freezes / unfreezes deposits and withdrawals   |
| `propose_admin` | `new_admin: Option<Pubkey>`                             | **upgrade authority**             | Sets (or clears) the pending admin             |
| `accept_admin`  | —                                                       | **pending admin**                 | Pending admin becomes admin                    |
| `set_limits`    | `max_withdraw_per_tx`, `max_withdraw_per_window`, `window_seconds` | **upgrade authority** | Sets withdrawal caps (`0` = none)              |

Amounts are **lamports** (`1 SOL = 1_000_000_000`). The CLI scripts take SOL and
convert.

All scripts read two env vars:

| Variable              | Example                         |
| --------------------- | ------------------------------- |
| `ANCHOR_PROVIDER_URL` | `https://api.devnet.solana.com` |
| `ANCHOR_WALLET`       | `./keys/admin.json`             |

The `program_data`, `event_authority` and `program` accounts are derived
automatically by the Anchor client; you never pass them by hand.

### `initialize` — create vault + set admin

Accounts: `authority` (signer, payer — must be the upgrade authority), `admin`
(signer), `program_data`, `vault_state`, `pool_vault`, `system_program`

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=./wallet.json ADMIN_WALLET=./keys/admin.json npm run initialize
```

```ts
await program.methods
  .initialize()
  .accountsPartial({ authority: upgradeAuthority, admin: adminPubkey, vaultState, poolVault, systemProgram: SystemProgram.programId })
  .signers([upgradeAuthorityKeypair, adminKeypair])
  .rpc();
```

One-shot setup. Fails with `NotUpgradeAuthority` (6007) for any other signer and
"already in use" if already initialized. Tops the pool up to the rent reserve
only if it holds less. Emits `VaultInitializedEvent`.

### `deposit` — fund the pool

Accounts: `depositor` (signer), `vault_state`, `pool_vault`, `system_program`,
`event_authority`, `program`

The examples below use a test player wallet. Create and fund one first (it
lives under the git-ignored `keys/`):

```bash
solana-keygen new -o keys/player.json --no-bip39-passphrase
solana airdrop 1 $(solana-keygen pubkey keys/player.json) --url https://api.devnet.solana.com
```

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
reconciliation step in the [Mainnet checklist](deployment.md#mainnet-checklist)).

### `withdraw` — release SOL (admin-approved)

Accounts: `user` (signer, recipient), `admin` (signer), `vault_state`
(writable — tracks the cap window), `pool_vault`, `system_program`,
`event_authority`, `program`

Instruction data: 8-byte discriminator, `amount` (u64 LE), `request_id`
(u64 LE) — 24 bytes.

```bash
# Player withdraw with admin co-sign; optional second arg is the request_id
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=./keys/player.json \
ADMIN_WALLET=./keys/admin.json \
npm run withdraw -- 0.1 1001

# House withdraw (admin is both user and admin)
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=./keys/admin.json npm run withdraw -- 0.1
```

```ts
await program.methods
  .withdraw(new BN(100_000_000), new BN(holdId)) // 0.1 SOL, backend hold ID
  .accountsPartial({ user: playerPubkey, admin: adminPubkey, vaultState, poolVault, systemProgram: SystemProgram.programId })
  .signers([playerKeypair, adminKeypair])
  .rpc();
```

- Requires **both** signatures; a user alone cannot drain the pool.
- Must be a top-level instruction; CPI fails with `CpiNotAllowed` (6006).
- Funds always go to the signing `user` (no destination parameter).
- Capped at pool balance minus the rent reserve, and by any caps from
  `set_limits` (house withdrawals included).
- `request_id` is echoed in `WithdrawEvent`; the program does not enforce
  uniqueness — the backend's hold table does.
- Fails if admin ≠ `VaultState.admin`, amount is 0, insufficient funds, paused,
  `WithdrawLimitExceeded` or `WindowLimitExceeded`.

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

### `propose_admin` / `accept_admin` — rotate the admin

Accounts: `propose_admin` — `authority` (signer, upgrade authority),
`program_data`, `vault_state`. `accept_admin` — `new_admin` (signer),
`vault_state`.

```bash
# 1. Upgrade authority proposes (use `none` to cancel)
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=./wallet.json \
npm run propose-admin -- <NEW_ADMIN_PUBKEY>

# 2. The new admin accepts (needs a little SOL for the fee)
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=./keys/new-admin.json \
npm run accept-admin
```

The old admin keeps working until the new one accepts, so a typo in the
proposal can't lock the vault. The admin itself **cannot** propose: if the
admin key leaks, the attacker cannot rotate itself in or block recovery. For an
incident, put both instructions in one transaction signed by the upgrade
authority and the replacement key (see the "recovers from a leaked admin" test).
Emits `AdminProposedEvent` and `AdminChangedEvent`.

### `set_limits` — on-chain withdrawal caps

Accounts: `authority` (signer, upgrade authority), `program_data`,
`vault_state`

```bash
# At most 5 SOL per withdrawal and 50 SOL per hour; `0 0 0` removes all caps
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=./wallet.json \
npm run set-limits -- 5 50 3600
```

- `max_withdraw_per_tx` bounds a single withdrawal.
- `max_withdraw_per_window` bounds the total over a tumbling window of
  `window_seconds`: the first withdrawal after the window expires starts a new
  one. Both must be zero or both non-zero (`InvalidLimits`).
- Setting limits restarts the window. Emits `LimitsUpdatedEvent`.

Caps are the backstop for a compromised backend: a stolen admin key can drain
at most one window's worth before you rotate it.

---

## Events and errors

| Event                    | Fields                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| `VaultInitializedEvent`  | `authority`, `admin`, `vault_bump`, `rent_reserve`, `vault_balance`, `timestamp` |
| `DepositEvent`           | `user`, `amount`, `vault_balance`, `timestamp`                         |
| `WithdrawEvent`          | `user`, `admin`, `request_id`, `amount`, `vault_balance`, `timestamp`  |
| `PauseStateChangedEvent` | `admin`, `paused`, `timestamp`                                         |
| `AdminProposedEvent`     | `authority`, `current_admin`, `pending_admin`, `timestamp`             |
| `AdminChangedEvent`      | `previous_admin`, `new_admin`, `timestamp`                             |
| `LimitsUpdatedEvent`     | `authority`, `max_withdraw_per_tx`, `max_withdraw_per_window`, `window_seconds`, `timestamp` |

| Code | Name                      | Meaning                                         |
| ---- | ------------------------- | ----------------------------------------------- |
| 6000 | `Unauthorized`            | Wrong admin                                     |
| 6001 | `InvalidAmount`           | Zero amount                                     |
| 6002 | `InsufficientFunds`       | Not enough lamports                             |
| 6003 | `VaultAlreadyInitialized` | Client mapping for init race                    |
| 6004 | `MathOverflow`            | Checked math overflow                           |
| 6005 | `VaultPaused`             | Deposits / withdrawals suspended                |
| 6006 | `CpiNotAllowed`           | `deposit` / `withdraw` called via CPI           |
| 6007 | `NotUpgradeAuthority`     | Signer is not the program's upgrade authority   |
| 6008 | `NotPendingAdmin`         | `accept_admin` signer is not the pending admin  |
| 6009 | `InvalidAdmin`            | Proposed admin is the all-zero key              |
| 6010 | `InvalidLimits`           | Window cap and window length not set together   |
| 6011 | `WithdrawLimitExceeded`   | Above the per-transaction cap                   |
| 6012 | `WindowLimitExceeded`     | Above the cap for the current window            |

The rent reserve — whatever `getMinimumBalanceForRentExemption(0)` returns on
that cluster — stays in the pool permanently.
**Never credit it as user balance.** The program and scripts read it dynamically.

`DepositEvent` and `WithdrawEvent` are emitted **twice**: with `emit!` into
program logs (what `program.addEventListener` sees) and with `emit_cpi!` as a
self-CPI whose instruction data carries the event. The runtime truncates logs
at 10 KB per transaction, which a transaction with many instructions can hit;
the CPI copy is immune to that. An indexer should read the CPI copy from the
transaction's inner instructions (first 8 bytes `e445a52e51cb9a1d`, then the
event); a websocket listener can use the logs. Consume **one** source, and
de-duplicate by `(transaction signature, instruction index, event index)`,
never by the signature alone: one transaction can hold several identical
deposits. The other events are log-only.
