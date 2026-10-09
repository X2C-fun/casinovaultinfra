//! # Casino Vault
//!
//! A custody-only SOL vault built around a single shared pool. Two singleton
//! PDAs exist for the whole program:
//!
//! * `["vault_state"]` — [`state::VaultState`], holding the backend admin
//!   authority, the pool vault bump and the pause switch.
//! * `["pool_vault"]` — a data-less, system-owned account holding every lamport:
//!   player deposits and the house bankroll together.
//!
//! Pooling funds is what lets a winning player withdraw more than they
//! deposited. There is no per-user account and no balance on chain; the program
//! has no idea what a bet, a win or a balance is. It moves SOL in and out under
//! strict authority checks and emits an event for every change. The backend
//! listens to those events and owns all accounting.
//!
//! ## Authority model
//!
//! | Instruction   | User signs | Admin signs |
//! |---------------|------------|-------------|
//! | `initialize`  | n/a        | yes         |
//! | `deposit`     | yes        | no          |
//! | `withdraw`    | yes        | yes         |
//! | `set_paused`  | n/a        | yes         |
//!
//! Anyone may pay into the pool. Money only leaves it when *both* the recipient
//! and the admin sign, and it can only go to the signing recipient — the
//! destination is not a parameter, so a stolen admin key cannot redirect a
//! payout on its own.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod utils;

pub use constants::*;
pub use errors::VaultError;
pub use events::*;
pub use instructions::*;
pub use state::VaultState;

declare_id!("EXTH5XRAqc45efhoL5UjwhhLFV4smgaB4m6QVG74Vqa7");

#[program]
pub mod casino_vault {
    use super::*;

    /// Creates the singleton vault state and pool vault, registering the signing
    /// admin as the withdrawal authority. Runs exactly once per deployment.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::process_initialize(ctx)
    }

    /// Moves `amount` lamports from the signer's wallet into the pool vault.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::process_deposit(ctx, amount)
    }

    /// Releases `amount` lamports from the pool vault to the signing user.
    /// Requires the admin's signature.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::process_withdraw(ctx, amount)
    }

    /// Suspends or resumes deposits and withdrawals. Admin only.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::set_paused::process_set_paused(ctx, paused)
    }
}
