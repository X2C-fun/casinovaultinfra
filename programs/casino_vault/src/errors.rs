//! Custom error codes returned by the program.
//!
//! Anchor offsets user-defined errors by `6000`, so `Unauthorized` is `6000`,
//! `InvalidAmount` is `6001`, and so on. The backend should match on these
//! numeric codes rather than on error strings. New variants are only ever
//! appended so existing codes never change.

use anchor_lang::prelude::*;

/// Errors produced by the casino vault program.
#[error_code]
pub enum VaultError {
    /// The supplied admin account is not the authority recorded in
    /// [`crate::state::VaultState`].
    #[msg("Unauthorized: signer is not the registered admin")]
    Unauthorized,

    /// The instruction was called with an amount of zero lamports.
    #[msg("Invalid amount: value must be greater than zero")]
    InvalidAmount,

    /// The pool vault (or the depositor) does not hold enough lamports for the
    /// requested transfer, once the vault rent reserve is taken into account.
    #[msg("Insufficient funds for the requested transfer")]
    InsufficientFunds,

    /// The program has already been initialized.
    ///
    /// Reserved for clients: the vault state is a singleton and is created
    /// exactly once. A second `initialize` is rejected by Anchor's `init`
    /// constraint before the handler runs, so clients should surface this code
    /// when they see the runtime's "account already in use" failure on the
    /// vault state PDA.
    #[msg("The vault has already been initialized")]
    VaultAlreadyInitialized,

    /// A checked arithmetic operation overflowed or underflowed.
    #[msg("Arithmetic overflow")]
    MathOverflow,

    /// Deposits and withdrawals are suspended by the admin.
    #[msg("The vault is paused")]
    VaultPaused,

    /// The signer is not the program's upgrade authority, or the supplied
    /// program data account does not belong to this program.
    #[msg("Unauthorized: signer is not the program upgrade authority")]
    NotUpgradeAuthority,

    /// `accept_admin` was signed by a key that is not the pending admin, or no
    /// admin transfer is pending.
    #[msg("Signer is not the pending admin")]
    NotPendingAdmin,

    /// The proposed admin is the default (all-zero) public key.
    #[msg("Invalid admin public key")]
    InvalidAdmin,

    /// Window limit and window length must be set together (both zero to
    /// disable, both non-zero to enable).
    #[msg("Invalid withdrawal limits")]
    InvalidLimits,

    /// The withdrawal exceeds the per-transaction cap.
    #[msg("Withdrawal exceeds the per-transaction limit")]
    WithdrawLimitExceeded,

    /// The withdrawal would exceed the cap for the current time window.
    #[msg("Withdrawal exceeds the limit for the current window")]
    WindowLimitExceeded,
}
