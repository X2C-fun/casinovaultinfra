//! `init_flip` — create the caller's per-player `Flip` PDA.

use anchor_lang::prelude::*;

use crate::constants::FLIP_SEED;
use crate::state::{CoinSide, Flip, FlipStatus};

/// Accounts for [`process_init_flip`].
#[derive(Accounts)]
pub struct InitFlip<'info> {
    /// The player. Pays rent for their own flip account and is bound into its
    /// PDA seeds, so one player can never create another player's account.
    #[account(mut)]
    pub player: Signer<'info>,

    /// The player's singleton flip PDA, `["flip", player]`. `init` makes this
    /// run exactly once per player.
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
    let flip = &mut ctx.accounts.flip;
    flip.player = ctx.accounts.player.key();
    flip.status = FlipStatus::Idle;
    flip.round = 0;
    flip.client_seed = 0;
    flip.guess = CoinSide::Heads;
    flip.bet = 0;
    flip.last_result = CoinSide::Heads;
    flip.last_randomness = [0; 32];
    flip.won = false;
    flip.bump = ctx.bumps.flip;
    flip.reserved = [0; 64];

    msg!("Flip account initialized for player {}", flip.player);
    Ok(())
}
