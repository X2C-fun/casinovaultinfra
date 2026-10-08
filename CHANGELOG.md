# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

No on-chain program changes; the deployed devnet program is unchanged.

### Security

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
