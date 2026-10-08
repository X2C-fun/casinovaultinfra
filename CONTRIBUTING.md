# Contributing

Thanks for helping improve Casino Vault. This is custody code, so changes are
reviewed with security first.

## Ground rules

- Security issues go through [SECURITY.md](SECURITY.md), not public issues.
- One logical change per pull request. Explain *why* in the description.
- Never commit keys or secrets: `wallet.json`, `keys/`, `*.json` keypairs, or
  any `.env*` other than `.env.example`. The `.gitignore` covers these; do not
  force-add them.
- Changes to the on-chain program need tests in `tests/casino_vault.ts`
  covering both the success path and the failure modes they introduce.

## Toolchain

| Tool | Version |
| ---- | ------- |
| Rust (host) | 1.89.0 (CI) |
| Solana / Agave CLI | 2.3.13 |
| Anchor CLI | 0.32.1 |
| Node.js | 22 (20+ works) |

## Setup

```bash
git clone https://github.com/X2C-fun/casinovaultinfra.git
cd casinovaultinfra
npm install
[ -f wallet.json ] || solana-keygen new -o wallet.json --no-bip39-passphrase
anchor build
```

Frontend:

```bash
cd casinovault-frontend
npm install
cp .env.example .env.local
```

## Checks to run before opening a PR

These are the same checks CI runs (`.github/workflows/ci.yml`):

```bash
# Program
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
anchor build
anchor test

# Scripts / tests
npx tsc --noEmit -p .
npm run lint

# Frontend
cd casinovault-frontend
npx tsc --noEmit
npx eslint .
npx next build --webpack
```

## Program changes

- If you change instructions, accounts, events, or errors, regenerate and
  commit the frontend IDL — CI fails if it drifts:

  ```bash
  anchor build
  cp target/idl/casino_vault.json casinovault-frontend/src/idl/casino_vault.json
  cp target/types/casino_vault.ts casinovault-frontend/src/idl/casino_vault.ts
  ```

- Account layout changes are breaking for existing deployments. Call them out
  in the PR and in `CHANGELOG.md`, including the migration path.
- Keep `Cargo.lock` at lockfile **version 3** (Solana platform-tools cannot
  read v4). Avoid a bare `cargo update` on a newer host; see Troubleshooting
  in the README.

## Commit messages

Use short imperative subjects (`Add request_id to WithdrawEvent`), with a body
explaining motivation when it is not obvious. Add an entry under
`## [Unreleased]` in `CHANGELOG.md` for user-visible changes.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
