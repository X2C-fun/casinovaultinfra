//! `deposit` — move SOL from any wallet into the shared pool vault.

use anchor_lang::prelude::*;

use crate::constants::{POOL_VAULT_SEED, VAULT_STATE_SEED};
use crate::errors::VaultError;
use crate::events::DepositEvent;
use crate::state::VaultState;
use crate::utils::{current_timestamp, transfer_into_vault};

/// Accounts for [`process_deposit`].
///
/// `#[event_cpi]` appends the `event_authority` PDA and this program as the
/// last two accounts, so `DepositEvent` can also be emitted with `emit_cpi!`.
#[event_cpi]
#[derive(Accounts)]
pub struct Deposit<'info> {
    /// Source of the lamports and the key the backend will credit.
    ///
    /// Anyone may deposit: players fund their balance this way and the house
    /// tops up the bankroll the same way. The signer is what identifies the
    /// depositor, so the backend can never be tricked into crediting somebody
    /// else.
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// Singleton state PDA. Read to enforce the pause switch.
    #[account(
        seeds = [VAULT_STATE_SEED],
        bump,
        constraint = !vault_state.paused @ VaultError::VaultPaused,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Singleton pool vault, verified against the bump recorded at
    /// initialization.
    #[account(
        mut,
        seeds = [POOL_VAULT_SEED],
        bump = vault_state.vault_bump,
    )]
    pub pool_vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Transfers `amount` lamports into the pool and emits [`DepositEvent`].
///
/// The program does not track who owns what: the backend listener reads the
/// event and credits its database.
pub fn process_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::InvalidAmount);

    // Reject a deposit that could not be represented, before moving anything.
    ctx.accounts
        .pool_vault
        .lamports()
        .checked_add(amount)
        .ok_or(VaultError::MathOverflow)?;

    transfer_into_vault(
        &ctx.accounts.system_program,
        &ctx.accounts.depositor,
        &ctx.accounts.pool_vault,
        amount,
    )?;

    let event = DepositEvent {
        user: ctx.accounts.depositor.key(),
        amount,
        vault_balance: ctx.accounts.pool_vault.lamports(),
        timestamp: current_timestamp()?,
    };
    emit!(event.clone());
    emit_cpi!(event);

    Ok(())
}
