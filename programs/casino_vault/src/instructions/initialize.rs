//! `initialize` — create the singleton vault state and pool vault.

use anchor_lang::prelude::*;

use crate::constants::{POOL_VAULT_SEED, VAULT_STATE_SEED};
use crate::events::VaultInitializedEvent;
use crate::state::VaultState;
use crate::utils::{current_timestamp, pool_vault_rent_reserve, transfer_into_vault};

/// Accounts for [`process_initialize`].
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// Backend authority being registered. It signs, so nobody can register an
    /// admin key they do not control, and it pays the rent for both PDAs.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Singleton state PDA, `["vault_state"]`. `init` makes this instruction
    /// run exactly once for the lifetime of the program.
    #[account(
        init,
        payer = admin,
        space = VaultState::SIZE,
        seeds = [VAULT_STATE_SEED],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Singleton pool vault PDA, `["pool_vault"]`. Stays system-owned and
    /// data-less so the System Program can move lamports out of it under its
    /// seed.
    #[account(
        mut,
        seeds = [POOL_VAULT_SEED],
        bump,
    )]
    pub pool_vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Records the admin and the pool vault bump, starts unpaused, and parks the
/// pool vault's rent-exempt minimum.
pub fn process_initialize(ctx: Context<Initialize>) -> Result<()> {
    let admin_key = ctx.accounts.admin.key();

    let vault_state = &mut ctx.accounts.vault_state;
    vault_state.admin = admin_key;
    vault_state.vault_bump = ctx.bumps.pool_vault;
    vault_state.paused = false;

    // Top the pool vault up to its rent-exempt minimum. The account may already
    // hold lamports if somebody transferred to the address beforehand, so only
    // the shortfall is paid and a prefunded address can never block setup.
    let rent_reserve = pool_vault_rent_reserve()?;
    let shortfall = rent_reserve.saturating_sub(ctx.accounts.pool_vault.lamports());
    if shortfall > 0 {
        transfer_into_vault(
            &ctx.accounts.system_program,
            &ctx.accounts.admin,
            &ctx.accounts.pool_vault,
            shortfall,
        )?;
    }

    emit!(VaultInitializedEvent {
        admin: admin_key,
        vault_bump: vault_state.vault_bump,
        rent_reserve,
        timestamp: current_timestamp()?,
    });

    msg!("Pool vault initialized with admin {}", admin_key);
    Ok(())
}
