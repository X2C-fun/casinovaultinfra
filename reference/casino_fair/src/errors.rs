//! Custom error codes returned by the program.
//!
//! Anchor offsets user-defined errors by `6000`, so `InvalidGuess` is `6000`,
//! `RequestInProgress` is `6001`, and so on. Match on the numeric codes, not on
//! strings. New variants are only ever appended so existing codes never change.

use anchor_lang::prelude::*;

/// Errors produced by the casino fair coin-flip program.
#[error_code]
pub enum FairError {
    /// `guess` was not a valid coin side. Only `0` (HEADS) and `1` (TAILS) are
    /// accepted.
    #[msg("Invalid guess: must be 0 (HEADS) or 1 (TAILS)")]
    InvalidGuess,

    /// `request_flip` was called while a previous request was still awaiting
    /// its callback. One flip at a time per player.
    #[msg("A randomness request is already in flight for this player")]
    RequestInProgress,

    /// A checked arithmetic operation overflowed. In practice only the round
    /// counter can reach this, and only after `u64::MAX` flips.
    #[msg("Arithmetic overflow")]
    MathOverflow,

    /// The supplied oracle queue is not one of the recognised VRF queues.
    ///
    /// Reserved for clients: the queue is pinned by an account constraint on
    /// [`crate::RequestFlip`], so a bad queue is rejected before the handler
    /// runs. Clients should surface this code when they see that constraint
    /// fail.
    #[msg("Unrecognised VRF oracle queue")]
    InvalidOracleQueue,

    /// `cancel_flip` was called while no request is in flight.
    #[msg("No randomness request is in flight for this player")]
    NoRequestInFlight,

    /// `cancel_flip` was called before `CANCEL_TIMEOUT_SLOTS` slots had passed
    /// since the request. The oracle gets that long to fulfil first.
    #[msg("The cancel timeout has not elapsed yet")]
    CancelTooEarly,

    /// `close_flip` was called while a request is in flight. Wait for the
    /// callback, or cancel after the timeout, then close.
    #[msg("Cannot close a flip while a randomness request is in flight")]
    CloseWhileRequested,
}
