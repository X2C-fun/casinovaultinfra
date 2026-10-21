//! `callback_flip` — the VRF oracle's settlement callback.
//!
//! This is never called by a client: the VRF oracle invokes it once it has
//! produced the randomness for a `request_flip`. Everything that makes it safe
//! lives in the account context and the guard below.

use anchor_lang::prelude::*;

use ephemeral_rollups_sdk::anchor::vrf_callback;

use crate::constants::FLIP_SEED;
use crate::events::FlipSettledEvent;
use crate::state::{coin_side_from_randomness, Flip, FlipStatus};
use crate::utils::current_timestamp;

/// Accounts for [`process_callback_flip`].
///
/// `#[vrf_callback]` injects a `vrf_program_identity: Signer` bound to this
/// program's scoped identity PDA. That signer is the whole security of the
/// callback: without the macro the struct still compiles, but anyone could call
/// `callback_flip` with randomness of their choosing and settle a flip in their
/// favour. It MUST stay.
#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackFlip<'info> {
    /// The flip being settled. Re-derived from the player recorded in the
    /// account, so the oracle-supplied account must be the canonical PDA — the
    /// callback cannot be redirected onto a different flip.
    #[account(
        mut,
        seeds = [FLIP_SEED, flip.player.as_ref()],
        bump = flip.bump,
    )]
    pub flip: Account<'info, Flip>,
}

/// Settles the round `randomness` was produced for, exactly once.
///
/// `client_seed` and `round` are the trailing `callback_args` the request
/// forwarded (see `request_flip`). They bind this callback to one specific
/// request:
///
/// * `round` + status must match the live request ([`Flip::is_awaiting`]). A
///   duplicate callback (already `Settled`) or a stale one (a superseded round
///   after a retry) fails this and the handler returns `Ok` without touching
///   state — settlement is idempotent.
/// * `client_seed` must equal the seed committed at request time, so a callback
///   carrying a mismatched seed cannot settle the round either.
pub fn process_callback_flip(
    ctx: Context<CallbackFlip>,
    randomness: [u8; 32],
    client_seed: u8,
    round: u64,
) -> Result<()> {
    let flip = &mut ctx.accounts.flip;

    // Idempotency + request binding. A valid VRF identity is necessary but not
    // sufficient: the callback must also be the one this account is waiting for.
    if !flip.is_awaiting(round) || flip.client_seed != client_seed {
        msg!(
            "Ignoring VRF callback: arg round={} seed={} vs live round={} seed={} status={:?}",
            round,
            client_seed,
            flip.round,
            flip.client_seed,
            flip.status
        );
        return Ok(());
    }

    // Map the verifiable randomness to a coin side and settle.
    let result = coin_side_from_randomness(&randomness);
    let won = result == flip.guess;

    flip.last_result = result;
    flip.last_randomness = randomness;
    flip.won = won;
    flip.status = FlipStatus::Settled;

    emit!(FlipSettledEvent {
        player: flip.player,
        round,
        guess: flip.guess,
        result,
        won,
        timestamp: current_timestamp()?,
    });

    Ok(())
}
