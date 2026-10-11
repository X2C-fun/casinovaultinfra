//! TEST FIXTURE ONLY — never deploy.
//!
//! Forwards `casino_vault::deposit` and `casino_vault::withdraw` through a
//! cross-program invocation. The integration suite uses it to prove that the
//! vault rejects both when they are not invoked directly by the transaction
//! (`CpiNotAllowed`), because Anchor's event parser cannot see events emitted
//! from a CPI'd call.

use anchor_lang::prelude::*;
use casino_vault::cpi::accounts::{Deposit, Withdraw};
use casino_vault::program::CasinoVault;

declare_id!("39Uobb8yLSbbXqx6izPWWCu6v9F9cRQduBAYSbPFEdMt");

#[program]
pub mod cpi_probe {
    use super::*;

    pub fn forward_deposit(ctx: Context<ForwardDeposit>, amount: u64) -> Result<()> {
        casino_vault::cpi::deposit(
            CpiContext::new(
                ctx.accounts.vault_program.to_account_info(),
                Deposit {
                    depositor: ctx.accounts.depositor.to_account_info(),
                    vault_state: ctx.accounts.vault_state.to_account_info(),
                    pool_vault: ctx.accounts.pool_vault.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
            ),
            amount,
        )
    }

    pub fn forward_withdraw(ctx: Context<ForwardWithdraw>, amount: u64) -> Result<()> {
        casino_vault::cpi::withdraw(
            CpiContext::new(
                ctx.accounts.vault_program.to_account_info(),
                Withdraw {
                    user: ctx.accounts.user.to_account_info(),
                    admin: ctx.accounts.admin.to_account_info(),
                    vault_state: ctx.accounts.vault_state.to_account_info(),
                    pool_vault: ctx.accounts.pool_vault.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
            ),
            amount,
        )
    }
}

#[derive(Accounts)]
pub struct ForwardDeposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    /// CHECK: validated by casino_vault.
    pub vault_state: UncheckedAccount<'info>,
    /// CHECK: validated by casino_vault.
    #[account(mut)]
    pub pool_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub vault_program: Program<'info, CasinoVault>,
}

#[derive(Accounts)]
pub struct ForwardWithdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    pub admin: Signer<'info>,
    /// CHECK: validated by casino_vault.
    pub vault_state: UncheckedAccount<'info>,
    /// CHECK: validated by casino_vault.
    #[account(mut)]
    pub pool_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub vault_program: Program<'info, CasinoVault>,
}
