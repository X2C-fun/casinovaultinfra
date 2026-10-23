# Contributing

Thanks for helping improve Casino Vault. This is custody code, so changes are
reviewed with security first.

## Ground rules

- Security issues go through [SECURITY.md](SECURITY.md), not public issues.
- One logical change per pull request. Explain *why* in the description.
- Never commit keys or secrets. The `.gitignore` covers `wallet.json`,
  everything under `keys/`, `*-keypair.json`, and any `.env*` other than
  `.env.example`. Keep every other keypair (for example a test player) under
  `keys/`, and never force-add any of them.
- Changes to the on-chain program need tests in `tests/casino_vault.ts`
  covering both the success path and the failure modes they introduce.

## Toolchain

| Tool | Version |
| ---- | ------- |
| Rust (host) | 1.89.0 (CI) |
| Solana / Agave CLI | 2.3.13 |
| Anchor CLI | 0.32.1 |
| Node.js | 22 (as CI); 20.17 or later works |
| npm | 11 (CI pins 11.21.1) |

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

These are the same checks CI runs (`.github/workflows/ci.yml`), from the
repository root. The `anchor` job also diffs the committed IDL copies against
the build (see [Program changes](#program-changes)).

```bash
# Program (jobs `rust` and `anchor`)
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
npm ci
anchor build
cargo build-sbf --manifest-path reference/casino_fair/Cargo.toml --tools-version v1.48 -- --locked
npx tsc --noEmit -p .
npm run lint
anchor test --skip-build

# casino_fair (job `casino_fair`)
cargo fmt --manifest-path reference/casino_fair/Cargo.toml --all -- --check
cargo clippy --manifest-path reference/casino_fair/Cargo.toml --locked --all-targets -- -D warnings
cargo clippy --manifest-path reference/casino_fair/Cargo.toml --locked --all-targets --features ephemeral,test-queue -- -D warnings
cargo test --manifest-path reference/casino_fair/Cargo.toml --locked

# SDK (job `packages`)
cd packages/sdk
npm ci
npm run typecheck
npm run build
npm test
npm run smoke
npm audit --omit=dev --audit-level=critical
npm pack --dry-run      # must list only package.json, README.md, LICENSE and dist/*
cd ../..

# Backend (job `packages`; needs the SDK built first)
cd packages/backend
npm ci
npm run typecheck
npm test
npm audit --omit=dev --audit-level=critical
cd ../..

# Frontend (job `frontend`)
cd casinovault-frontend
npm ci
npx tsc --noEmit
npx eslint .
npx next build --webpack
npm audit --omit=dev --audit-level=critical
cd ..
```

## Program changes

- If you change instructions, accounts, events, or errors, regenerate and
  commit the IDL copy in the SDK — CI fails if it drifts:

  ```bash
  anchor build
  cp target/idl/casino_vault.json packages/sdk/src/idl/
  cp target/types/casino_vault.ts packages/sdk/src/idl/
  ```

  `packages/sdk/src/idl/` is the only copy. The demo frontend imports the IDL
  from the published `@x2c-fun/casinovault-sdk` package, so it sees the change
  only after an SDK release and a bump of its dependency (see
  [docs/releasing.md](docs/releasing.md)).

- Account layout changes are breaking for existing deployments. Call them out
  in the PR and in `CHANGELOG.md`, including the migration path.
- Use **npm 11** when a change touches `package-lock.json` (`npm install -g npm@11`).
  CI and Dependabot both use npm 11; a lockfile written by npm 10 still works,
  but npm 10 cannot `npm ci` a lockfile written by npm 11.
- Keep `Cargo.lock` at lockfile **version 3** (Solana platform-tools cannot
  read v4). Avoid a bare `cargo update` on a newer host; see
  [Testing and troubleshooting](docs/testing-and-troubleshooting.md).

## Commit messages

Use short imperative subjects (`Add request_id to WithdrawEvent`), with a body
explaining motivation when it is not obvious. Add an entry under
`## [Unreleased]` in `CHANGELOG.md` for user-visible changes.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
