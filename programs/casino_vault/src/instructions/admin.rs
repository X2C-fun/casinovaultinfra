//! Upgrade-authority controls: two-step admin rotation and withdrawal caps.
//!
//! These are deliberately *not* callable by the admin. The admin key is hot
//! (it lives in the backend); the upgrade authority should be cold or a
//! multisig. If the admin key leaks, the upgrade authority can rotate it, and
//! the leaked key can neither rotate itself back in nor lift the caps.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;

use crate::constants::VAULT_STATE_SEED;
use crate::errors::VaultError;
use crate::events::{AdminChangedEvent, AdminProposedEvent, LimitsUpdatedEvent};
use crate::state::VaultState;
use crate::utils::current_timestamp;

/// Accounts for [`process_propose_admin`].
#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    /// The program's upgrade authority.
    pub authority: Signer<'info>,

    /// This program's program data account, proving `authority`.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ VaultError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,

    #[account(mut, seeds = [VAULT_STATE_SEED], bump)]
    pub vault_state: Account<'info, VaultState>,
}

/// Records `new_admin` as pending, or clears the pending admin when `None`.
///
/// The current admin stays in force until the pending admin signs
/// `accept_admin`, so a typo in the proposal can never lock the vault.
pub fn process_propose_admin(ctx: Context<ProposeAdmin>, new_admin: Option<Pubkey>) -> Result<()> {
    if let Some(key) = new_admin {
        require!(key != Pubkey::default(), VaultError::InvalidAdmin);
    }

    let vault_state = &mut ctx.accounts.vault_state;
    vault_state.pending_admin = new_admin;

    emit!(AdminProposedEvent {
        authority: ctx.accounts.authority.key(),
        current_admin: vault_state.admin,
        pending_admin: new_admin,
        timestamp: current_timestamp()?,
    });
    Ok(())
}

/// Accounts for [`process_accept_admin`].
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    /// The pending admin, proving it controls the proposed key.
    pub new_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_STATE_SEED],
        bump,
        constraint = vault_state.pending_admin == Some(new_admin.key())
            @ VaultError::NotPendingAdmin,
    )]
    pub vault_state: Account<'info, VaultState>,
}

/// Makes the pending admin the admin and clears the proposal.
pub fn process_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let vault_state = &mut ctx.accounts.vault_state;
    let previous_admin = vault_state.admin;
    let new_admin = ctx.accounts.new_admin.key();

    vault_state.admin = new_admin;
    vault_state.pending_admin = None;

    emit!(AdminChangedEvent {
        previous_admin,
        new_admin,
        timestamp: current_timestamp()?,
    });

    msg!("Admin changed from {} to {}", previous_admin, new_admin);
    Ok(())
}

/// Accounts for [`process_set_limits`].
#[derive(Accounts)]
pub struct SetLimits<'info> {
    /// The program's upgrade authority.
    pub authority: Signer<'info>,

    /// This program's program data account, proving `authority`.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ VaultError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,

    #[account(mut, seeds = [VAULT_STATE_SEED], bump)]
    pub vault_state: Account<'info, VaultState>,
}

/// Sets the withdrawal caps (`0` disables a cap) and restarts the window.
pub fn process_set_limits(
    ctx: Context<SetLimits>,
    max_withdraw_per_tx: u64,
    max_withdraw_per_window: u64,
    window_seconds: u32,
) -> Result<()> {
    let now = current_timestamp()?;
    ctx.accounts.vault_state.set_limits(
        max_withdraw_per_tx,
        max_withdraw_per_window,
        window_seconds,
        now,
    )?;

    emit!(LimitsUpdatedEvent {
        authority: ctx.accounts.authority.key(),
        max_withdraw_per_tx,
        max_withdraw_per_window,
        window_seconds,
        timestamp: now,
    });
    Ok(())
}
