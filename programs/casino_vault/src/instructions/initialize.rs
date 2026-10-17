//! `initialize` — create the singleton vault state, guarded by the program's
//! upgrade authority.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;

use crate::constants::{POOL_VAULT_SEED, VAULT_STATE_SEED};
use crate::errors::VaultError;
use crate::events::VaultInitializedEvent;
use crate::state::VaultState;
use crate::utils::{current_timestamp, pool_vault_rent_reserve, transfer_into_vault};

/// Accounts for [`process_initialize`].
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// The program's upgrade authority. Only this key can initialize, so a
    /// third party watching the deploy cannot front-run `initialize` and
    /// become admin. Pays the rent for the state account and any pool vault
    /// shortfall.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Backend authority being registered. It must sign, so nobody can
    /// register an admin key they do not control. May be the same key as
    /// `authority`, though keeping them separate is recommended.
    pub admin: Signer<'info>,

    /// This program's program data account, which records the upgrade
    /// authority. The seed check ties it to this program ID.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ VaultError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,

    /// Singleton state PDA, `["vault_state_v2"]`. `init` makes this
    /// instruction run exactly once for the lifetime of the program.
    #[account(
        init,
        payer = authority,
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

/// Records the admin and the pool vault bump, starts unpaused with no caps,
/// and tops the pool vault up to its rent-exempt minimum.
pub fn process_initialize(ctx: Context<Initialize>) -> Result<()> {
    let admin_key = ctx.accounts.admin.key();
    let now = current_timestamp()?;

    let vault_state = &mut ctx.accounts.vault_state;
    vault_state.admin = admin_key;
    vault_state.vault_bump = ctx.bumps.pool_vault;
    vault_state.paused = false;
    vault_state.pending_admin = None;
    vault_state.max_withdraw_per_tx = 0;
    vault_state.max_withdraw_per_window = 0;
    vault_state.window_seconds = 0;
    vault_state.window_start = now;
    vault_state.window_withdrawn = 0;
    vault_state.reserved = [0; 64];

    // The pool may already hold lamports — a transfer to the address before
    // setup, or the whole balance of a v0.1 deployment upgraded in place — so
    // only the shortfall is paid and a prefunded address never blocks setup.
    let rent_reserve = pool_vault_rent_reserve()?;
    let shortfall = rent_reserve.saturating_sub(ctx.accounts.pool_vault.lamports());
    if shortfall > 0 {
        transfer_into_vault(
            &ctx.accounts.system_program,
            &ctx.accounts.authority,
            &ctx.accounts.pool_vault,
            shortfall,
        )?;
    }

    emit!(VaultInitializedEvent {
        authority: ctx.accounts.authority.key(),
        admin: admin_key,
        vault_bump: vault_state.vault_bump,
        rent_reserve,
        vault_balance: ctx.accounts.pool_vault.lamports(),
        timestamp: now,
    });

    msg!("Pool vault initialized with admin {}", admin_key);
    Ok(())
}
