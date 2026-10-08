//! Program-wide constants.
//!
//! Both PDAs are singletons: there is exactly one vault state and exactly one
//! pool vault for the whole program. Seeds are defined once here so that every
//! instruction derives the very same addresses.

/// Seed of the singleton [`crate::state::VaultState`] PDA.
///
/// Full seeds: `["vault_state_v2"]`
///
/// The v0.1 layout lived at `["vault_state"]`. Using a new seed means a v0.1
/// deployment can be upgraded in place: the old state account is simply
/// ignored, the pool vault (and every lamport in it) keeps its address, and the
/// upgrade authority runs the guarded `initialize` once to create the v0.2
/// state.
pub const VAULT_STATE_SEED: &[u8] = b"vault_state_v2";

/// Seed of the singleton pool vault PDA that custodies every lamport.
///
/// Full seeds: `["pool_vault"]`
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";

/// Data length of the pool vault PDA.
///
/// The vault is a plain system-owned account: it carries lamports and no data.
/// Keeping it data-less is what allows the System Program to move lamports out
/// of it through a CPI signed with the vault seed.
pub const POOL_VAULT_DATA_LEN: usize = 0;
