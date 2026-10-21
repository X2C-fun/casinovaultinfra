# Provable fairness (`casino_fair`)

`casino_fair` is a minimal, self-contained **coin-flip** reference program built
on **MagicBlock VRF**. It is the fairness companion to `casino_vault`: the vault
custodies money, this program shows how to settle a bet against randomness that
nobody — not the player, not the house, not the oracle — could predict or bias.
It is a *primitive*, not a game: it does not move funds. The honesty of this doc
is the point, so it is explicit about what the program guarantees and what an
integrator still has to build.

- **Program:** `programs/casino_fair`
- **Program ID:** `2HgWBqXqBzNCjTrPFtWEAknfRSJF6TFKaZgnfZ7mK3MG`
- **State:** one `Flip` PDA per player, `["flip", player]`.

> **Standalone crate, by design.** `casino_fair` is intentionally **not** a
> member of the Cargo workspace and is **not** built by `anchor build` (see the
> comment in the root `Cargo.toml` and the toolchain limitation at the bottom of
> this doc). Build and test it from its own directory: `cd programs/casino_fair`.
> This keeps the vault's build, `Cargo.lock`, and CI exactly as they were.

## What it does

A flip runs in three steps across **two transactions**:

| Step | Instruction | Signer | Effect |
|------|-------------|--------|--------|
| 1 | `init_flip` | player | Creates the player's `Flip` PDA in `Idle`. Once per player. |
| 2 | `request_flip(client_seed, guess)` | player | Validates the guess (`0 = HEADS`, `1 = TAILS`), bumps the round, records the guess + seed, sets `Requested`, and CPIs the VRF oracle for randomness. |
| 3 | `callback_flip(randomness, client_seed, round)` | **VRF oracle** | Authenticated by the scoped VRF identity, bound to this flip and round, idempotent. Maps the randomness to a side, computes `won = result == guess`, sets `Settled`. |

Both steps emit an event (`FlipRequestedEvent`, `FlipSettledEvent`) carrying the
`player` and `round`, so a request can be correlated with its settlement.

## Trust model

### What the protocol guarantees

- **Verifiable randomness.** The coin side is derived from a MagicBlock VRF
  output the oracle cannot bias and the player cannot predict. `caller_seed`
  folds in client entropy (`[client_seed; 32]`), so neither party alone chooses
  the VRF input. The settled `last_randomness` is stored on-chain, so anyone can
  re-run the mapping and check the result is the one the randomness dictates.
- **Authenticated settlement.** The callback context carries the `#[vrf_callback]`
  macro, which injects a `vrf_program_identity` signer bound to this program's
  scoped identity PDA. That signer is the whole security of the callback: without
  the macro the instruction still compiles, but anyone could call `callback_flip`
  with randomness of their choosing and settle a flip in their favour. The
  `tests/casino_fair.ts` spoofed-callback test exists to prove it is enforced.

### What the integrator must still do

The protocol secures the *randomness* and the *settlement identity*. It does not
secure the *economics*. A real game must add:

- **Binding to settlement.** `Flip.bet` is a documented placeholder, not escrow.
  `casino_fair` never touches lamports. Bind the flip result to a `casino_vault`
  withdrawal so a payout cannot happen without the matching flip, and a flip
  cannot be replayed against a second payout.
- **Timeout and recovery.** Request and callback are *separate executions*. A
  successful `request_flip` means the oracle *accepted* the work, not that it was
  *fulfilled* — **acceptance is not fulfillment.** If the callback never arrives,
  the flip sits in `Requested` forever. A production integrator needs an explicit
  timeout, a retry/cancel path, and a UI state of "randomness pending" rather
  than a shown result.
- **At-most-once payout.** `callback_flip` is idempotent *for this account*: it
  settles a round exactly once (`Flip::is_awaiting` gates on `status == Requested`
  and a matching `round`, so a duplicate or a stale post-retry callback is a
  no-op). Binding that to an at-most-once *payout* is still the integrator's job.

## Request → callback lifecycle

```
init_flip        request_flip(seed, guess)              callback_flip(rnd, seed, round)
   │                   │                                        │  (invoked by the oracle)
   ▼                   ▼                                        ▼
 Idle ───────────► Requested(round = n) ───────────────────► Settled(round = n)
                       │  guess + seed committed,               won = result == guess
                       │  round bumped, VRF CPI fired           last_randomness stored
                       │
                       └─ a 2nd request while Requested → rejected (RequestInProgress)
```

- The `round` is a monotonic nonce. `request_flip` forwards `(client_seed, round)`
  as the callback's trailing `callback_args`, so the callback can bind itself to
  exactly the request it belongs to.
- A late callback for a superseded round (`round` no longer the live one) fails
  `is_awaiting` and is ignored, so a retry cannot be satisfied by a stale
  delivery.

## Oracle queues

Request randomness from the queue that matches where the transaction runs.
`request_flip` pins `oracle_queue` to the recognised queues via an account
constraint; an unrecognised queue is rejected with `InvalidOracleQueue`.

| Network  | Base-layer queue (`DEFAULT_QUEUE`)            | Delegated / ER queue (`DEFAULT_EPHEMERAL_QUEUE`) |
|----------|-----------------------------------------------|--------------------------------------------------|
| Devnet   | `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh`| `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc`   |
| Mainnet  | same as devnet                                | same as devnet                                   |
| Localnet | `GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb` (`DEFAULT_TEST_QUEUE`) | `Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT` (`DEFAULT_EPHEMERAL_TEST_QUEUE`) |

For base-layer (Solana devnet) requests use `DEFAULT_QUEUE`. Prefer the
`ephemeral_rollups_sdk::vrf::consts` constants over hardcoding these addresses;
the table is for reference and for the client.

## Running it on devnet

The full request → fulfillment path needs a live VRF oracle, which only exists
on devnet/mainnet or an ephemeral rollup — not on a bare local validator. Rough
manual steps on devnet:

1. On a toolchain that can produce the SBF binary (see the limitation below),
   build the crate (`cd programs/casino_fair && cargo build-sbf`) and deploy it
   with `solana program deploy` / `anchor deploy` under program ID
   `2HgWBqXqBzNCjTrPFtWEAknfRSJF6TFKaZgnfZ7mK3MG`. (To drive it through Anchor
   instead, temporarily add `casino_fair` back to the workspace members and the
   `[programs.*]` tables — it is left out only so the pinned toolchain's
   `anchor build` keeps working.)
2. `init_flip` once per player.
3. `request_flip(client_seed, guess)` with `oracle_queue = DEFAULT_QUEUE`. Watch
   for `FlipRequestedEvent`.
4. Wait for the oracle to deliver `callback_flip`. Poll the `Flip` account until
   `status == Settled`, then read `last_result`, `last_randomness` and `won`, and
   watch for `FlipSettledEvent`. Treat "still `Requested`" as *pending*, never as
   a result.

## Testing

- **Rust unit tests** — from the crate directory (`cd programs/casino_fair &&
  cargo test`, host toolchain) — cover the pure logic: the randomness →
  coin-side mapping, the `won` computation, guess validation, the account
  layout, and the idempotency guard (`is_awaiting` accepts exactly the live
  round — a duplicate or post-retry callback is rejected). These run today and
  pass (7 tests).
- **`programs/casino_fair/tests/casino_fair.ts`** covers what a validator with
  the program deployed can reach: `init_flip`, the pre-CPI `request_flip`
  validation (`InvalidGuess`, `InvalidOracleQueue`), and the spoofed-callback
  rejection that proves the `#[vrf_callback]` identity gate. The happy path
  (request → oracle → settle) and the `RequestInProgress` double-request guard
  are `it.skip`, because they need the VRF oracle; run them as the devnet
  integration above. It lives under the crate (not the root `tests/`) so it
  never runs in the vault's `anchor test`, and needs the IDL/types that only a
  successful SBF build produces (see the toolchain limitation below).

## Known limitations

- **No local fulfillment.** A bare local validator has no VRF oracle, so a real
  settled callback cannot be produced locally. This is a property of VRF, not a
  gap in the program.
- **Local build limitation (toolchain).** `cargo check -p casino_fair` and
  `cargo test -p casino_fair` succeed on the host Cargo. The SBF program build
  (`anchor build` / `cargo build-sbf`) **fails on this machine**: the MagicBlock
  SDK's dependency tree
  (`ephemeral-rollups-sdk → solana-program → solana-blake3-hasher → blake3 →
  digest 0.11 → crypto-common 0.2.2`) pulls a crate that requires Rust
  `edition2024`, which the installed Solana platform-tools Cargo (1.84) cannot
  parse:

  ```text
  error: failed to download `crypto-common v0.2.2`
    feature `edition2024` is required
    The package requires the Cargo feature called `edition2024`, but that
    feature is not stabilized in this version of Cargo (1.84.0).
  ```

  `blake3 1.8.7` strictly requires `crypto-common 0.2`, so pinning back to
  `0.1.7` is not an option. Producing the SBF binary (and therefore the IDL)
  needs platform-tools whose Cargo understands `edition2024` (a newer
  platform-tools / nightly). `casino_vault` and `cpi_probe` are unaffected and
  still build per-program (`anchor build -p casino_vault`); only `casino_fair`'s
  SDK tree hits this.
