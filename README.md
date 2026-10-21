# Casino Vault Infra — Solana pooled custody program

[![CI](https://github.com/X2C-fun/casinovaultinfra/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/X2C-fun/casinovaultinfra/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An Anchor program that holds SOL for a casino backend in **one shared pool**. It
is a custody layer only: it moves SOL in and out under strict authority checks
and emits an event for every change. It knows nothing about balances, bets, wins,
losses, leaderboards, house accounting or game history — all of that lives in the
backend database, which is driven by the events emitted here.

| Item              | Value                                          |
| ----------------- | ---------------------------------------------- |
| Program ID        | `EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7` |
| Anchor            | `0.32.1`                                       |
| Solana / Agave    | `2.3.13`                                       |
| Rust (SBF)        | `1.84.0`, edition 2021                         |
| Deployed clusters | devnet (v0.2.0, upgraded in slot 512813387)    |

> **Status: not audited, not for mainnet funds.** The devnet program runs
> v0.2.0, upgraded in place from v0.1.1 (same program ID and pool). Its
> withdrawal caps are 0.1 SOL per withdrawal and 0.5 SOL per hour,
> low testing values for this deployment, not a recommendation. The upgrade
> authority can change them at any time with `npm run set-limits` (see
> [Reference](docs/reference.md#set_limits--on-chain-withdrawal-caps)), and
> anyone deploying their own copy sets their own.
>
> The devnet deployment keeps the roles separate, as this README recommends:
>
> | Role | Address |
> | ---- | ------- |
> | Upgrade authority | `Hithh6rJmGiWRdkBsUKqJyDMnEos1fEb5baumpbYwEhr` |
> | Vault admin (`VaultState.admin`) | `Agb3fnkpc7U1u5y2GutLpnGfKQcWLHVW4PKJ18CwUgDr` |
> | Pool vault PDA | derived from `["pool_vault"]` |
>
> Read
> [Backend withdraw flow](docs/backend-integration.md#backend-withdraw-flow) and [Known limitations](docs/architecture.md#known-limitations)
> before building on it.

---

## Quickstart

Run the program and its integration tests on a local validator. You need the
Rust, Solana 2.3.13 and Anchor 0.32.1 toolchains
([install steps](docs/deployment.md#step-1--install-the-toolchain)) and Node.js 20 or later.

```bash
git clone https://github.com/X2C-fun/casinovaultinfra.git
cd casinovaultinfra
npm install
[ -f wallet.json ] || solana-keygen new -o wallet.json --no-bip39-passphrase
anchor build
anchor test      # local validator + the full integration suite
```

To deploy your own copy to devnet, follow [Deployment](docs/deployment.md).

## Documentation

| Page | What it covers |
| ---- | -------------- |
| [Architecture and trust model](docs/architecture.md) | Repository layout, PDAs, the three keys, what the program guarantees, known limitations |
| [Deployment and operations](docs/deployment.md) | Toolchain, deploying, registering the admin, new program IDs, upgrades, mainnet checklist |
| [Backend integration](docs/backend-integration.md) | Admin key handling, reads, the safe withdraw flow, listener rules |
| [Program reference](docs/reference.md) | Instructions, accounts, signers, events, error codes |
| [Reference frontend](docs/frontend.md) | The Next.js demo app and its environment variables |
| [Provable fairness (`casino_fair`)](docs/fairness.md) | The MagicBlock-VRF coin-flip reference program and its trust model |
| [Testing and troubleshooting](docs/testing-and-troubleshooting.md) | Running the tests, common errors and fixes |

## Packages and reference components

Beyond the on-chain program, the repo ships the pieces an integrator needs to
build a game on the vault:

| Component | Path | What it is |
| --------- | ---- | ---------- |
| **TypeScript SDK** | [`packages/sdk`](packages/sdk) | `@x2c-fun/casinovault-sdk` — typed IDL, PDAs, instruction builders, a safe withdraw-tx builder + client assertion, event decoding, and pool reconciliation. Publishable to npm. |
| **Settlement backend** | [`packages/backend`](packages/backend) | A reference backend implementing [the withdraw flow](docs/backend-integration.md): balance holds, debit-at-approval, a finalized-only event listener, incident pause, and reconciliation (SQLite or in-memory). |
| **Fairness primitive** | [`programs/casino_fair`](programs/casino_fair) | A provably-fair coin-flip built on MagicBlock VRF — the randomness companion to the vault. See [docs/fairness.md](docs/fairness.md). Built standalone (see that doc). |

These are devnet-oriented references, not production-hardened or audited — the
backend's HTTP API ships without auth, and `casino_fair` is a primitive, not a
game. Read each component's README before building on it.

- **AI coding agents / fast onboarding:** [`AGENTS.md`](AGENTS.md) — the whole
  protocol, build/test commands, and the rules that keep it correct, in one file.
- **Publishing the SDK / cutting a release:** [`mia.md`](mia.md).

**Building a backend on this?** Read
[Backend withdraw flow](docs/backend-integration.md#backend-withdraw-flow) and
[Known limitations](docs/architecture.md#known-limitations) first.

---

## Disclaimer

This software is provided **"as is", without warranty of any kind**, as stated
in the [MIT License](LICENSE). It has **not been audited** and is published for
devnet use and review; do not use it to hold real funds without an independent
security audit.

It is infrastructure code, not a licensed gambling, payments or custody
service. If you operate it, you alone are responsible for complying with the
laws that apply to you, including gambling, money-transmission, KYC/AML and
consumer-protection rules in every jurisdiction you serve. Nothing in this
repository is legal, financial or investment advice.

## Support

Maintained by [X2C](https://github.com/X2C-fun) on a **best-effort basis**:

- **Questions and bugs:** open a
  [GitHub issue](https://github.com/X2C-fun/casinovaultinfra/issues). There is
  no guaranteed response time, and integrations built on this code are not
  supported.
- **Security vulnerabilities:** never in a public issue; report them privately
  as described in [SECURITY.md](SECURITY.md).

---

## Contributing and license

- **Contributing:** pull requests are welcome; see
  [CONTRIBUTING.md](CONTRIBUTING.md). Everyone taking part is expected to
  follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Changes:** see [CHANGELOG.md](CHANGELOG.md).
- **License:** [MIT](LICENSE).
