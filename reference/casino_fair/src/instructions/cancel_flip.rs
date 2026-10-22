//! `cancel_flip` — abandon a request the oracle has not fulfilled in time.

use anchor_lang::prelude::*;

use crate::constants::FLIP_SEED;
use crate::events::FlipCancelledEvent;
use crate::state::Flip;
use crate::utils::{current_slot, current_timestamp};

/// Accounts for [`process_cancel_flip`].
#[derive(Accounts)]
pub struct CancelFlip<'info> {
    /// The player. Only the owner of the flip can cancel it.
    pub player: Signer<'info>,

    /// The player's flip PDA; the seeds bind it to `player`.
    #[account(
        mut,
        seeds = [FLIP_SEED, player.key().as_ref()],
        bump = flip.bump,
    )]
    pub flip: Account<'info, Flip>,
}

/// Moves a `Requested` flip to `Cancelled` once
/// [`crate::constants::CANCEL_TIMEOUT_SLOTS`] have passed since the request,
/// and bumps the round so the abandoned request's callback is ignored if it
/// ever arrives.
///
/// **Re-roll vector.** Whoever sees the pending outcome first (the oracle
/// computes it) can withhold the callback and let the player cancel and try
/// again. An integrator that attaches a stake must make the stake's fate on
/// cancel independent of the outcome (a fixed refund or forfeit). See
/// the repository's `docs/fairness.md`.
pub fn process_cancel_flip(ctx: Context<CancelFlip>) -> Result<()> {
    let flip = &mut ctx.accounts.flip;
    let cancelled_round = flip.cancel(current_slot()?)?;

    emit!(FlipCancelledEvent {
        player: flip.player,
        round: cancelled_round,
        requested_slot: flip.requested_slot,
        timestamp: current_timestamp()?,
    });
    Ok(())
}
