//! Custom error codes returned by the program.
//!
//! Anchor offsets user-defined errors by `6000`, so `Unauthorized` is `6000`,
//! `InvalidAmount` is `6001`, and so on. The backend should match on these
//! numeric codes rather than on error strings.

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

    /// `deposit` or `withdraw` was invoked by another program (CPI) instead
    /// of directly by the transaction. Events from CPI'd calls are invisible
    /// to Anchor's event parser, so such a deposit could never be credited.
    #[msg("Deposits and withdrawals must be top-level instructions, not CPI")]
    CpiNotAllowed,
}
