//! `set_paused` — admin-only emergency switch for deposits and withdrawals.

use anchor_lang::prelude::*;

use crate::constants::VAULT_STATE_SEED;
use crate::errors::VaultError;
use crate::events::PauseStateChangedEvent;
use crate::state::VaultState;
use crate::utils::current_timestamp;

/// Accounts for [`process_set_paused`].
#[derive(Accounts)]
pub struct SetPaused<'info> {
    /// Backend authority. Only the registered admin may flip the switch.
    pub admin: Signer<'info>,

    /// Singleton state PDA holding the flag.
    #[account(
        mut,
        seeds = [VAULT_STATE_SEED],
        bump,
        has_one = admin @ VaultError::Unauthorized,
    )]
    pub vault_state: Account<'info, VaultState>,
}

/// Sets the pause flag and emits [`PauseStateChangedEvent`].
///
/// Pausing stops both directions on purpose. If the backend is compromised or
/// its accounting is in doubt, letting withdrawals continue would drain the pool
/// against stale balances. Setting the flag to its current value is allowed so
/// that incident response is idempotent.
pub fn process_set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.vault_state.paused = paused;

    emit!(PauseStateChangedEvent {
        admin: ctx.accounts.admin.key(),
        paused,
        timestamp: current_timestamp()?,
    });

    msg!("Vault paused = {}", paused);
    Ok(())
}
