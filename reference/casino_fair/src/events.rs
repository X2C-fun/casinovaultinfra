//! Events emitted by the flip lifecycle.
//!
//! These logs are the contract between the program and any backend listener,
//! mirroring the vault's convention: each event carries a timestamp and the
//! `round` it belongs to, so a request can be correlated with its outcome.
//!
//! ## `emit!` only — these events can be truncated
//!
//! Every event here is emitted with `emit!` (program logs) **only**. Solana
//! truncates logs past the per-transaction log limit, so a listener can miss
//! one of these events. The vault additionally emits via `emit_cpi!` (a
//! self-CPI that truncation cannot drop), but that needs the `#[event_cpi]`
//! accounts in every context, and the callback's account list is assembled by
//! the **VRF oracle**, not an Anchor client, so it never carries them.
//!
//! Treat the `Flip` account as the source of truth: a listener that may have
//! missed an event re-reads the account (`status`, `round`, `last_result`,
//! `last_randomness`). A production game should bind settlement to a vault
//! withdrawal, which does emit via CPI, rather than to these logs alone.
//!
//! As with the vault, event contents are NOT unique; de-duplicate on
//! `(transaction signature, instruction index, event index)`, never on fields.

use anchor_lang::prelude::*;

use crate::state::CoinSide;

/// Emitted by `request_flip` when a randomness request is accepted.
///
/// Acceptance is not fulfillment: seeing this event means the oracle was asked,
/// not that the flip has a result. The matching [`FlipSettledEvent`] (same
/// `player` + `round`) or [`FlipCancelledEvent`] ends the request.
#[event]
pub struct FlipRequestedEvent {
    /// Player whose flip this is.
    pub player: Pubkey,
    /// Request nonce this flip was issued under.
    pub round: u64,
    /// Side the player bet on (0 = HEADS, 1 = TAILS).
    pub guess: CoinSide,
    /// Slot the request was made in; the cancel timeout counts from here.
    pub requested_slot: u64,
    /// Unix timestamp of the enclosing slot.
    pub timestamp: i64,
}

/// Emitted by `callback_flip` when a round is settled.
///
/// Emitted at most once per request: the callback's guard makes a duplicate or
/// stale delivery a no-op that emits nothing.
#[event]
pub struct FlipSettledEvent {
    /// Player whose flip this is.
    pub player: Pubkey,
    /// Request nonce that was settled; matches the earlier
    /// [`FlipRequestedEvent`].
    pub round: u64,
    /// Side the player had bet on.
    pub guess: CoinSide,
    /// Side the verifiable randomness landed on.
    pub result: CoinSide,
    /// Whether the player won (`result == guess`).
    pub won: bool,
    /// Unix timestamp of the enclosing slot.
    pub timestamp: i64,
}

/// Emitted by `cancel_flip` when the player abandons an unfulfilled request
/// after the timeout. No outcome exists for `round`; a late callback for it is
/// ignored.
#[event]
pub struct FlipCancelledEvent {
    /// Player whose flip this is.
    pub player: Pubkey,
    /// The request nonce that was cancelled.
    pub round: u64,
    /// Slot the cancelled request was made in.
    pub requested_slot: u64,
    /// Unix timestamp of the enclosing slot.
    pub timestamp: i64,
}
