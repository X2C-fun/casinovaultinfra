# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - not yet deployed

New program ID `EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7`. The 0.1.0 program at
`DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY` was deployed by another team and is not
upgraded; 0.1.1 is a fresh deployment, so no account migration or extension is
needed. Account layout, PDA seeds, instruction arguments and existing error
codes are unchanged from 0.1.0.

### Program

- `deposit` and `withdraw` must be top-level instructions; calling them
  through CPI fails with the new error `CpiNotAllowed` (6006). Anchor's event
  parser drops events emitted from a CPI'd call, so a deposit routed through a
  multisig or router moved SOL that no listener credited, and a wrapped
  withdrawal could defeat hold settlement.
- `programs/cpi_probe`: test-only fixture that forwards vault calls through
  CPI, used by the regression tests. Never deployed.

### Security

- README listener rules: de-duplicate events by
  `(signature, instruction index, event index)`, never by contents; identical
  deposits in one slot produce identical events.
- README withdraw flow: one open hold per destination wallet; never co-sign a
  transaction the backend did not build; persist the hold and its
  `lastValidBlockHeight` before signing; an unmatched or mismatched
  `WithdrawEvent` is an incident (alert, pause).
- Demo `/api/withdraw` refuses `user` = admin, which would have returned a
  fully signed transaction anyone could submit.
- Demo `/api/withdraw` no longer leaks secret-key bytes into logs when
  `ADMIN_SECRET_KEY` is malformed, and reads a server-only `SOLANA_RPC_URL`
  so a paid RPC key is never bundled into the browser.
- Frontend sends `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`,
  `Referrer-Policy`, HSTS, and `Cache-Control: no-store` on API routes.
- Scripts parse SOL amounts strictly (`1e3`, `1,5` and `0.5SOL` are
  rejected) and `sendWithRetry` gives up with an explicit "status unknown"
  error after 5 minutes instead of looping forever.
- CI: actions pinned to commit SHAs; workflow token is read-only.
- README listener rules: ignore transactions whose `meta.err` is set. A failed
  transaction keeps the logs of the instructions before the failure, so
  `[deposit, failing instruction]` showed a `DepositEvent` for SOL that never
  moved. `getTxDetails` in the tests returns no events for failed
  transactions, with a regression test.
- README withdraw flow: holds are settled by matching `WithdrawEvent.user` under
  a required one-open-hold-per-user rule, instead of by a transaction signature
  the backend cannot know at approval time.
- Demo `/api/withdraw` rate limit no longer trusts a client-supplied
  `X-Forwarded-For`. It reads the caller's IP only from proxies declared in
  `VAULT_DEMO_TRUSTED_PROXY_HOPS`, otherwise uses one shared bucket, and also
  limits per wallet.
- Scripts: `sendWithRetry` signs once and re-sends the same bytes; it builds a
  new transaction only after the previous one provably expired. A timeout
  after a successful send can no longer cause a second deposit or withdrawal.



- Demo `/api/withdraw` route is disabled (HTTP 501) unless
  `VAULT_DEMO_UNSAFE_WITHDRAW=true`; when enabled it enforces a per-request cap
  (`VAULT_DEMO_MAX_WITHDRAW_SOL`, default 0.1 SOL) and a per-IP rate limit.
  Admin-mismatch and unexpected errors return generic messages; details are
  logged server-side only.
- Frontend decodes the server-built withdraw transaction and refuses to sign
  unless it is a single `withdraw` of the requested amount to the connected
  wallet, with the connected wallet as fee payer and only user + admin signers.
- Withdraw confirmation uses `blockhash` + `lastValidBlockHeight` and checks
  `confirmation.value.err`.
- Strict SOL amount parsing: plain decimals only, at most 9 places, at least
  1 lamport, at most u64; no floating-point conversion.
- Next.js upgraded to 16.3.8; npm overrides for `shell-quote`, `nanoid` and
  `source-map-js`.

### Added

- `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `CHANGELOG.md`, `.gitattributes`.
- GitHub Actions CI: rustfmt, clippy, cargo tests, `anchor build` +
  `anchor test`, IDL drift check, scripts typecheck and Prettier, frontend
  tsc / ESLint / build, critical-level dependency audit.
- `NEXT_PUBLIC_VAULT_PROGRAM_ID` support in the frontend.

### Changed

- `npm run deploy:devnet` deploys only `casino_vault` (`-p casino_vault`).
- README: a fresh clone must not `anchor deploy` to the existing devnet
  address; `avm` is installed from the `v0.32.1` tag with `--locked`.
- `Anchor.toml`: test validator binds to `127.0.0.1`; stale registry removed.
- Scripts derive PDAs from the loaded program's ID; the unused hardcoded
  `PROGRAM_ID` was removed.
- Program description no longer claims to be "non-custodial"; it is a pooled
  custody program with admin-approved withdrawals.
- Frontend fonts are self-hosted via `@fontsource`, so builds need no network.
- README: backend withdraw flow now requires holding the balance at approval
  time; corrected fee-payer, rent-reserve and program-ID notes; documented the
  devnet demo configuration, event-log caveats and known limitations.

### Fixed

- ESLint `react-hooks/set-state-in-effect` error in `useVaultState`.

## [0.1.0] - 2026-10-04

### Added

- Initial release: `casino_vault` Anchor program (`initialize`, `deposit`,
  `withdraw`, `set_paused`), TypeScript admin scripts, integration tests, and
  the Next.js reference frontend. Deployed to devnet as
  `DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY`.

[Unreleased]: https://github.com/X2C-fun/casinovaultinfra/compare/a0da5b8...HEAD
[0.1.0]: https://github.com/X2C-fun/casinovaultinfra/commit/a0da5b8
