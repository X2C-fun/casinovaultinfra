# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Program (v0.2.0)

Deployed to devnet on 2026-10-19: the v0.1.1 program was paused, extended by
88,024 bytes and upgraded in place in slot 512813387, its on-chain IDL
upgraded, and v0.2 initialized with the existing pool balance kept. Caps are
0.1 SOL per withdrawal and 0.5 SOL per 3600 s. Deposits, house and player
withdrawals with `request_id`, the on-chain per-transaction cap, both event
copies and pause were verified there.

Ports the v0.2 program by @harshshukla9 (`v0.2-program` branch) onto the
v0.1.1 code, keeping the CPI guard. Breaking on-chain interface; existing
error codes 6000–6006 keep their meaning. A v0.1.x deployment upgrades in place
and keeps its pool balance: see "Upgrading from v0.1.x" in
`docs/deployment.md` (extend the program account first; the binary grows by
about 87 KB).

- `initialize` requires the program's upgrade authority (plus the admin's
  co-signature), closing the front-running window after deploy.
- Two-step admin rotation: `propose_admin` (upgrade authority) and
  `accept_admin` (pending admin). The admin cannot rotate itself, so a leaked
  admin key can be replaced in one transaction without a program upgrade.
- Optional on-chain withdrawal caps via `set_limits` (upgrade authority):
  per transaction and per tumbling window, applied to every withdrawal
  including house withdrawals.
- `withdraw` takes `request_id: u64`, echoed in `WithdrawEvent`, so backends
  settle exactly the hold they approved.
- `DepositEvent` / `WithdrawEvent` are also emitted with `emit_cpi!`, which log
  truncation cannot drop.
- New events `AdminProposedEvent`, `AdminChangedEvent`, `LimitsUpdatedEvent`;
  `VaultInitializedEvent` gains `authority` and `vault_balance`.
- New errors 6007–6012: `NotUpgradeAuthority`, `NotPendingAdmin`,
  `InvalidAdmin`, `InvalidLimits`, `WithdrawLimitExceeded`,
  `WindowLimitExceeded`.
- `VaultState` moves to seed `["vault_state_v2"]` and grows to 175 bytes
  (pending admin, caps, window counters, 64 reserved bytes). `withdraw` marks
  `vault_state` writable; `deposit` and `withdraw` append the
  `event_authority` and `program` accounts. The upgrade authority pays
  `initialize` rent.
- Scripts `propose-admin`, `accept-admin`, `set-limits`; `read` shows the
  upgrade authority, pending admin and caps; `withdraw` takes an optional
  `request_id`. The frontend shows caps and the pending admin, and its
  pre-sign check covers `request_id` and the two new accounts.
- Docs: the backend withdraw flow settles holds by `request_id`; Known
  limitations updated for what v0.2 closes.
- Tests: `getTxDetails` drops `emit_cpi!` events from failed transactions as
  well as log events (a failed transaction keeps its inner instructions).
- Review fixes before merge: `set_limits` keeps the running window and its
  usage when a window cap is already active, so tightening caps during an
  incident no longer grants a fresh allowance; a clock reading before the
  window start no longer reopens the window.
- House withdrawals must match a registered record like any other; the
  `withdraw` script requires an explicit `request_id`, and `propose-admin`
  refuses off-curve (PDA or multisig) keys, which could never co-sign.
- Frontend pre-sign check accepts ComputeBudget instructions before the
  withdraw, capping the priority fee the user pays at 0.001 SOL.
- Tests for tightening caps mid-window, another program's ProgramData account,
  replacing an admin proposal, and `emit_cpi!` events in failed transactions.

### Fixed

- CI installs npm 11 before `npm ci`. Dependabot writes lockfiles with npm 11,
  which npm 10 (Node 22's default) rejects, so frontend dependency PRs failed
  CI with "Missing: utf-8-validate@5.0.10 from lock file".

### Added

- README sections for a disclaimer (as-is, unaudited, operators are responsible
  for gambling and payments compliance) and support expectations (best-effort,
  via GitHub issues), plus CI and license badges.

### Changed

- README status note no longer lists the unmaintained v0.1.0 deployment; that
  history stays in this changelog (see 0.1.1).
- Documentation split: the README is now an overview with a quickstart, and
  the detail lives in `docs/` (architecture, deployment, backend integration,
  program reference, frontend, testing and troubleshooting).
- Known limitations: the "Planned change" column is now "Possible future
  change"; these are options, not commitments.
- Dependabot groups patch and minor updates into one PR per package
  directory each week and ignores major versions, plus minor versions of
  `@coral-xyz/anchor` and `@solana/web3.js`, which must move together with
  the program and Anchor CLI. GitHub Actions updates are grouped into one PR.

## [0.1.1] - 2026-10-17

First public release: a fresh devnet deployment with an on-chain CPI guard,
plus security fixes to the documented backend flow, the demo API route, the
CLI scripts and CI. Not audited; not for mainnet funds.

| Devnet | |
| --- | --- |
| Program ID | `EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7` |
| Upgrade authority | `Hithh6rJmGiWRdkBsUKqJyDMnEos1fEb5baumpbYwEhr` |
| Vault admin | `Agb3fnkpc7U1u5y2GutLpnGfKQcWLHVW4PKJ18CwUgDr` |
| Deployed | slot 509121525 (2026-10-09), initialized immediately |

This is a fresh deployment, not an upgrade. The earlier v0.1.0 program at
`DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY` is no longer maintained by this
repository and lacks these fixes; do not use it. Account layout, PDA seeds,
instruction arguments and existing error codes are unchanged from 0.1.0.

### Program

- `deposit` and `withdraw` must be top-level instructions. A call routed
  through another program fails with the new error `CpiNotAllowed` (6006).
  Anchor's event parser drops events emitted from a CPI'd call, so a deposit
  routed through a multisig or router could move SOL that no listener ever
  credited. A test-only fixture, `programs/cpi_probe`, covers this and is
  never deployed.
- Consequence: the admin must be a keypair. A multisig or PDA admin signs
  through CPI, so it cannot approve withdrawals.

### Security

Backend integration guidance (now in `docs/backend-integration.md`):

- Ignore failed transactions (`meta.err`). A reverted
  `[deposit, failing instruction]` still logs a `DepositEvent` for SOL that
  never moved, and a listener that credited it could be drained. Regression
  test included.
- Hold at approval, not at confirmation: one open hold per destination wallet,
  enforced with a database unique index; save the hold and its
  `lastValidBlockHeight` before signing; settle by matching
  `WithdrawEvent.user` from finalized data; release a hold only after the
  listener has passed that block height.
- Never co-sign a transaction you didn't build. ComputeBudget instructions you
  add yourself are fine.
- De-duplicate events by `(signature, instruction index, event index)`, never
  by contents; two identical deposits in one slot produce identical events.
- Treat an unmatched or mismatched `WithdrawEvent` as an incident: alert, then
  pause.

Demo API route and frontend:

- `/api/withdraw` is off by default. It returns 501 unless
  `VAULT_DEMO_UNSAFE_WITHDRAW=true`, always refuses mainnet-beta (checked by
  genesis hash), caps each request when enabled, and rate-limits per wallet,
  and per IP only behind proxies declared in `VAULT_DEMO_TRUSTED_PROXY_HOPS`,
  so a spoofed `X-Forwarded-For` no longer bypasses it.
- The route refuses `user == admin`, which would have returned a fully signed
  transaction; a malformed `ADMIN_SECRET_KEY` no longer leaks key bytes into
  logs; errors are generic; a server-only `SOLANA_RPC_URL` keeps paid RPC keys
  out of the browser.
- The frontend decodes and checks the server-built transaction before the
  wallet signs: one `withdraw` of the requested amount, to and paid by the
  connected wallet. It sends security headers, plus `no-store` on API routes.
- Next.js upgraded to 16.3.8, fixing critical advisories.

CLI scripts:

- `sendWithRetry` signs once and re-sends the same bytes, building a new
  transaction only after the old one has provably expired, so retries cannot
  cause a second deposit or withdrawal. It classifies errors by the RPC
  message, not program logs, and stops with "status unknown" after 5 minutes.
- SOL amounts are parsed strictly; `1e3`, `1,5` and `0.5SOL` are rejected.

CI:

- Actions pinned to commit SHAs; the workflow token is read-only.

### Added

- `LICENSE` (MIT), `SECURITY.md` with private vulnerability reporting,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and PR templates,
  `CODEOWNERS` and Dependabot.
- GitHub Actions CI: rustfmt, clippy, cargo tests, `anchor build` +
  `anchor test`, IDL drift check, scripts typecheck and Prettier, frontend
  tsc / ESLint / build, critical-level dependency audit.
- `NEXT_PUBLIC_VAULT_PROGRAM_ID` support in the frontend.

### Changed

- Deploy and upgrade docs: a fresh clone must not run `anchor deploy` against
  an existing address; use `anchor keys sync -p casino_vault` for both
  clusters; run `anchor idl upgrade` after every upgrade.
- `npm run deploy:devnet` deploys only `casino_vault`.
- Removed create-next-app leftovers; fonts are self-hosted via `@fontsource`,
  so builds need no network.
- Program description no longer claims to be "non-custodial".

### Fixed

- The Anchor CI job installs `libudev-dev` before building the Anchor CLI.
  Every earlier run failed there, so this is the first release where CI builds
  the program, checks IDL drift and runs `anchor test`.
- Flaky tests: the test provider uses `confirmed` commitment (random
  "Blockhash not found" failures), and the websocket test waits for its
  subscription before depositing.
- ESLint `react-hooks/set-state-in-effect` error in `useVaultState`.

## [0.1.0] - 2026-10-04

### Added

- Initial release: `casino_vault` Anchor program (`initialize`, `deposit`,
  `withdraw`, `set_paused`), TypeScript admin scripts, integration tests, and
  the Next.js reference frontend. Deployed to devnet as
  `DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY`; that deployment is no longer
  maintained (see 0.1.1).

[Unreleased]: https://github.com/X2C-fun/casinovaultinfra/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/X2C-fun/casinovaultinfra/compare/a0da5b8...v0.1.1
[0.1.0]: https://github.com/X2C-fun/casinovaultinfra/commit/a0da5b8
