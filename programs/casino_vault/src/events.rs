//! Events emitted by every state-changing instruction.
//!
//! These logs are the contract between the program and the backend listener.
//! Each event carries a timestamp, and the balance-moving ones carry the
//! resulting pool balance, so the backend can reconcile database updates
//! without having to replay transactions.
//!
//! `DepositEvent` and `WithdrawEvent` are emitted twice per instruction: once
//! with `emit!` (program logs, for websocket subscribers) and once with
//! `emit_cpi!` (a self-CPI carrying the event in instruction data, which log
//! truncation cannot drop). A listener should consume one of the two sources
//! and de-duplicate by transaction signature.

use anchor_lang::prelude::*;

/// Emitted once, when the vault state is created.
#[event]
pub struct VaultInitializedEvent {
    /// Upgrade authority that ran `initialize`.
    pub authority: Pubkey,
    /// Backend authority registered as admin.
    pub admin: Pubkey,
    /// Canonical bump of the pool vault PDA.
    pub vault_bump: u8,
    /// Lamports parked in the pool vault to keep it rent exempt. These are not
    /// player funds and must not be credited to anybody.
    pub rent_reserve: u64,
    /// Pool vault lamports after initialization. Non-zero beyond the reserve
    /// when the pool already held funds (e.g. after upgrading from v0.1).
    pub vault_balance: u64,
    /// Unix timestamp of the enclosing slot.
    pub timestamp: i64,
}

/// Emitted when SOL enters the pool, whether from a player or from the house.
#[event]
#[derive(Clone)]
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
#[derive(Clone)]
pub struct WithdrawEvent {
    /// Wallet that received the lamports. The backend debits this key.
    pub user: Pubkey,
    /// Admin authority that approved the withdrawal.
    pub admin: Pubkey,
    /// Backend withdrawal ID passed to `withdraw`, so the listener can settle
    /// the matching hold without guessing by amount.
    pub request_id: u64,
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

/// Emitted when the upgrade authority proposes (or cancels) an admin change.
#[event]
pub struct AdminProposedEvent {
    /// Upgrade authority that made the proposal.
    pub authority: Pubkey,
    /// Admin in force when the proposal was made.
    pub current_admin: Pubkey,
    /// Proposed admin; `None` cancels a pending proposal.
    pub pending_admin: Option<Pubkey>,
    /// Unix timestamp of the enclosing slot.
    pub timestamp: i64,
}

/// Emitted when the pending admin accepts and becomes the admin.
#[event]
pub struct AdminChangedEvent {
    /// Admin that was replaced.
    pub previous_admin: Pubkey,
    /// Admin now in force.
    pub new_admin: Pubkey,
    /// Unix timestamp of the enclosing slot.
    pub timestamp: i64,
}

/// Emitted when the upgrade authority changes the withdrawal caps.
#[event]
pub struct LimitsUpdatedEvent {
    /// Upgrade authority that made the change.
    pub authority: Pubkey,
    /// New per-transaction cap in lamports (`0` = none).
    pub max_withdraw_per_tx: u64,
    /// New per-window cap in lamports (`0` = none).
    pub max_withdraw_per_window: u64,
    /// New window length in seconds.
    pub window_seconds: u32,
    /// Unix timestamp of the enclosing slot; the new window starts here.
    pub timestamp: i64,
}
