# Program reference

Every instruction, its accounts and signers, and every event and error code.

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
a transaction with many instructions can (CPI calls are rejected since v0.1.1),
and a log-only listener would then miss the event. Index by transaction and
decode instruction data as a fallback.
