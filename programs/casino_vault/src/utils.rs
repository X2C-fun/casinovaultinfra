//! Small shared helpers.
//!
//! Every lamport movement in this program goes through one of the two transfer
//! helpers below, so the CPI wiring (and the pool vault signer seeds in
//! particular) exists in exactly one place.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::get_stack_height;
use anchor_lang::system_program::{transfer, Transfer};

use crate::constants::{POOL_VAULT_DATA_LEN, POOL_VAULT_SEED};
use crate::errors::VaultError;

/// Lamports that must stay in the pool vault at all times.
///
/// The vault is a data-less system account. A writable account is not allowed
/// to end a transaction holding a non-zero balance below its rent-exempt
/// minimum, so this amount is reserved on `initialize` and is never withdrawable
/// afterwards.
pub fn pool_vault_rent_reserve() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(POOL_VAULT_DATA_LEN))
}

/// Lamports the admin is allowed to release from the pool, i.e. everything
/// above the rent reserve.
pub fn withdrawable_lamports(pool_vault: &AccountInfo) -> Result<u64> {
    Ok(pool_vault
        .lamports()
        .saturating_sub(pool_vault_rent_reserve()?))
}

/// Stack height of an instruction invoked directly by the transaction.
const TRANSACTION_LEVEL_STACK_HEIGHT: usize = 1;

/// Rejects the current instruction unless the transaction invoked it directly.
///
/// The backend credits and debits from `DepositEvent` / `WithdrawEvent`.
/// Anchor's `EventParser` (and so `addEventListener`) drops events emitted
/// while another program is on the call stack, so a deposit routed through a
/// multisig or router would move SOL that no listener ever credits. Refusing
/// CPI makes such a call fail loudly instead.
pub fn require_top_level() -> Result<()> {
    require!(
        get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
        VaultError::CpiNotAllowed
    );
    Ok(())
}

/// Unix timestamp of the current slot, stamped onto every event.
pub fn current_timestamp() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Moves `amount` lamports from a signing wallet into the pool vault.
///
/// The vault is only a lamport destination here, so no PDA signature is
/// required and the plain System Program transfer is enough.
pub fn transfer_into_vault<'info>(
    system_program: &Program<'info, System>,
    from: &Signer<'info>,
    pool_vault: &SystemAccount<'info>,
    amount: u64,
) -> Result<()> {
    require!(from.lamports() >= amount, VaultError::InsufficientFunds);

    transfer(
        CpiContext::new(
            system_program.to_account_info(),
            Transfer {
                from: from.to_account_info(),
                to: pool_vault.to_account_info(),
            },
        ),
        amount,
    )
}

/// Moves `amount` lamports out of the pool vault to `destination`.
///
/// The pool vault is the funding account, so the CPI must be signed with its
/// seed. `vault_bump` always comes from [`crate::state::VaultState`], never from
/// instruction data, which rules out bump substitution.
pub fn transfer_out_of_vault<'info>(
    system_program: &Program<'info, System>,
    pool_vault: &SystemAccount<'info>,
    destination: AccountInfo<'info>,
    vault_bump: u8,
    amount: u64,
) -> Result<()> {
    let bump = [vault_bump];
    let vault_seeds: [&[u8]; 2] = [POOL_VAULT_SEED, &bump];
    let signer_seeds: &[&[&[u8]]] = &[&vault_seeds];

    transfer(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            Transfer {
                from: pool_vault.to_account_info(),
                to: destination,
            },
            signer_seeds,
        ),
        amount,
    )
}
