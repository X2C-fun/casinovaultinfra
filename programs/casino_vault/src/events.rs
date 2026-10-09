//! Events emitted by every state-changing instruction.
//!
//! These logs are the contract between the program and the backend listener.
//! Each event carries the resulting pool balance and a timestamp so the backend
//! can reconcile against the pool without replaying transactions.
//!
//! Event contents are NOT unique: two identical deposits in one slot produce
//! identical events. De-duplicate on where the event came from, i.e.
//! `(transaction signature, instruction index, event index)`, never on its
//! fields.

use anchor_lang::prelude::*;

/// Emitted once, when the vault state and pool vault are created.
#[event]
pub struct VaultInitializedEvent {
    /// Backend authority registered as admin.
    pub admin: Pubkey,
    /// Canonical bump of the pool vault PDA.
    pub vault_bump: u8,
    /// Lamports parked in the pool vault to keep it rent exempt. These are not
    /// player funds and must not be credited to anybody.
    pub rent_reserve: u64,
    /// Unix timestamp of the enclosing slot.
    pub timestamp: i64,
}

/// Emitted when SOL enters the pool, whether from a player or from the house.
#[event]
pub struct DepositEvent {
    /// Wallet that signed and funded the deposit. The backend credits this key.
    pub user: Pubkey,
    /// Lamports moved into the pool vault.
    pub amount: u64,
    /// Pool vault lamports after the deposit, rent reserve included.
    pub vault_balance: u64,
    /// Unix timestamp of the enclosing slot.
    pub timestamp: i64,
}

/// Emitted when the backend releases funds from the pool.
#[event]
pub struct WithdrawEvent {
    /// Wallet that received the lamports. The backend debits this key.
    pub user: Pubkey,
    /// Admin authority that approved the withdrawal.
    pub admin: Pubkey,
    /// Lamports moved out of the pool vault.
    pub amount: u64,
    /// Pool vault lamports after the withdrawal, rent reserve included.
    pub vault_balance: u64,
    /// Unix timestamp of the enclosing slot.
    pub timestamp: i64,
}

/// Emitted whenever the admin flips the pause switch.
#[event]
pub struct PauseStateChangedEvent {
    /// Admin authority that made the change.
    pub admin: Pubkey,
    /// New value of the switch: `true` means deposits and withdrawals are
    /// rejected.
    pub paused: bool,
    /// Unix timestamp of the enclosing slot.
    pub timestamp: i64,
}
