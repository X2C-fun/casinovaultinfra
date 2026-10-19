# Testing and troubleshooting

Running the integration suite, and fixes for the errors people hit most.

## Local tests

`anchor test` needs a provider wallet at `wallet.json` (see `Anchor.toml`).
Any keypair works on localnet. `[test] upgradeable = true` deploys the program
with that wallet as upgrade authority, which the authority-gated tests need:

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
[Instruction reference](reference.md#instruction-reference)).

### `Admin mismatch` / `ADMIN_SECRET_KEY does not match on-chain admin`

The key you are signing with is not the current admin (set by `initialize` or
the last `accept_admin`). Run `npm run read` to see the on-chain admin.

### `NotUpgradeAuthority` (6007)

`initialize`, `propose_admin` and `set_limits` must be signed by the program's
upgrade authority. Check it with `solana program show <PROGRAM_ID>` or
`npm run read`.

### `Blockhash not found` / `429 Too Many Requests`

Public devnet RPC is flaky; scripts retry automatically. For anything serious
use a dedicated RPC URL in `ANCHOR_PROVIDER_URL`.

### `insufficient funds` on deploy

Top up `wallet.json` — program upload needs a few SOL on devnet.
