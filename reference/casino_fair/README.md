# casino_fair

A provably-fair coin-flip reference program for Solana, built on MagicBlock
VRF with Anchor 0.32.1. The player requests a flip, the VRF oracle delivers
verifiable randomness through an authenticated callback, and the result is
stored in the player's `Flip` account. It is a primitive, not a game: it does
not move funds.

> **Not audited. Not for mainnet funds.** This is a devnet reference. Read the
> trust model in [docs/fairness.md](../../docs/fairness.md) before building on
> it: the oracle can predict and withhold results, and cancel is a re-roll
> vector unless cancel economics are independent of the outcome.

## Standalone crate

`casino_fair` is not a member of the root Cargo workspace and is not built by
`anchor build`. It has its own committed `Cargo.lock`, which holds every
transitive crate at a release that builds on Solana platform-tools v1.48
(rustc 1.84.1). Always pass `--locked`, and **never run a plain
`cargo update`** here: it would pull crates that need a newer rustc or the
`edition2024` Cargo feature. Change pins one crate at a time with
`cargo update -p <crate> --precise <version>`, then rebuild for SBF.

## Build and test

From the repository root (or drop `--manifest-path` inside this directory):

```bash
# host unit tests, lints, formatting
cargo test   --manifest-path reference/casino_fair/Cargo.toml --locked
cargo clippy --manifest-path reference/casino_fair/Cargo.toml --locked --all-targets -- -D warnings
cargo clippy --manifest-path reference/casino_fair/Cargo.toml --locked --all-targets --features ephemeral,test-queue -- -D warnings
cargo fmt    --manifest-path reference/casino_fair/Cargo.toml --all -- --check

# SBF program (Solana 2.3.x CLI, platform-tools v1.48)
cargo build-sbf --manifest-path reference/casino_fair/Cargo.toml --tools-version v1.48 -- --locked
```

CI runs all of these. The host tests cover the state machine; the VRF CPI and
the callback signer gate are checked by the devnet smoke test below.

## Devnet deployment

| Item | Value |
| ---- | ----- |
| Program ID | `CC3Nd2gwMHDf3FWUbwMxW4FWM4BTWubDyrU9AkoH2Eps` |
| Upgrade authority | `Hithh6rJmGiWRdkBsUKqJyDMnEos1fEb5baumpbYwEhr` |
| Deployed | slot 514372450 (default features: base-layer `DEFAULT_QUEUE` only) |
| IDL account | `F2LaEMG9jJ6BpiA9sp1PLtaqVV66CB78pT7xhFnCqmwj` |
| IDL file | [`idl/casino_fair.json`](idl/casino_fair.json) (same as the on-chain IDL) |

Clients can load `idl/casino_fair.json` with `new anchor.Program(idl, provider)`,
or fetch it with `anchor idl fetch CC3Nd2gwMHDf3FWUbwMxW4FWM4BTWubDyrU9AkoH2Eps
--provider.cluster devnet`.

### Devnet smoke test

[`scripts/devnet-smoke.ts`](scripts/devnet-smoke.ts) runs a live request →
VRF callback round trip against the deployed program, plus the negative checks
a local validator cannot run: a non-allowed queue (6003), cancel before the
timeout (6005), close while requested (6006), and a spoofed `callback_flip`
signed by the player instead of the VRF identity (Anchor 2012). From the
repository root, after `npm install`:

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=./keys/<player>.json \
npx ts-node --compiler-options '{"module":"commonjs"}' \
  reference/casino_fair/scripts/devnet-smoke.ts
```

On 2026-10-24 it passed 13/13 checks. The MagicBlock oracle fulfilled each
request 3 to 4 slots (about 1 s) after it landed. The signatures are listed in
[docs/fairness.md](../../docs/fairness.md#devnet-smoke-test).

## Features

| Feature | Effect |
| ------- | ------ |
| `ephemeral` | Also accept MagicBlock's ephemeral-rollup VRF queue. Only useful if the flip account is delegated to an ephemeral rollup, which this program does not do. |
| `test-queue` | Also accept MagicBlock's test queues. Test oracles may use known keys, so outcomes are **predictable**: local development only, never for value. |

By default only the base-layer queue (`DEFAULT_QUEUE`) is accepted. The usual
Anchor features (`cpi`, `no-entrypoint`, `no-idl`, `no-log-ix-name`,
`idl-build`) are also defined.

## More

Full detail (instructions, lifecycle, oracle queues, events, devnet steps and
results, known limitations): [docs/fairness.md](../../docs/fairness.md).
