//! `close_flip` — close the player's flip account and return its rent.

use anchor_lang::prelude::*;

use crate::constants::FLIP_SEED;
use crate::state::Flip;

/// Accounts for [`process_close_flip`].
#[derive(Accounts)]
pub struct CloseFlip<'info> {
    /// The player. Receives the account's lamports.
    #[account(mut)]
    pub player: Signer<'info>,

    /// The player's flip PDA; the seeds bind it to `player`. Anchor's `close`
    /// zeroes the data and moves all lamports to `player` after the handler.
    #[account(
        mut,
        seeds = [FLIP_SEED, player.key().as_ref()],
        bump = flip.bump,
        close = player,
    )]
    pub flip: Account<'info, Flip>,
}

/// Refused while a request is in flight (the oracle would be writing to a
/// closed account); allowed in every other state. Wait for the callback, or
/// `cancel_flip` after the timeout, first.
pub fn process_close_flip(ctx: Context<CloseFlip>) -> Result<()> {
    ctx.accounts.flip.ensure_closable()?;
    msg!(
        "Flip account closed for player {}",
        ctx.accounts.player.key()
    );
    Ok(())
}
