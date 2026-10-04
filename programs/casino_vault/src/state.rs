//! On-chain state.
//!
//! The program deliberately stores as little as possible: it is a custody
//! layer, not an accounting layer. Player balances, bets, wins, losses, house
//! accounting and game history live in the backend database, which is fed by
//! the events this program emits.

use anchor_lang::prelude::*;

/// Global program configuration, stored at the singleton PDA `["vault_state"]`.
///
/// There is no per-user state and no balance field. Every lamport sits in one
/// shared pool vault, and who owns how much of it is the backend's business.
#[account]
#[derive(InitSpace, Debug)]
pub struct VaultState {
    /// Backend authority that must co-sign every withdrawal and is the only
    /// key allowed to pause the program.
    pub admin: Pubkey,

    /// Canonical bump of the pool vault PDA (`["pool_vault"]`). Persisted so
    /// that CPI signing never has to re-derive it, and never accepts a
    /// caller-supplied bump.
    pub vault_bump: u8,

    /// Emergency switch. While set, deposits and withdrawals are both
    /// rejected.
    pub paused: bool,
}

impl VaultState {
    /// Total account size: 8-byte Anchor discriminator + serialised fields.
    pub const SIZE: usize = 8 + Self::INIT_SPACE;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Locks the account layout down: changing a field without accounting for
    /// the size would silently break the already-created vault state.
    #[test]
    fn vault_state_size_matches_layout() {
        const ADMIN: usize = 32;
        const VAULT_BUMP: usize = 1;
        const PAUSED: usize = 1;

        assert_eq!(VaultState::INIT_SPACE, ADMIN + VAULT_BUMP + PAUSED);
        assert_eq!(VaultState::SIZE, 8 + ADMIN + VAULT_BUMP + PAUSED);
    }
}
