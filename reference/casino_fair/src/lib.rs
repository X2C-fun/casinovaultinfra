//! # Casino Fair
//!
//! **Not audited. Not for mainnet funds.**
//!
//! A minimal **coin-flip** reference program built on **MagicBlock VRF**. It is
//! the companion to `casino_vault`: the vault custodies funds, this program
//! shows how to settle a bet against verifiable randomness. Read the trust model
//! below — and `docs/fairness.md` — before trusting the word "fair".
//!
//! One PDA exists per player, `["flip", player]` ([`state::Flip`]). A flip runs
//! across **two separate transactions**:
//!
//! 1. `init_flip` — create the player's `Flip` PDA once.
//! 2. `request_flip(client_seed, guess)` — record the guess, bump the round and
//!    ask the VRF oracle for randomness. This only *accepts* the request.
//! 3. `callback_flip(randomness, client_seed, round, requested_slot)` — invoked
//!    later by the VRF oracle. It authenticates the oracle, maps the randomness
//!    to a coin side, computes the win and settles the round.
//!
//! Plus two player escape hatches: `cancel_flip` (only after
//! [`CANCEL_TIMEOUT_SLOTS`] with no callback) and `close_flip` (any state but
//! `Requested`; returns the rent).
//!
//! ## Trust model
//!
//! What the protocol *does* give you:
//!
//! * **Unbiasable randomness.** The coin side is a pure function of a VRF
//!   output. The oracle cannot *choose* that output: it is fixed by the
//!   oracle's key and the request input, and the VRF program verifies the proof
//!   before invoking the callback. The player cannot predict it, because they do
//!   not hold the oracle key.
//! * **But the oracle can predict and withhold.** The oracle computes the
//!   output, so it knows the result before anyone else, and it can decline to
//!   deliver it. Combined with `cancel_flip`, withholding is a re-roll: see
//!   `docs/fairness.md`.
//! * **`client_seed` is a one-byte request tag**, repeated into the VRF
//!   `caller_seed` and echoed back by the callback. It is not meaningful
//!   entropy and does not stop the oracle predicting the result.
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
//! * **It does not make cancel safe for stakes.** A stake's fate on cancel must
//!   not depend on the (unknown to the player, known to the oracle) outcome.
//! * **Idempotency is enforced here, but only for this account.** The callback
//!   settles a request at most once (see [`state::Flip::is_awaiting`]); binding
//!   that to an at-most-once *payout* is the integrator's job.

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
    /// per player (again only after `close_flip`).
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
    /// the `#[vrf_callback]` identity signer, bound to the flip account and to
    /// the `(client_seed, round, requested_slot)` of the request, and
    /// idempotent: a duplicate or stale callback is a no-op.
    pub fn callback_flip(
        ctx: Context<CallbackFlip>,
        randomness: [u8; 32],
        client_seed: u8,
        round: u64,
        requested_slot: u64,
    ) -> Result<()> {
        instructions::callback_flip::process_callback_flip(
            ctx,
            randomness,
            client_seed,
            round,
            requested_slot,
        )
    }

    /// Player-only: abandons an unfulfilled request once
    /// [`CANCEL_TIMEOUT_SLOTS`] have passed since it was made. Bumps the round
    /// so a late callback is ignored. A re-roll vector if stakes are attached.
    pub fn cancel_flip(ctx: Context<CancelFlip>) -> Result<()> {
        instructions::cancel_flip::process_cancel_flip(ctx)
    }

    /// Player-only: closes the flip account and returns its rent. Refused while
    /// a request is in flight.
    pub fn close_flip(ctx: Context<CloseFlip>) -> Result<()> {
        instructions::close_flip::process_close_flip(ctx)
    }
}
