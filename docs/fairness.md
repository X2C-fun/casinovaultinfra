# Provable fairness (`casino_fair`)

> **Not audited. Not for mainnet funds.** `casino_fair` is a devnet reference
> primitive. Nobody has reviewed it for value at risk, and it does not move
> money.

`casino_fair` is a minimal, self-contained **coin-flip** reference program built
on **MagicBlock VRF**. It is the fairness companion to `casino_vault`: the vault
custodies money, this program shows how to settle a bet against verifiable
randomness that the player cannot predict and the oracle cannot bias. The oracle
*can* predict the result and *can* withhold it; the trust model below spells
out what that means. It is a *primitive*, not a game: it does not move funds.

- **Program:** `reference/casino_fair`
- **Program ID (devnet):** `CC3Nd2gwMHDf3FWUbwMxW4FWM4BTWubDyrU9AkoH2Eps`
  (see [Devnet deployment](#devnet-deployment))
- **IDL:** [`reference/casino_fair/idl/casino_fair.json`](../reference/casino_fair/idl/casino_fair.json),
  also published on-chain
- **State:** one `Flip` PDA per player, `["flip", player]`.

> **Standalone crate, by design.** `casino_fair` is intentionally **not** a
> member of the Cargo workspace and is **not** built by the root `anchor build`.
> It has its own committed `Cargo.lock`. Build and test it with
> `--manifest-path` (see [Building and testing](#building-and-testing)); the
> root workspace's `cargo test -p casino_fair` does **not** work, because the
> crate is excluded from the workspace.

## What it does

| Step | Instruction | Signer | Effect |
|------|-------------|--------|--------|
| 1 | `init_flip` | player | Creates the player's `Flip` PDA in `Idle`. Once per player (again only after `close_flip`). |
| 2 | `request_flip(client_seed, guess)` | player | Validates the guess (`0 = HEADS`, `1 = TAILS`), bumps the round, records guess + seed + slot, sets `Requested`, and CPIs the VRF program on the base-layer queue. |
| 3 | `callback_flip(randomness, client_seed, round, requested_slot)` | **VRF oracle** | Authenticated by the scoped VRF identity, bound to this flip and request, idempotent. Maps the randomness to a side, computes `won = result == guess`, sets `Settled`. |
| — | `cancel_flip` | player | Only while `Requested` **and** at least `CANCEL_TIMEOUT_SLOTS` (150 slots, about one minute) after the request. Sets `Cancelled` and bumps the round. |
| — | `close_flip` | player | Any state except `Requested`. Closes the account and returns its rent to the player. |

Steps 2 and 3 are **separate transactions**. Every step that changes the
lifecycle emits an event (`FlipRequestedEvent`, `FlipSettledEvent`,
`FlipCancelledEvent`) that carries `player` and `round`.

## Trust model

### What the protocol guarantees

- **The oracle cannot bias the result.** The coin side is a pure function of a
  VRF output (the parity of its last byte, exactly 50/50). A VRF output is fixed
  by the oracle's key and the request input, and the VRF program verifies the
  proof before it invokes the callback. The oracle cannot pick a different
  output for the same request.
- **The player cannot predict the result.** The player does not hold the oracle
  key, so they cannot compute the output before it is delivered.
- **Authenticated settlement.** The callback context carries the
  `#[vrf_callback]` macro, which injects a `vrf_program_identity` signer bound to
  this program's scoped identity PDA. That signer is the whole security of the
  callback: without the macro the instruction still compiles, but anyone could
  call `callback_flip` with randomness of their choosing and settle a flip in
  their favour. The host tests cannot reach this gate; the
  [devnet smoke test](#devnet-smoke-test) checks it live (a spoofed callback
  is refused with Anchor's `ConstraintAddress`, 2012).
- **Settled at most once, by the right callback.** A callback settles only if
  the flip is `Requested` **and** its `(round, client_seed, requested_slot)`
  match the live request. A duplicate, a callback for a cancelled or superseded
  request, or one with mismatched arguments is a no-op. Because
  `requested_slot` is part of the binding, a late callback cannot settle a later
  request even after `close_flip` + `init_flip` restarts `round` at 0.
- **Auditable.** The settled `last_randomness` is stored on-chain, so anyone can
  re-run the mapping and check that the result matches it.

### What the protocol does NOT guarantee

- **The oracle can predict the result.** The oracle computes the VRF output, so
  it knows the outcome of every request before anyone else. "Verifiable" means
  it cannot *change* the outcome, not that it cannot *see* it.
- **The oracle can withhold fulfilment.** It can decline to deliver the
  callback, for example when the outcome is bad for a party it favours. The flip
  then stays `Requested` until the player cancels.
- **`client_seed` adds no meaningful entropy.** It is a single byte (256
  values), repeated 32 times into the VRF `caller_seed` and echoed back by the
  callback, which must match it. It works as a request tag. It does not stop
  the oracle predicting the outcome and does not make the input "jointly
  chosen" in any useful sense. Unpredictability for the player comes from the
  oracle's secret key, not from this byte.
- **Test queues are predictable.** MagicBlock's test queues are served by local
  or test oracles whose keys may be known. With a known key, anyone can compute
  the outcome in advance. That is why only the base-layer queue is accepted by
  default (see [Oracle queues](#oracle-queues)).

### Cancel is a re-roll vector

`cancel_flip` exists so a flip cannot be locked in `Requested` forever when the
oracle never fulfils. But withholding plus cancel lets someone retry:

1. The player requests a flip and the oracle computes the outcome.
2. If the outcome is unfavourable to whoever the oracle favours (or whoever is
   colluding with it), the oracle withholds the callback.
3. After the timeout the player cancels and requests again, getting a fresh
   outcome.

If a stake is attached, an integrator **must** make what happens to the stake on
cancel independent of the outcome. A fixed refund or a fixed forfeit both work,
because neither depends on the result the oracle saw. Never let a cancelled
flip resolve against a result. Also keep the timeout long enough that a healthy
oracle normally fulfils first. `CANCEL_TIMEOUT_SLOTS = 150` (about one minute at
~400 ms per slot) is well above normal fulfilment latency, which is a few
slots. Raise it if your oracle is slower; lowering it makes cancels, and so
re-rolls, more frequent.

A result can also become public without being settled. If a fulfilment
transaction lands but fails after the VRF program has verified the proof (for
example, it runs out of compute in the callback), its state changes are rolled
back, but the failed transaction stays on-chain and the randomness is visible
in it. The flip stays `Requested`. The player can read the transaction, learn
the outcome, and cancel after the timeout if they lost. The rule above covers
this too: cancel economics must not depend on the outcome.

### What the integrator must still do

The protocol secures the *randomness* and the *settlement identity*. It does not
secure the *economics*. A real game must add:

- **Binding to settlement.** `Flip.bet` is a documented placeholder, not escrow.
  `casino_fair` never touches lamports. Bind the flip result to a `casino_vault`
  withdrawal so a payout cannot happen without the matching flip, and a flip
  cannot be replayed against a second payout.
- **Outcome-independent cancel economics.** See above.
- **Pending state in the UI.** A successful `request_flip` means the oracle
  *accepted* the work, not that it was *fulfilled*. **Acceptance is not
  fulfillment.** Show "randomness pending" until the account reaches `Settled`,
  and offer cancel only after the timeout.
- **At-most-once payout.** `callback_flip` settles a request at most once *for
  this account*. Binding that to an at-most-once *payout* is still the
  integrator's job.

## Request → callback lifecycle

```
init_flip      request_flip(seed, guess)                 callback_flip(rnd, seed, round, slot)
   │                 │                                          │  (invoked by the oracle)
   ▼                 ▼                                          ▼
 Idle ─────────► Requested(round = n, slot = s) ───────────► Settled(round = n)
                     │  guess + seed + slot committed,         won = result == guess
                     │  round bumped, VRF CPI fired            last_randomness stored
                     │
                     ├─ a 2nd request while Requested → rejected (RequestInProgress)
                     │
                     └─ cancel_flip at slot ≥ s + 150 ─────► Cancelled(round = n + 1)
                                                             a late callback for n is ignored

Settled / Cancelled ──request_flip──► Requested(round + 1)
Idle / Settled / Cancelled ──close_flip──► account closed, rent returned
```

- `round` is a monotonic nonce. `request_flip` forwards
  `(client_seed, round, requested_slot)` as the callback's trailing
  `callback_args`, so the callback can bind itself to exactly the request it
  belongs to.
- `cancel_flip` bumps `round` and leaves `Requested`, so the cancelled
  request's callback fails `is_awaiting`. It is ignored if it arrives while the
  flip is `Cancelled` and also after a new request.

## Oracle queues

`request_flip` checks `oracle_queue` with `is_allowed_oracle_queue`. An
unrecognised queue is rejected with `InvalidOracleQueue`. **By default only the
base-layer queue is accepted.** The other queues need an explicit cargo feature
at build time:

| Queue (`ephemeral_rollups_sdk::vrf::consts`) | Address | Accepted when |
|----------------------------------------------|---------|---------------|
| `DEFAULT_QUEUE` (base layer) | `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh` | always |
| `DEFAULT_EPHEMERAL_QUEUE` | `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` | feature `ephemeral` |
| `DEFAULT_TEST_QUEUE` | `GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb` | feature `test-queue` |
| `DEFAULT_EPHEMERAL_TEST_QUEUE` | `Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT` | features `ephemeral` + `test-queue` |

Why the default is narrow:

- A request sent to a queue that is never fulfilled on the cluster leaves the
  flip `Requested` until the cancel timeout. The ephemeral queue is only
  fulfilled for accounts delegated to an ephemeral rollup, and this program does
  not delegate.
- Test queues may use known oracle keys, which makes outcomes predictable.
  **Never** enable `test-queue` for a deployment that settles value.

Only `DEFAULT_QUEUE` on **Solana devnet** is the target of this reference, and
it is the queue the [devnet deployment](#devnet-deployment) was tested on. **Mainnet queue addresses are unverified**: the SDK exposes a single
`DEFAULT_QUEUE` constant, and this repo has not confirmed that it is served on
mainnet. Check MagicBlock's documentation before any mainnet use (and see the
caveat at the top of this page).

## Building and testing

The crate has its own `Cargo.lock`, and both dependency requirements are exact
(`anchor-lang = "=0.32.1"`, `ephemeral-rollups-sdk = "=0.17.3"`). Always pass
`--locked`. From the **repository root**:

```bash
# host unit tests, lints, formatting
cargo test   --manifest-path reference/casino_fair/Cargo.toml --locked
cargo clippy --manifest-path reference/casino_fair/Cargo.toml --locked --all-targets -- -D warnings
cargo fmt    --manifest-path reference/casino_fair/Cargo.toml --check

# SBF program (Solana 2.3.x CLI, platform-tools v1.48 = Rust 1.84.1)
cargo build-sbf --manifest-path reference/casino_fair/Cargo.toml --tools-version v1.48 -- --locked
```

Or `cd reference/casino_fair` and drop `--manifest-path`. Either way the build
writes `reference/casino_fair/target/`, which is gitignored.

**The SBF build works on the pinned toolchain.** An earlier draft of this doc
said it could not. The cause was the *unpinned* lockfile: a fresh resolve picks
the newest `blake3` (1.8.7), which pulls `digest 0.11` / `crypto-common 0.2`
(Rust `edition2024`), and the newest Solana 3.x crates, which need Rust 1.89.
The committed `Cargo.lock` holds every crate at a release that builds with Rust
1.84.1 and no `edition2024` (for example `blake3 1.8.2`, `solana-hash 4.2.0`,
`solana-address 2.5.0`, `wincode 0.4.9`, `zeroize 1.8.2`). Do not run a bare
`cargo update`: it would bring those crates back up. `ephemeral-rollups-sdk`
is pinned to `0.17.3`, because every `0.16.x` pulls `ephemeral-vrf-sdk 0.4.1`,
which requires `solana-system-interface ^3.2`, and every release of that needs
Rust 1.89.

## Running it on devnet

The full request → fulfillment path needs a live VRF oracle. That exists on
devnet, not on a bare local validator. Rough manual steps:

1. Use the [deployed program](#devnet-deployment), or deploy your own: change
   `declare_id!` to your program keypair's address, build the SBF binary as
   above, and deploy `reference/casino_fair/target/deploy/casino_fair.so` with
   `solana program deploy --program-id <your-program-keypair.json>`.
2. `init_flip` once per player.
3. `request_flip(client_seed, guess)` with `oracle_queue = DEFAULT_QUEUE`. Watch
   for `FlipRequestedEvent`.
4. Poll the `Flip` account until `status == Settled`, then read `last_result`,
   `last_randomness` and `won`. Treat "still `Requested`" as *pending*, never as
   a result. If it is still `Requested` 150 slots after `requested_slot`, the
   player may `cancel_flip`.
5. `close_flip` when done to reclaim the rent.

[`scripts/devnet-smoke.ts`](../reference/casino_fair/scripts/devnet-smoke.ts)
runs these steps, plus negative checks, end to end; see
[Devnet smoke test](#devnet-smoke-test).

### Events can be truncated

All events are emitted with `emit!` (program logs) **only**, not `emit_cpi!`.
Solana truncates logs past the per-transaction limit, so a listener can miss an
event. The callback's account list is built by the VRF oracle, so it cannot
carry the `#[event_cpi]` accounts that `emit_cpi!` needs. For the same reason
the crate does not enable Anchor's `event-cpi` feature. Treat the `Flip`
account as the source of truth, and re-read it whenever an event might have
been missed.

## Devnet deployment

| Item | Value |
| ---- | ----- |
| Program ID | `CC3Nd2gwMHDf3FWUbwMxW4FWM4BTWubDyrU9AkoH2Eps` |
| Upgrade authority | `Hithh6rJmGiWRdkBsUKqJyDMnEos1fEb5baumpbYwEhr` |
| Deployed | slot 514372450, tx `4xDWkDHUCWVmKqj55oSgAy3MZKuCLcA8Tk5zbpTJc6WPwchYFasJAhSmdsPhQjhhBpWmZ6HxVsJ3ATxst3uSDxwd` |
| ProgramData | `BEx3XozSqF1AwmbUK7yaxFHsnFBjSSA2F1y8MTPvxGKp` (265,512 bytes) |
| `.so` SHA-256 | `4daaa89ad10127b8e83914d64bd5382ee7f82c28ee33c36c2d4b725937c2d5c7` |
| IDL account | `F2LaEMG9jJ6BpiA9sp1PLtaqVV66CB78pT7xhFnCqmwj` (`anchor idl init`, same authority) |
| Features | default (only `DEFAULT_QUEUE` is accepted) |

The binary is the `--locked` SBF build of this crate with default features,
and the bytes on-chain match it (`solana program dump`, then compare the
SHA-256 of the first 265,512 bytes).

The IDL committed at
[`reference/casino_fair/idl/casino_fair.json`](../reference/casino_fair/idl/casino_fair.json)
is the same document as the on-chain one (`anchor idl fetch
CC3Nd2gwMHDf3FWUbwMxW4FWM4BTWubDyrU9AkoH2Eps --provider.cluster devnet`). It
was generated with `anchor idl build`. The crate is outside the Anchor
workspace, so that needs a throwaway wrapper workspace whose `Anchor.toml`
lists `casino_fair` and whose root `Cargo.lock` is a copy of the crate's.
`anchor idl build` also "syncs" `declare_id!` to
`target/deploy/casino_fair-keypair.json` in that workspace, generating a fresh
keypair if there is none: point that path at the real program keypair (or
check the `address` in the output) before trusting the result. Regenerate the
IDL and `anchor idl upgrade` it whenever an instruction, account or event
changes.

### Devnet smoke test

[`reference/casino_fair/scripts/devnet-smoke.ts`](../reference/casino_fair/scripts/devnet-smoke.ts)
runs a live round trip against the deployed program with `ANCHOR_WALLET` as
the player. From the repository root, after `npm install`:

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=./keys/<player>.json \
npx ts-node --compiler-options '{"module":"commonjs"}' \
  reference/casino_fair/scripts/devnet-smoke.ts
```

Each check is a transaction on devnet:

1. `request_flip` on `DEFAULT_TEST_QUEUE` fails with `InvalidOracleQueue`
   (6003).
2. `request_flip` + `cancel_flip` in one transaction: the cancel fails with
   `CancelTooEarly` (6005). `request_flip` + `close_flip` in one transaction:
   the close fails with `CloseWhileRequested` (6006). The request shares the
   transaction because the oracle settles faster than a follow-up transaction
   lands. The failure rolls the request back too.
3. For each round (`FLIPS`, default 2): `request_flip` on `DEFAULT_QUEUE`.
   Then a `callback_flip` signed by the player as `vrf_program_identity`, with
   the live request's exact `(client_seed, round, requested_slot)` and
   randomness that makes the guess win, fails with Anchor `ConstraintAddress`
   (2012). Then the flip reaches `Settled` through the oracle's callback: the
   script finds that transaction, decodes its `FlipSettledEvent`, checks that
   the VRF program invoked `callback_flip`, and checks that the stored side is
   the parity of `last_randomness[31]`.
4. `close_flip` on the settled flip succeeds and returns the rent.

A run costs about 0.001 SOL in fees; the flip rent comes back. The script
exits non-zero if any check fails. It is not run in CI, because it needs a
funded devnet key and a live oracle.

**Observed on devnet on 2026-10-24, with the upgrade-authority key as the
player: 13/13 checks passed.**

| Check | Result | Transaction |
| ----- | ------ | ----------- |
| `init_flip` | ok | `61BevzBvHZe6Ss8D87ZC3dQKZiEcZVw1ADLmmRhBnchNYXKiBXSYt3xoBk4E5E73rZ32uAZKqCDhC5z9dNdCCnj7` |
| request on `DEFAULT_TEST_QUEUE` | 6003 | `5gxg3nGXCmZcabftcLbjCMHhtKPwcuW6daoWxQ3FrimGYGTmWmLNrGBA9X45UkV9LWkpu9XrZtHonXdWL5gumE1z` |
| request + cancel | 6005 at the cancel | `545Pn6Gm6gi23ZjwWxroWTsgo92LRUTgJmyTXyQq5fkQ4T2SjpgfWzcujiamYkrVXC2CFJgaoRgdAkdF13QNT6zr` |
| request + close | 6006 at the close | `3acLKdUEgUTpKxfxwsjQentNt5abMWhmpxp4RCm6ZjM4qsqEhQGqnPigxLD91kBmzQm9bbKPKY3WuNXjEh5MgdCb` |
| round 1 `request_flip` (TAILS, slot 514375367) | ok | `5uD1Y9FYM1NFK2t79e6k8gsR7hWp9sRrKptffTcFjbWMDuXJTegdt5BqHvNR1176F8rYNFztZtNvrduHJSp9qjgn` |
| round 1 spoofed callback | 2012 | `2f5wQwjJHyntJSKHCFrGirBuioKX5k5gdJb7vAVWFJxh6qQWHoBfCsGrU4hBAbL8NkEiPBcdHUn8kwyK1VTUinBV` |
| round 1 oracle callback | settled 4 slots after the request: TAILS, won | `661kkTZLdPLwsE6p2ng4uT1yGZzJexMGqSHh3dc4SRg5AUFoadhHMjsr4ZvZ592YQzoujsLhqjCP1EvqAN9m58ui` |
| round 2 `request_flip` (HEADS, slot 514375411) | ok | `4L25DVqayQCPkH2kuTfxe7fuweHqmZLjVAEwmpNtUCYYHr8wdvyV5BdE7Xg8aAfsUmJrNSftmkxUGkWPtamHRyhP` |
| round 2 spoofed callback | 2012 | `2UPADNjgmCvkfoYeCt7491onM76WaPqTCggwMUJukNctNK4UXWQrWh24xvMGuAe5b3Cjh5SwCuJ3UZzkjufE6Eys` |
| round 2 oracle callback | settled 3 slots after the request: HEADS, won | `4NT8JYBAfuFTTS71vxikvB9biq8tcUSZPFea8mb9WkF6zxDxkuG3g4V12x8PfZPSQ6i53AiXCVZGGrmMesnQtJEn` |
| `close_flip` (Settled) | ok, 0.00145288 SOL returned | `B4N87DxYyPDNYNM4SJrJVswQ5yWdDh9tdfF2CSKcTeBxN3HaShWBJ5mTJrypusPTaMmLGxpio3V8wdTo8QPHRS6` |

The fulfilment transactions are paid by the oracle key
`vrfkfM4uoisXZQPrFiS2brY4oMkU9EWjyvmvqaFd5AS`. They call the VRF program,
which CPIs `callback_flip` (about 13,500 compute units). Seven requests were
fulfilled across four runs. Each flip read back as `Settled` within about
1.2 s of its request confirming, and where the slots were measured the
callback landed 3 to 4 slots after the request. The oracle also sent extra fulfilment transactions for the
same requests that failed inside the VRF program (`Custom: 1`) without
reaching `callback_flip`. Those look like duplicate attempts by the oracle,
and they changed nothing.

## Testing

`cargo test --manifest-path reference/casino_fair/Cargo.toml --locked` runs 20
host unit tests. They exercise the real state machine: every transition is a
method on `Flip` that takes the slot as an argument, and the instruction
handlers are thin wrappers around those methods. Covered:

- request → callback settles once, for all four guess/result combinations; a
  duplicate delivery changes nothing;
- a callback with a wrong `client_seed`, stale or future `round`, or wrong
  `requested_slot` is ignored and writes nothing; so is a callback with no
  request in flight;
- a second request while `Requested` is rejected, and round overflow errors
  instead of wrapping;
- cancel is refused before `CANCEL_TIMEOUT_SLOTS` and allowed at it, bumps the
  round, and is refused when nothing is in flight; a late callback after cancel
  is ignored, both before and after a re-request and after close + re-init;
- close is refused only while `Requested`;
- the outcome is the parity of the last randomness byte: exactly 128 of the 256
  values land on each side, whatever the other bytes are;
- guess validation, account size (unchanged from the original layout), the
  oracle-queue allow-list per feature set, and that the request's
  `callback_args` encode exactly the `callback_flip` arguments.

**Not covered by the host tests:** the `#[vrf]` CPI and the `#[vrf_callback]`
signer gate. A bare validator has no VRF program, so the
[devnet smoke test](#devnet-smoke-test) checks these instead.
An earlier TypeScript suite claimed to cover the spoofed-callback rejection,
but it could not run (missing helpers, never-generated types) and would have
passed on any error. It was removed rather than kept as false assurance.

## Known limitations

- **No local fulfillment.** A bare local validator has no VRF oracle, so a real
  settled callback cannot be produced locally. This is a property of VRF, not a
  gap in the program.
- **Pinned transitive dependencies.** The SBF build relies on the committed
  `Cargo.lock`. Upgrading `ephemeral-rollups-sdk` or Anchor means re-pinning
  the transitive Solana 3.x crates to Rust-1.84-compatible versions, or moving
  to newer platform-tools.
