//! `init_flip` — create the caller's per-player `Flip` PDA.

use anchor_lang::prelude::*;

use crate::constants::FLIP_SEED;
use crate::state::Flip;

/// Accounts for [`process_init_flip`].
#[derive(Accounts)]
pub struct InitFlip<'info> {
    /// The player. Pays rent for their own flip account and is bound into its
    /// PDA seeds, so one player can never create another player's account.
    #[account(mut)]
    pub player: Signer<'info>,

    /// The player's singleton flip PDA, `["flip", player]`. `init` makes this
    /// run once per player (again only after `close_flip`).
    #[account(
        init,
        payer = player,
        space = Flip::SIZE,
        seeds = [FLIP_SEED, player.key().as_ref()],
        bump,
    )]
    pub flip: Account<'info, Flip>,

    pub system_program: Program<'info, System>,
}

/// Initialises the flip account in the `Idle` state with an empty history.
pub fn process_init_flip(ctx: Context<InitFlip>) -> Result<()> {
    let player = ctx.accounts.player.key();
    ctx.accounts
        .flip
        .set_inner(Flip::new(player, ctx.bumps.flip));
    msg!("Flip account initialized for player {}", player);
    Ok(())
}
