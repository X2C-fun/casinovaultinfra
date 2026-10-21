//! # Casino Fair
//!
//! A minimal, provably-fair **coin-flip** reference program built on
//! **MagicBlock VRF** for verifiable randomness. It is the companion to
//! `casino_vault`: the vault custodies funds, this program shows how to settle
//! a bet against randomness nobody — not the player, not the house, not the
//! oracle — could have predicted or biased.
//!
//! One PDA exists per player, `["flip", player]` ([`state::Flip`]). A flip runs
//! in three steps across **two separate transactions**:
//!
//! 1. `init_flip` — create the player's `Flip` PDA once.
//! 2. `request_flip(client_seed, guess)` — record the guess, bump the round and
//!    ask the VRF oracle for randomness. This only *accepts* the request.
//! 3. `callback_flip(randomness, client_seed, round)` — invoked later by the
//!    VRF oracle. It authenticates the oracle, maps the randomness to a coin
//!    side, computes the win and settles the round.
//!
//! ## Trust model — read this before trusting the word "fair"
//!
//! What the protocol *does* guarantee:
//!
//! * **Verifiable randomness.** The coin side comes from a VRF the oracle
//!   cannot bias and the player cannot predict. `caller_seed` folds in client
//!   entropy so neither side alone chooses the input.
//! * **Authenticated settlement.** The `#[vrf_callback]` macro injects a
//!   `vrf_program_identity` signer bound to this program's scoped identity PDA.
//!   Without it the callback would accept *spoofed* randomness from anyone, so
//!   the macro is security-critical and is present on [`CallbackFlip`].
//!
//! What this program deliberately does **not** do, and a real game **must**:
//!
//! * **It does not move money.** `bet` is a recorded placeholder, not escrow. A
//!   production game must bind the flip to a `casino_vault` settlement so the
//!   payout cannot happen without the matching flip result, and the flip cannot
//!   be replayed against a second payout.
//! * **It does not handle a callback that never arrives.** Request and callback
//!   are *separate executions*: a successful `request_flip` means the oracle
//!   accepted the work, not that it was fulfilled. A real integrator needs an
//!   explicit timeout, a retry/cancel path, and a UI state of "randomness
//!   pending" rather than a final result. Acceptance is not fulfillment.
//! * **Idempotency is enforced here, but only for this account.** The callback
//!   settles a round exactly once (see [`state::Flip::is_awaiting`]); binding
//!   that to an at-most-once *payout* is the integrator's job.
//!
//! In short: the randomness and the settlement identity are trustless; the
//! economics around them are not part of this reference primitive.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod utils;

pub use constants::*;
pub use errors::FairError;
pub use events::*;
pub use instructions::*;
pub use state::{CoinSide, Flip, FlipStatus};

declare_id!("2HgWBqXqBzNCjTrPFtWEAknfRSJF6TFKaZgnfZ7mK3MG");

#[program]
pub mod casino_fair {
    use super::*;

    /// Creates the caller's singleton `Flip` PDA in the `Idle` state. Run once
    /// per player; a second call is rejected by Anchor's `init` constraint.
    pub fn init_flip(ctx: Context<InitFlip>) -> Result<()> {
        instructions::init_flip::process_init_flip(ctx)
    }

    /// Commits `client_seed` and `guess` (0 = HEADS, 1 = TAILS), bumps the
    /// round and asks the VRF oracle for randomness. Rejected while a request
    /// is already in flight — no concurrent flips.
    pub fn request_flip(ctx: Context<RequestFlip>, client_seed: u8, guess: u8) -> Result<()> {
        instructions::request_flip::process_request_flip(ctx, client_seed, guess)
    }

    /// VRF callback. Invoked by the oracle (never the client). Authenticated by
    /// the `#[vrf_callback]` identity signer, bound to the flip account and the
    /// `round` it was requested for, and idempotent: a duplicate or stale
    /// callback is a no-op. Settles the round and emits [`FlipSettledEvent`].
    pub fn callback_flip(
        ctx: Context<CallbackFlip>,
        randomness: [u8; 32],
        client_seed: u8,
        round: u64,
    ) -> Result<()> {
        instructions::callback_flip::process_callback_flip(ctx, randomness, client_seed, round)
    }
}
