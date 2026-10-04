//! `withdraw` — release SOL from the shared pool vault to a user.

use anchor_lang::prelude::*;

use crate::constants::{POOL_VAULT_SEED, VAULT_STATE_SEED};
use crate::errors::VaultError;
use crate::events::WithdrawEvent;
use crate::state::VaultState;
use crate::utils::{current_timestamp, transfer_out_of_vault, withdrawable_lamports};

/// Accounts for [`process_withdraw`].
#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// Recipient of the funds.
    ///
    /// The destination is this signer and nothing else: there is no address
    /// parameter, so a stolen admin key cannot redirect a payout. The user's
    /// signature also proves the payout was requested by the account holder.
    #[account(mut)]
    pub user: Signer<'info>,

    /// Backend authority. Its signature is the on-chain proof that the
    /// off-chain balance, limit and anti-cheat checks passed. A user's
    /// signature alone is never sufficient.
    pub admin: Signer<'info>,

    /// Singleton state PDA. Pins the admin and enforces the pause switch.
    #[account(
        seeds = [VAULT_STATE_SEED],
        bump,
        has_one = admin @ VaultError::Unauthorized,
        constraint = !vault_state.paused @ VaultError::VaultPaused,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Singleton pool vault. Signs the outgoing transfer through its seed and
    /// the bump stored in `vault_state`.
    #[account(
        mut,
        seeds = [POOL_VAULT_SEED],
        bump = vault_state.vault_bump,
    )]
    pub pool_vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Transfers `amount` lamports from the pool to `user` and emits
/// [`WithdrawEvent`].
///
/// Because funds are pooled, a user may legitimately withdraw more than they
/// ever deposited; covering winnings out of the house bankroll is the whole
/// point of the shared vault. The only on-chain limit is the pool's withdrawable
/// balance, which excludes the rent reserve. Entitlement is the backend's call.
pub fn process_withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidAmount);

    let available = withdrawable_lamports(&ctx.accounts.pool_vault.to_account_info())?;
    require!(amount <= available, VaultError::InsufficientFunds);

    transfer_out_of_vault(
        &ctx.accounts.system_program,
        &ctx.accounts.pool_vault,
        ctx.accounts.user.to_account_info(),
        ctx.accounts.vault_state.vault_bump,
        amount,
    )?;

    emit!(WithdrawEvent {
        user: ctx.accounts.user.key(),
        admin: ctx.accounts.admin.key(),
        amount,
        vault_balance: ctx.accounts.pool_vault.lamports(),
        timestamp: current_timestamp()?,
    });

    Ok(())
}
