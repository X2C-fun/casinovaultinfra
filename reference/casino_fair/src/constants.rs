//! Program-wide constants.
//!
//! There is one `Flip` PDA per player, derived from a fixed seed prefix and the
//! player's key. Defining the seed once here keeps the request and callback
//! contexts deriving the very same address.

/// Seed prefix of the per-player [`crate::state::Flip`] PDA.
///
/// Full seeds: `["flip", player]`
pub const FLIP_SEED: &[u8] = b"flip";
