//! Events emitted by the flip lifecycle.
//!
//! These logs are the contract between the program and any backend listener,
//! mirroring the vault's convention: each event carries a timestamp and the
//! `round` it belongs to, so a request can be correlated with its settlement.
//!
//! ## Why `emit!` only (and not the vault's dual `emit!` + `emit_cpi!`)
//!
//! The vault emits every event twice — once with `emit!` (program logs) and
//! once with `emit_cpi!` (a self-CPI that log truncation cannot drop) — because
//! its contexts are plain client instructions where the `#[event_cpi]` accounts
//! can be threaded through. The flip contexts cannot: the request context is
//! owned by the `#[vrf]` macro and the callback context by `#[vrf_callback]`,
//! and the callback's account list is assembled by the **VRF oracle**, not an
//! Anchor client, so it never carries the `event_authority` accounts a
//! `emit_cpi!` self-CPI needs. Stacking `#[event_cpi]` onto those macros and
//! smuggling its accounts through the oracle's `accounts_metas` is out of scope
//! for a reference primitive, so both events use `emit!`. A production listener
//! that cannot tolerate log truncation should bind settlement to a vault
//! withdrawal (which *does* emit via CPI) rather than to these logs alone.
//!
//! As with the vault, event contents are NOT unique; de-duplicate on
//! `(transaction signature, instruction index, event index)`, never on fields.

use anchor_lang::prelude::*;

use crate::state::CoinSide;

/// Emitted by `request_flip` when a randomness request is accepted.
///
/// Acceptance is not fulfillment: seeing this event means the oracle was asked,
/// not that the flip has a result. The matching [`FlipSettledEvent`] (same
/// `player` + `round`) is the only proof of an outcome.
#[event]
pub struct FlipRequestedEvent {
    /// Player whose flip this is.
    pub player: Pubkey,
    /// Request nonce this flip was issued under.
    pub round: u64,
    /// Side the player bet on (0 = HEADS, 1 = TAILS).
    pub guess: CoinSide,
    /// Unix timestamp of the enclosing slot.
    pub timestamp: i64,
}

/// Emitted by `callback_flip` when a round is settled.
///
/// Emitted at most once per `round`: the callback's idempotency guard makes a
/// duplicate or stale delivery a no-op that emits nothing.
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
