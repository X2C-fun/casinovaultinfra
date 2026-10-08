//! # Casino Vault
//!
//! A custody-only SOL vault built around a single shared pool. Two singleton
//! PDAs exist for the whole program:
//!
//! * `["vault_state_v2"]` — [`state::VaultState`], holding the backend admin
//!   authority, a pending admin, the pool vault bump, the pause switch and the
//!   optional withdrawal caps.
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
//! | Instruction     | Signers                                   |
//! |-----------------|-------------------------------------------|
//! | `initialize`    | upgrade authority + admin                 |
//! | `deposit`       | depositor                                 |
//! | `withdraw`      | user + admin                              |
//! | `set_paused`    | admin                                     |
//! | `propose_admin` | upgrade authority                         |
//! | `accept_admin`  | pending admin                             |
//! | `set_limits`    | upgrade authority                         |
//!
//! Anyone may pay into the pool. Money only leaves it when *both* the recipient
//! and the admin sign, and it can only go to the signing recipient — the
//! destination is not a parameter, so a stolen admin key cannot redirect a
//! payout on its own. The upgrade authority (which should be cold storage or a
//! multisig) controls who the admin is and how much can leave per transaction
//! and per time window.

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

declare_id!("DdpfHbMEYWqZM9yzPvyT45qLPfiLP6yKaPNTgqx7navY");

#[program]
pub mod casino_vault {
    use super::*;

    /// Creates the singleton vault state, registering the signing admin as the
    /// withdrawal authority. Only the upgrade authority may call it, and only
    /// once per deployment.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::process_initialize(ctx)
    }

    /// Moves `amount` lamports from the signer's wallet into the pool vault.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::process_deposit(ctx, amount)
    }

    /// Releases `amount` lamports from the pool vault to the signing user.
    /// Requires the admin's signature. `request_id` is echoed in
    /// `WithdrawEvent`.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64, request_id: u64) -> Result<()> {
        instructions::withdraw::process_withdraw(ctx, amount, request_id)
    }

    /// Suspends or resumes deposits and withdrawals. Admin only.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::set_paused::process_set_paused(ctx, paused)
    }

    /// Proposes a new admin (`None` cancels). Upgrade authority only.
    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Option<Pubkey>) -> Result<()> {
        instructions::admin::process_propose_admin(ctx, new_admin)
    }

    /// Completes an admin transfer. Signed by the pending admin.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::process_accept_admin(ctx)
    }

    /// Sets the withdrawal caps; `0` disables a cap. Upgrade authority only.
    pub fn set_limits(
        ctx: Context<SetLimits>,
        max_withdraw_per_tx: u64,
        max_withdraw_per_window: u64,
        window_seconds: u32,
    ) -> Result<()> {
        instructions::admin::process_set_limits(
            ctx,
            max_withdraw_per_tx,
            max_withdraw_per_window,
            window_seconds,
        )
    }
}
