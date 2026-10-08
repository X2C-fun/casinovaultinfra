# Security Policy

## Status

Casino Vault v0.1 is a **devnet demo**. It has **not** been audited. Do not hold
mainnet funds with it until it has been reviewed and the items under
"Known limitations" in the README are addressed for your deployment.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability** (GitHub private vulnerability reporting).
Include:

- the affected component (on-chain program, scripts, or frontend);
- the commit hash or program ID you tested against;
- reproduction steps or a proof of concept (devnet or localnet only);
- the impact you believe it has.

We aim to acknowledge reports within 3 business days and to give a fix or
mitigation timeline within 10 business days. Please give us a reasonable
window to fix the issue before disclosing it publicly. Testing must never
touch funds you do not own.

## Supported versions

| Version | Supported |
| ------- | --------- |
| `main`  | Yes       |
| older   | No        |

## What each key controls

| Key | Powers | If it leaks |
| --- | ------ | ----------- |
| **Admin** (`VaultState.admin`, `ADMIN_SECRET_KEY`) | Co-signs every withdrawal; pauses and unpauses. | An attacker with any wallet can drain the pool (minus the rent reserve), and can unpause a paused vault. v0.1 has no on-chain admin rotation — recovery means upgrading the program. |
| **Upgrade authority** (`wallet.json` at deploy time) | Replaces the program code. | Total loss: new code can move every lamport. Move it to a multisig (e.g. Squads) or make the program immutable before mainnet. |
| **User wallet** | Deposits; signs its own withdrawals. | Only that user's withdrawals are affected; payouts can go only to the signing user. |

Keep the admin key and the upgrade authority separate. The public devnet demo
uses one key for both; that is a demo shortcut, not a recommendation.

## Demo withdraw API

`casinovault-frontend/src/app/api/withdraw` co-signs withdrawals **without
user authentication or balance checks**. It is disabled (HTTP 501) unless
`VAULT_DEMO_UNSAFE_WITHDRAW=true`, and then capped and rate-limited. Never
enable it with a funded mainnet admin key. Reports that this route can drain a
vault when explicitly enabled are expected behaviour, not vulnerabilities.

## Known dependency advisories

`npm audit --omit=dev` in `casinovault-frontend` reports advisories that have
no non-breaking fix upstream. None is reachable from untrusted input in this
app as shipped:

| Path | Advisories | Why it is accepted |
| ---- | ---------- | ------------------ |
| `@coral-xyz/anchor` → `toml` | Uncontrolled recursion, prototype pollution | Anchor's client parses only `Anchor.toml`-style config; the frontend never passes user input to it. |
| `@coral-xyz/anchor` / wallet adapters → `@solana/web3.js` → `jayson` → `stream-json`, `uuid` | DoS on crafted JSON; buffer bounds in uuid v3/v5/v6 | Only parses responses from the configured RPC endpoint; uuid is called without a caller-supplied buffer. Use a trusted RPC. |
| `@solana-mobile/wallet-adapter-mobile` → `react-native` → `metro` → `micromatch`, `braces`, `image-size` | DoS in glob / image parsing | React Native build tooling pulled in by the Mobile Wallet Adapter's peer dependency tree; it is not bundled into or executed by the web app. |
| `@solana/wallet-adapter-solflare` → `@solflare-wallet/sdk` → `uuid` | uuid buffer bounds | Fix requires a breaking major upgrade; same reasoning as uuid above. |

There are no critical advisories. CI fails if one appears
(`npm audit --omit=dev --audit-level=critical`). Overrides in
`casinovault-frontend/package.json` pin patched versions of `shell-quote`,
`nanoid` and `source-map-js`.
