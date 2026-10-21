# AGENTS.md — guide for AI coding agents (and humans in a hurry)

This file orients an agent that has just cloned this repo. Read it before
changing anything. It explains what the protocol is, how the pieces fit, the
exact commands to build/test each one, and the **non-negotiable rules** that
keep it correct and safe. Authoritative detail lives in [`docs/`](docs/); this
is the map.

> **Context in one line:** Casino Vault is a **devnet**, **custodial**,
> **unaudited** Solana protocol for games. It holds pooled player SOL and lets a
> backend approve withdrawals. Do not point it at mainnet or real funds.

---

## 1. Mental model

Four parts. Keep their responsibilities separate — most bugs come from blurring
them.

| Part | Plain-English role | Where |
| ---- | ------------------ | ----- |
| **Vault program** | The **safe**. Custody only: moves SOL in/out of one shared pool under authority checks and emits an event for every change. Knows nothing about balances, bets, odds, or games. | `programs/casino_vault` |
| **SDK** | The **toolkit**. Typed client: IDL, PDAs, instruction builders, a safe withdraw-tx builder + verifier, event decoding, reconciliation. | `packages/sdk` |
| **Settlement backend** | The **cashier/accountant**. Keeps per-player balances, approves payouts safely, watches the chain, settles from events, pauses on incident, reconciles. This is where solvency actually lives. | `packages/backend` |
| **Fairness primitive** | The **provably-fair coin-flipper** (MagicBlock VRF). Randomness nobody can bias. A reference, not a game. | `programs/casino_fair` |

The vault is deliberately dumb. All accounting and game logic live **off-chain**
in the backend, driven by the events the vault emits.

---

## 2. Repository map

```
programs/
  casino_vault/      # the custody program (Anchor 0.32.1) — the deployed artifact
  cpi_probe/         # test-only fixture: forwards vault calls through CPI
  casino_fair/       # VRF coin-flip reference — STANDALONE crate (see §6)
packages/
  sdk/               # @x2c-fun/casinovault-sdk  (publishable)
  backend/           # @x2c-fun/casinovault-backend  (reference, unauthenticated)
casinovault-frontend/# Next.js demo app (self-contained; SDK wiring is a post-publish step)
scripts/             # admin/ops TS scripts (initialize, deposit, withdraw, ...)
tests/               # vault integration tests (anchor test)
docs/                # the real documentation (read these)
Anchor.toml Cargo.toml package.json   # workspace config
mia.md               # the publish/release runbook
```

Docs worth reading before a change: [`docs/architecture.md`](docs/architecture.md)
(trust model, PDAs, the three keys, known limits),
[`docs/backend-integration.md`](docs/backend-integration.md) (the withdraw flow —
**read in full before touching the backend**),
[`docs/reference.md`](docs/reference.md) (instructions, accounts, events, errors),
[`docs/fairness.md`](docs/fairness.md) (the VRF program),
[`docs/deployment.md`](docs/deployment.md), [`SECURITY.md`](SECURITY.md).

---

## 3. Trust model and keys

Three keys, kept separate on purpose:

- **Upgrade authority** — can replace the program's code (root of trust). Cold /
  multisig. Runs `initialize`, `propose_admin`, `set_limits`.
- **Admin** (`VaultState.admin`) — co-signs **every** withdrawal and is the only
  key that can pause. Lives hot in the backend. A withdrawal pays only the
  signing `user`, so a stolen admin key alone cannot redirect funds, but it can
  pay the capped amount per window until rotated.
- **User wallets** — sign their own deposits and receive their own withdrawals.

Everything here is **operator-trusted** (custodial). It is not, and does not
claim to be, trustless or provably solvent on-chain.

---

## 4. Build & test — exact commands

Node 20+, Rust + Solana 2.3.13 + Anchor 0.32.1 for the program. `npm` is the
package manager (the repo ships `package-lock.json`). The `packages/*` are
**standalone** — install and test each in its own directory. (The root is NOT
an npm workspace: that would require regenerating the root `package-lock.json`,
and CI runs `npm ci` against the committed lock.)

**Vault program**
```bash
npm install
anchor build            # builds casino_vault + cpi_probe (NOT casino_fair — see §6)
anchor test             # local validator + full integration suite
# ops scripts (need ANCHOR_PROVIDER_URL + ANCHOR_WALLET):
npm run read | deposit | withdraw | initialize | set-limits | set-paused | propose-admin | accept-admin
```

**SDK** (`packages/sdk`)
```bash
cd packages/sdk
npm install && npm run build && npm test && npm run typecheck   # 11 tests
```

**Backend** (`packages/backend`)
```bash
cd packages/backend
npm install                       # needs the published SDK; before publish, link it:
                                  #   npm install && npm install ../sdk   (file link)
npm test                          # 8 tests, no chain needed
npm run typecheck
cp .env.example .env              # then run it (needs ADMIN_SECRET_KEY + RPC):
npm run start                     # API + listener
```

**Fairness program** (`programs/casino_fair`, standalone)
```bash
cd programs/casino_fair
cargo check && cargo test        # 7 host unit tests; SBF build is blocked (§6)
```

**Frontend**
```bash
cd casinovault-frontend
npm install && npm run build
```

Publishing is a separate, human-run step — see [`mia.md`](mia.md).

---

## 5. Non-negotiable rules (read before editing)

These encode correctness and safety. Breaking one usually passes a type-check
and fails only at runtime or on-chain.

**On-chain / Rust**
- **`Cargo.lock` must stay `version = 3`.** Solana platform-tools' Cargo (1.84)
  cannot parse v4. If a tool rewrites it to v4, set line 3 back to `version = 3`.
  See the comment in the root `Cargo.toml`.
- Never re-run a plain `cargo update` that rewrites the pinned lockfile. Use the
  MSRV-aware regen documented in `Cargo.toml` if you must.
- Error codes are append-only (Anchor offsets by 6000). Never reorder/remove.
- The vault stores **no balances**. Do not add per-user balance fields to it —
  balances belong in the backend ledger.

**Backend / settlement (`docs/backend-integration.md`)**
- **Debit at approval, not at confirmation.** Place the balance hold BEFORE
  signing the withdraw. Debiting only after the event lets one balance fund many
  approvals.
- **Match on `request_id` first**, then check `user` and `amount`. Never settle
  by amount alone.
- **Credit/settle only from FINALIZED transactions**, and **skip any with
  `meta.err`** — a failed tx still carries its events in the logs.
- **De-duplicate events by source** (`signature:ixIndex:eventIndex`), never by
  content. Identical deposits produce identical payloads.
- An **unmatched `WithdrawEvent`** (unknown/mismatched `request_id`) is the
  leaked-admin-key shape → **pause the vault and alert** before anything else.
- The pool-solvency invariant: `pool balance === Σ player balances + house
  bankroll + rent reserve`. A surplus is unattributed SOL — never credit it.

**SDK / client**
- The SDK **must not read `process.env`** or import any UI framework (it runs in
  a browser bundle). Config is passed in.
- `@coral-xyz/anchor` and `@solana/web3.js` are **peer** dependencies (one copy
  in the consumer). Do not bundle them.
- In the browser, call **`assertSafeWithdrawTx`** before signing any
  server-built withdraw. On the backend, **never co-sign a transaction you did
  not build.**
- The package ships dual ESM + CJS with correct `exports` types — keep both
  working (`dist/index.d.ts` for import, `dist/index.d.cts` for require).

**Secrets**
- `wallet.json`, `*-keypair.json`, `keys/`, and `.env` are gitignored. **Never
  commit a secret key** or an `ADMIN_SECRET_KEY`.

---

## 6. The `casino_fair` toolchain limitation (important)

`casino_fair` is a **standalone crate**: it is NOT a member of the Cargo
workspace and NOT built by `anchor build`. Reason: its MagicBlock dependency
(`ephemeral-rollups-sdk` → … → `crypto-common 0.2.2`) requires Rust
`edition2024`, which the pinned Solana platform-tools Cargo (1.84) cannot build
for SBF. Excluding it keeps the vault's build, `Cargo.lock`, and CI unchanged.

- It **host-compiles and unit-tests pass** (`cd programs/casino_fair && cargo
  test`).
- It **cannot be SBF-built/deployed** until platform-tools is upgraded. Do not
  add it back to the workspace members or `[programs.*]` on the current
  toolchain — that re-breaks `anchor build`. Full detail: `docs/fairness.md`.

---

## 7. Common change recipes

- **Add a vault instruction:** add it in `programs/casino_vault/src/instructions/`,
  wire it in `lib.rs`, add an event in `events.rs` and an error (append-only) if
  needed, regenerate the IDL (`anchor build`), copy the new IDL into
  `packages/sdk/src/idl/`, add an SDK builder in `packages/sdk/src/instructions.ts`,
  and a known-answer test in `tests/`.
- **Add an SDK helper:** implement in `packages/sdk/src/`, export from `index.ts`,
  add a unit test in `src/sdk.test.ts`, `npm run build && npm test`.
- **Change backend balance logic:** edit `packages/backend/src/ledger/` (keep the
  `Ledger` interface synchronous — the hold check must be atomic), update both
  `memory.ts` and `sqlite.ts`, and extend `test/ledger.test.ts`.
- **Change the event listener:** `packages/backend/src/services/settlement.ts`
  (the pure core `applyParsedEvents` is unit-tested) and
  `packages/backend/src/listener/`.

---

## 8. Definition of done for a change

- Touched package builds and its tests pass (`npm test` / `cargo test`).
- `tsc --noEmit` is clean for any TS package you edited.
- No secret committed; `Cargo.lock` still `version = 3` if you touched Rust deps.
- Docs updated if behaviour or interface changed; `CHANGELOG.md` gets an
  `Unreleased` entry.
- You did not silently re-enable `casino_fair` in the workspace / `anchor build`.
