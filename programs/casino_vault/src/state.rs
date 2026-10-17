//! On-chain state.
//!
//! The program deliberately stores as little as possible: it is a custody
//! layer, not an accounting layer. Player balances, bets, wins, losses, house
//! accounting and game history live in the backend database, which is fed by
//! the events this program emits.

use anchor_lang::prelude::*;

use crate::errors::VaultError;

/// Global program configuration, stored at the singleton PDA
/// `["vault_state_v2"]`.
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

    /// Admin proposed by the upgrade authority, waiting to sign
    /// `accept_admin`. `None` when no transfer is in progress.
    pub pending_admin: Option<Pubkey>,

    /// Largest single withdrawal in lamports. `0` disables the cap.
    pub max_withdraw_per_tx: u64,

    /// Largest total withdrawn within one window, in lamports. `0` disables
    /// the cap.
    pub max_withdraw_per_window: u64,

    /// Window length in seconds. `0` exactly when `max_withdraw_per_window`
    /// is `0`.
    pub window_seconds: u32,

    /// Unix timestamp at which the current window started.
    pub window_start: i64,

    /// Lamports withdrawn since `window_start`.
    pub window_withdrawn: u64,

    /// Zeroed space for future fields, so they can be added without a
    /// reallocation.
    pub reserved: [u8; 64],
}

impl VaultState {
    /// Total account size: 8-byte Anchor discriminator + serialised fields.
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    /// Checks `amount` against the configured caps at time `now` and, if it
    /// fits, records it in the current window.
    ///
    /// Windows are tumbling: the first withdrawal at or after
    /// `window_start + window_seconds` starts a new window at `now`. A clock
    /// reading earlier than `window_start` is treated as inside the current
    /// window: granting a fresh allowance on a clock regression would let
    /// withdrawals exceed the cap.
    pub fn record_withdrawal(&mut self, amount: u64, now: i64) -> Result<()> {
        if self.max_withdraw_per_tx > 0 {
            require!(
                amount <= self.max_withdraw_per_tx,
                VaultError::WithdrawLimitExceeded
            );
        }

        if self.max_withdraw_per_window > 0 {
            let window_end = self
                .window_start
                .checked_add(i64::from(self.window_seconds))
                .ok_or(VaultError::MathOverflow)?;
            if now >= window_end {
                self.window_start = now;
                self.window_withdrawn = 0;
            }

            let total = self
                .window_withdrawn
                .checked_add(amount)
                .ok_or(VaultError::MathOverflow)?;
            require!(
                total <= self.max_withdraw_per_window,
                VaultError::WindowLimitExceeded
            );
            self.window_withdrawn = total;
        }

        Ok(())
    }

    /// Validates and applies new caps.
    ///
    /// When a window cap was already active, the current window and what has
    /// been withdrawn in it are kept, so tightening the cap during an incident
    /// takes effect against withdrawals already made instead of granting a
    /// fresh allowance. A window starts at `now` only when a window cap is
    /// switched on from none, and the counters are cleared when it is switched
    /// off.
    pub fn set_limits(
        &mut self,
        max_withdraw_per_tx: u64,
        max_withdraw_per_window: u64,
        window_seconds: u32,
        now: i64,
    ) -> Result<()> {
        require!(
            (max_withdraw_per_window == 0) == (window_seconds == 0),
            VaultError::InvalidLimits
        );

        let window_was_active = self.max_withdraw_per_window > 0;

        self.max_withdraw_per_tx = max_withdraw_per_tx;
        self.max_withdraw_per_window = max_withdraw_per_window;
        self.window_seconds = window_seconds;
        if max_withdraw_per_window == 0 || !window_was_active {
            self.window_start = now;
            self.window_withdrawn = 0;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> VaultState {
        VaultState {
            admin: Pubkey::new_unique(),
            vault_bump: 255,
            paused: false,
            pending_admin: None,
            max_withdraw_per_tx: 0,
            max_withdraw_per_window: 0,
            window_seconds: 0,
            window_start: 0,
            window_withdrawn: 0,
            reserved: [0; 64],
        }
    }

    fn code(err: Error) -> u32 {
        match err {
            Error::AnchorError(e) => e.error_code_number,
            Error::ProgramError(e) => panic!("unexpected program error {e:?}"),
        }
    }

    /// Locks the account layout down: changing a field without accounting for
    /// the size would silently break an already-created vault state.
    #[test]
    fn vault_state_size_matches_layout() {
        const ADMIN: usize = 32;
        const VAULT_BUMP: usize = 1;
        const PAUSED: usize = 1;
        const PENDING_ADMIN: usize = 1 + 32;
        const MAX_PER_TX: usize = 8;
        const MAX_PER_WINDOW: usize = 8;
        const WINDOW_SECONDS: usize = 4;
        const WINDOW_START: usize = 8;
        const WINDOW_WITHDRAWN: usize = 8;
        const RESERVED: usize = 64;
        const FIELDS: usize = ADMIN
            + VAULT_BUMP
            + PAUSED
            + PENDING_ADMIN
            + MAX_PER_TX
            + MAX_PER_WINDOW
            + WINDOW_SECONDS
            + WINDOW_START
            + WINDOW_WITHDRAWN
            + RESERVED;

        assert_eq!(VaultState::INIT_SPACE, FIELDS);
        assert_eq!(VaultState::SIZE, 8 + FIELDS);
    }

    #[test]
    fn no_limits_accepts_any_amount() {
        let mut s = state();
        s.record_withdrawal(u64::MAX, 100).unwrap();
        assert_eq!(s.window_withdrawn, 0);
    }

    #[test]
    fn per_tx_cap_is_inclusive() {
        let mut s = state();
        s.set_limits(1_000, 0, 0, 0).unwrap();
        s.record_withdrawal(1_000, 1).unwrap();
        let err = s.record_withdrawal(1_001, 2).unwrap_err();
        assert_eq!(code(err), code(VaultError::WithdrawLimitExceeded.into()));
    }

    #[test]
    fn window_cap_accumulates_and_resets() {
        let mut s = state();
        s.set_limits(0, 1_000, 60, 100).unwrap();

        s.record_withdrawal(600, 110).unwrap();
        s.record_withdrawal(400, 159).unwrap();
        assert_eq!(s.window_withdrawn, 1_000);

        let err = s.record_withdrawal(1, 159).unwrap_err();
        assert_eq!(code(err), code(VaultError::WindowLimitExceeded.into()));
        assert_eq!(
            s.window_withdrawn, 1_000,
            "a rejected withdrawal must not count"
        );

        s.record_withdrawal(1_000, 160).unwrap();
        assert_eq!(s.window_start, 160);
        assert_eq!(s.window_withdrawn, 1_000);
    }

    #[test]
    fn clock_before_window_start_stays_in_the_current_window() {
        let mut s = state();
        s.set_limits(0, 1_000, 60, 500).unwrap();
        s.window_withdrawn = 1_000;
        let err = s.record_withdrawal(10, 400).unwrap_err();
        assert_eq!(code(err), code(VaultError::WindowLimitExceeded.into()));
        assert_eq!(
            s.window_start, 500,
            "a clock regression must not reopen the window"
        );
        assert_eq!(s.window_withdrawn, 1_000);
    }

    #[test]
    fn both_caps_apply() {
        let mut s = state();
        s.set_limits(500, 800, 60, 0).unwrap();
        let err = s.record_withdrawal(600, 1).unwrap_err();
        assert_eq!(code(err), code(VaultError::WithdrawLimitExceeded.into()));
        s.record_withdrawal(500, 1).unwrap();
        let err = s.record_withdrawal(400, 2).unwrap_err();
        assert_eq!(code(err), code(VaultError::WindowLimitExceeded.into()));
    }

    #[test]
    fn window_limit_and_length_must_match() {
        let mut s = state();
        for (max, secs) in [(1_000, 0), (0, 60)] {
            let err = s.set_limits(0, max, secs, 0).unwrap_err();
            assert_eq!(code(err), code(VaultError::InvalidLimits.into()));
        }
        s.set_limits(0, 0, 0, 0).unwrap();
        s.set_limits(0, 1, 1, 0).unwrap();
    }

    #[test]
    fn tightening_mid_window_keeps_what_was_withdrawn() {
        let mut s = state();
        s.set_limits(0, 1_000, 60, 0).unwrap();
        s.record_withdrawal(900, 10).unwrap();

        // Incident response: tighten the window cap. The 900 already taken
        // still counts, so only 50 more fits under the new 950 cap.
        s.set_limits(0, 950, 60, 20).unwrap();
        assert_eq!(s.window_start, 0);
        assert_eq!(s.window_withdrawn, 900);
        let err = s.record_withdrawal(100, 21).unwrap_err();
        assert_eq!(code(err), code(VaultError::WindowLimitExceeded.into()));
        s.record_withdrawal(50, 22).unwrap();

        // Re-applying the same limits does not hand out a new allowance either.
        s.set_limits(0, 950, 60, 23).unwrap();
        let err = s.record_withdrawal(1, 24).unwrap_err();
        assert_eq!(code(err), code(VaultError::WindowLimitExceeded.into()));
    }

    #[test]
    fn enabling_a_window_cap_starts_a_fresh_window() {
        let mut s = state();
        s.set_limits(0, 0, 0, 0).unwrap();
        s.set_limits(0, 1_000, 60, 20).unwrap();
        assert_eq!(s.window_start, 20);
        assert_eq!(s.window_withdrawn, 0);
    }

    #[test]
    fn disabling_the_window_cap_clears_the_counters() {
        let mut s = state();
        s.set_limits(0, 1_000, 60, 0).unwrap();
        s.record_withdrawal(400, 10).unwrap();
        s.set_limits(0, 0, 0, 30).unwrap();
        assert_eq!(s.window_withdrawn, 0);
        assert_eq!(s.window_start, 30);
    }
}
