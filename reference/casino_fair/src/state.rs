//! On-chain state and the flip state machine.
//!
//! One account per player, and only the minimum needed to run a single flip and
//! settle it exactly once. Like the vault, this program keeps accounting out of
//! the chain: it records the committed guess, the randomness it was settled
//! with and the outcome, so anyone can re-derive the result. It does not track
//! balances — `bet` is a documented placeholder, not escrow (see the trust model
//! in [`crate`]).
//!
//! Every state transition lives here as a plain method on [`Flip`] that takes
//! the current slot as an argument instead of reading the `Clock` sysvar. The
//! instruction handlers are thin wrappers around these methods, which is what
//! lets the host unit tests below exercise the real state machine.

use anchor_lang::prelude::*;

use ephemeral_rollups_sdk::vrf;

use crate::constants::CANCEL_TIMEOUT_SLOTS;
use crate::errors::FairError;

/// The two sides of the coin. Stored as a 1-byte enum.
///
/// The numeric mapping is part of the client contract: `0 == HEADS`,
/// `1 == TAILS`. `guess` and `last_result` both use it, so "did the player
/// win" is a plain equality.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum CoinSide {
    /// Coin side `0`.
    Heads,
    /// Coin side `1`.
    Tails,
}

impl CoinSide {
    /// Maps a raw byte to a coin side: `0 -> Heads`, anything else `-> Tails`.
    ///
    /// The VRF callback feeds this the output of
    /// [`vrf::rnd::random_u8_with_range`]`(&randomness, 0, 1)`, which is already
    /// constrained to `{0, 1}`. Folding every other value to `Tails` keeps the
    /// mapping total so an unexpected input can never panic a callback.
    pub fn from_u8(value: u8) -> Self {
        match value {
            0 => CoinSide::Heads,
            _ => CoinSide::Tails,
        }
    }

    /// Validates a client-supplied guess byte, rejecting anything that is not a
    /// coin side rather than silently coercing it.
    pub fn try_from_guess(value: u8) -> Result<Self> {
        match value {
            0 => Ok(CoinSide::Heads),
            1 => Ok(CoinSide::Tails),
            _ => Err(FairError::InvalidGuess.into()),
        }
    }
}

/// Where a flip is in its lifecycle. Stored as a 1-byte enum; new variants are
/// only ever appended.
///
/// ```text
/// Idle ──request──► Requested ──callback──► Settled ──request──► Requested …
///                       │
///                       └──cancel (after CANCEL_TIMEOUT_SLOTS)──► Cancelled ──request──► …
/// ```
///
/// Only `Requested` accepts a settlement, which is what makes a duplicate or
/// stale callback a no-op. Every state except `Requested` may be closed.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum FlipStatus {
    /// Created, no request ever made.
    Idle,
    /// A randomness request is in flight, awaiting the oracle callback.
    Requested,
    /// The most recent request has been settled; `last_result` / `won` are
    /// valid for `round`.
    Settled,
    /// The most recent request was cancelled by the player after the timeout.
    /// `last_result` / `won` still describe the last *settled* round, if any.
    Cancelled,
}

/// Per-player flip account, PDA `["flip", player]`.
#[account]
#[derive(InitSpace, Debug)]
pub struct Flip {
    /// Owner of this flip. The request signer must match it, and the callback
    /// re-derives the PDA from it.
    pub player: Pubkey,

    /// Lifecycle state. Settlement is only accepted while `Requested`.
    pub status: FlipStatus,

    /// Monotonic request nonce, bumped on every `request_flip` and again on
    /// `cancel_flip`. The callback carries the round it was issued for; a
    /// mismatch means the callback is stale and is ignored.
    pub round: u64,

    /// Client-chosen byte committed for the live request and echoed back by
    /// the callback. It is a request tag that the callback must match, and it
    /// is folded into the VRF `caller_seed`; at one byte it adds no meaningful
    /// entropy (see `docs/fairness.md`).
    pub client_seed: u8,

    /// The side the player bet on for the live request.
    pub guess: CoinSide,

    /// Reference-only stake. **Not escrowed by this program.** A real game sets
    /// this when it binds the flip to a `casino_vault` settlement; here it marks
    /// where that binding goes and is left `0`.
    pub bet: u64,

    /// Coin side the last settled round landed on. Meaningful once `status` has
    /// reached `Settled` at least once.
    pub last_result: CoinSide,

    /// The exact VRF output the last round was settled with, kept so the result
    /// can be independently re-derived and audited.
    pub last_randomness: [u8; 32],

    /// Whether the player won the last settled round (`last_result == guess`).
    pub won: bool,

    /// Canonical PDA bump, stored so no instruction re-derives it or accepts a
    /// caller-supplied bump.
    pub bump: u8,

    /// Slot the live (or most recent) request was made in. Starts the cancel
    /// timeout, and is forwarded to the callback as a second request binding so
    /// a late callback for a cancelled request can never settle a later one —
    /// not even after `close_flip` + `init_flip` restarts `round` at zero.
    pub requested_slot: u64,

    /// Zeroed space for future fields, so they can be added without a
    /// reallocation. (Was 64 bytes; 8 went to `requested_slot`, so the account
    /// size is unchanged.)
    pub reserved: [u8; 56],
}

/// What a callback that was accepted did, so the handler can emit the event.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Settlement {
    /// Round that was settled.
    pub round: u64,
    /// Side the player had bet on.
    pub guess: CoinSide,
    /// Side the randomness landed on.
    pub result: CoinSide,
    /// `result == guess`.
    pub won: bool,
}

impl Flip {
    /// Total account size: 8-byte Anchor discriminator + serialised fields.
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    /// A freshly initialised, `Idle` flip for `player`.
    pub fn new(player: Pubkey, bump: u8) -> Self {
        Self {
            player,
            status: FlipStatus::Idle,
            round: 0,
            client_seed: 0,
            guess: CoinSide::Heads,
            bet: 0,
            last_result: CoinSide::Heads,
            last_randomness: [0; 32],
            won: false,
            bump,
            requested_slot: 0,
            reserved: [0; 56],
        }
    }

    /// Whether a callback carrying `(round, client_seed, requested_slot)` is
    /// the one this account is currently waiting for. This is the idempotency
    /// and request-binding guard: it is `true` for exactly one callback per
    /// request, so a duplicate (already `Settled`), a stale one (superseded or
    /// cancelled round) or one with mismatched arguments returns `false` and
    /// must be a no-op.
    pub fn is_awaiting(&self, round: u64, client_seed: u8, requested_slot: u64) -> bool {
        self.status == FlipStatus::Requested
            && self.round == round
            && self.client_seed == client_seed
            && self.requested_slot == requested_slot
    }

    /// Starts a new request at `slot`. Returns the new round.
    ///
    /// Rejected while a request is in flight (one live request per account,
    /// otherwise two callbacks could race over the same state). The guess and
    /// seed are committed here, before the VRF CPI, so the player cannot change
    /// their call once randomness is in flight.
    pub fn begin_request(&mut self, client_seed: u8, guess: CoinSide, slot: u64) -> Result<u64> {
        require!(
            self.status != FlipStatus::Requested,
            FairError::RequestInProgress
        );
        let round = self.round.checked_add(1).ok_or(FairError::MathOverflow)?;
        self.round = round;
        self.status = FlipStatus::Requested;
        self.client_seed = client_seed;
        self.guess = guess;
        self.requested_slot = slot;
        Ok(round)
    }

    /// Applies a VRF callback. Returns `None` (and leaves the account
    /// untouched) when the callback is not the one being awaited; otherwise
    /// settles the round and returns what happened.
    pub fn settle(
        &mut self,
        randomness: [u8; 32],
        client_seed: u8,
        round: u64,
        requested_slot: u64,
    ) -> Option<Settlement> {
        if !self.is_awaiting(round, client_seed, requested_slot) {
            return None;
        }
        let result = coin_side_from_randomness(&randomness);
        let won = result == self.guess;
        self.last_result = result;
        self.last_randomness = randomness;
        self.won = won;
        self.status = FlipStatus::Settled;
        Some(Settlement {
            round,
            guess: self.guess,
            result,
            won,
        })
    }

    /// Cancels the in-flight request at `slot`. Returns the cancelled round.
    ///
    /// Only allowed once `CANCEL_TIMEOUT_SLOTS` have passed since the request.
    /// Bumps `round` so the abandoned request's callback, if it ever arrives,
    /// fails [`Flip::is_awaiting`] even after the player requests again.
    pub fn cancel(&mut self, slot: u64) -> Result<u64> {
        require!(
            self.status == FlipStatus::Requested,
            FairError::NoRequestInFlight
        );
        let earliest = self
            .requested_slot
            .checked_add(CANCEL_TIMEOUT_SLOTS)
            .ok_or(FairError::MathOverflow)?;
        require!(slot >= earliest, FairError::CancelTooEarly);
        let cancelled = self.round;
        self.round = cancelled.checked_add(1).ok_or(FairError::MathOverflow)?;
        self.status = FlipStatus::Cancelled;
        Ok(cancelled)
    }

    /// Whether the account may be closed: anything but `Requested`.
    pub fn ensure_closable(&self) -> Result<()> {
        require!(
            self.status != FlipStatus::Requested,
            FairError::CloseWhileRequested
        );
        Ok(())
    }
}

/// Maps a 32-byte VRF output to a coin side.
///
/// Thin wrapper over the SDK's uniform reducer so the randomness→side mapping
/// lives in one place. For a `0..=1` range the SDK reduces the **last** byte
/// modulo 2 (every byte is below its rejection threshold of 256), so the side is
/// the parity of `randomness[31]` — exactly 50/50 over a uniform output.
pub fn coin_side_from_randomness(randomness: &[u8; 32]) -> CoinSide {
    CoinSide::from_u8(vrf::rnd::random_u8_with_range(randomness, 0, 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SLOT: u64 = 1_000;

    /// Numeric code of an Anchor error, so tests can assert *which* error.
    fn code(err: anchor_lang::error::Error) -> u32 {
        match err {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            other => panic!("expected an AnchorError, got {other:?}"),
        }
    }

    fn fair(e: FairError) -> u32 {
        code(e.into())
    }

    fn requested(seed: u8, guess: CoinSide) -> Flip {
        let mut flip = Flip::new(Pubkey::new_unique(), 254);
        flip.begin_request(seed, guess, SLOT).unwrap();
        flip
    }

    /// Randomness whose mapped side is `side` (last byte even = Heads).
    fn randomness_for(side: CoinSide) -> [u8; 32] {
        let mut r = [0xA5u8; 32];
        r[31] = match side {
            CoinSide::Heads => 0x10,
            CoinSide::Tails => 0x11,
        };
        r
    }

    /// Locks the account layout down: changing a field without accounting for
    /// the size would silently break an already-created flip account.
    #[test]
    fn flip_size_matches_layout_and_is_unchanged() {
        // player + status + round + client_seed + guess + bet + last_result
        // + last_randomness + won + bump + requested_slot + reserved
        const FIELDS: usize = 32 + 1 + 8 + 1 + 1 + 8 + 1 + 32 + 1 + 1 + 8 + 56;
        assert_eq!(Flip::INIT_SPACE, FIELDS);
        // Same total as the original 64-byte-reserved layout.
        assert_eq!(Flip::SIZE, 8 + 32 + 1 + 8 + 1 + 1 + 8 + 1 + 32 + 1 + 1 + 64);
    }

    #[test]
    fn serialized_flip_fills_exactly_init_space() {
        let flip = Flip::new(Pubkey::new_unique(), 7);
        let bytes = flip.try_to_vec().unwrap();
        assert_eq!(bytes.len(), Flip::INIT_SPACE);
    }

    #[test]
    fn guess_validation_rejects_non_sides() {
        assert_eq!(CoinSide::try_from_guess(0).unwrap(), CoinSide::Heads);
        assert_eq!(CoinSide::try_from_guess(1).unwrap(), CoinSide::Tails);
        for bad in 2..=u8::MAX {
            let err = CoinSide::try_from_guess(bad).unwrap_err();
            assert_eq!(code(err), fair(FairError::InvalidGuess));
        }
    }

    #[test]
    fn out_of_range_bytes_fold_to_tails() {
        assert_eq!(CoinSide::from_u8(0), CoinSide::Heads);
        for b in 1..=u8::MAX {
            assert_eq!(CoinSide::from_u8(b), CoinSide::Tails);
        }
    }

    /// The outcome is the parity of the last byte, so over all 256 values of
    /// that byte exactly half land on each side — and no other byte matters.
    #[test]
    fn outcome_is_exactly_fifty_fifty_over_the_last_byte() {
        let mut heads = 0;
        for last in 0..=u8::MAX {
            for filler in [0x00u8, 0x5A, 0xFF] {
                let mut r = [filler; 32];
                r[31] = last;
                let side = coin_side_from_randomness(&r);
                let expected = if last % 2 == 0 {
                    CoinSide::Heads
                } else {
                    CoinSide::Tails
                };
                assert_eq!(side, expected, "last byte {last}, filler {filler:#x}");
                if filler == 0 && side == CoinSide::Heads {
                    heads += 1;
                }
            }
        }
        assert_eq!(heads, 128);
    }

    #[test]
    fn request_commits_guess_and_seed_and_bumps_round() {
        let mut flip = Flip::new(Pubkey::new_unique(), 254);
        let round = flip.begin_request(42, CoinSide::Tails, SLOT).unwrap();
        assert_eq!(round, 1);
        assert_eq!(flip.round, 1);
        assert_eq!(flip.status, FlipStatus::Requested);
        assert_eq!(flip.client_seed, 42);
        assert_eq!(flip.guess, CoinSide::Tails);
        assert_eq!(flip.requested_slot, SLOT);
    }

    #[test]
    fn second_request_while_requested_is_rejected() {
        let mut flip = requested(1, CoinSide::Heads);
        let err = flip
            .begin_request(2, CoinSide::Tails, SLOT + 1)
            .unwrap_err();
        assert_eq!(code(err), fair(FairError::RequestInProgress));
        // The original request is untouched.
        assert_eq!(
            (flip.round, flip.client_seed, flip.guess),
            (1, 1, CoinSide::Heads)
        );
    }

    #[test]
    fn round_overflow_is_an_error_not_a_wrap() {
        let mut flip = Flip::new(Pubkey::new_unique(), 254);
        flip.round = u64::MAX;
        let err = flip.begin_request(0, CoinSide::Heads, SLOT).unwrap_err();
        assert_eq!(code(err), fair(FairError::MathOverflow));
        assert_eq!(flip.status, FlipStatus::Idle);
    }

    #[test]
    fn callback_settles_the_live_round_exactly_once() {
        for (guess, landed) in [
            (CoinSide::Heads, CoinSide::Heads),
            (CoinSide::Heads, CoinSide::Tails),
            (CoinSide::Tails, CoinSide::Heads),
            (CoinSide::Tails, CoinSide::Tails),
        ] {
            let mut flip = requested(9, guess);
            let r = randomness_for(landed);
            let s = flip.settle(r, 9, 1, SLOT).expect("live round settles");
            assert_eq!(s.round, 1);
            assert_eq!(s.result, landed);
            assert_eq!(s.won, guess == landed);
            assert_eq!(flip.status, FlipStatus::Settled);
            assert_eq!(flip.last_result, landed);
            assert_eq!(flip.last_randomness, r);
            assert_eq!(flip.won, guess == landed);

            // A duplicate delivery of the same callback is a no-op.
            let before = flip.try_to_vec().unwrap();
            assert_eq!(
                flip.settle(randomness_for(CoinSide::Tails), 9, 1, SLOT),
                None
            );
            assert_eq!(flip.try_to_vec().unwrap(), before);
        }
    }

    #[test]
    fn callback_with_wrong_binding_is_ignored() {
        let mut flip = requested(9, CoinSide::Heads);
        let before = flip.try_to_vec().unwrap();
        let r = randomness_for(CoinSide::Heads);
        assert_eq!(flip.settle(r, 8, 1, SLOT), None, "wrong client_seed");
        assert_eq!(flip.settle(r, 9, 0, SLOT), None, "stale round");
        assert_eq!(flip.settle(r, 9, 2, SLOT), None, "future round");
        assert_eq!(flip.settle(r, 9, 1, SLOT - 1), None, "wrong request slot");
        assert_eq!(flip.try_to_vec().unwrap(), before, "nothing was written");
        assert!(flip.settle(r, 9, 1, SLOT).is_some());
    }

    #[test]
    fn callback_without_a_request_is_ignored() {
        let mut flip = Flip::new(Pubkey::new_unique(), 254);
        assert_eq!(flip.settle([0; 32], 0, 0, 0), None);
        assert_eq!(flip.status, FlipStatus::Idle);
    }

    #[test]
    fn stale_callback_from_a_previous_round_cannot_settle_the_next() {
        let mut flip = requested(5, CoinSide::Heads);
        flip.settle(randomness_for(CoinSide::Heads), 5, 1, SLOT)
            .unwrap();
        flip.begin_request(5, CoinSide::Heads, SLOT + 10).unwrap();
        // A late re-delivery of round 1 does not touch round 2.
        assert_eq!(flip.settle([0; 32], 5, 1, SLOT), None);
        assert_eq!(flip.status, FlipStatus::Requested);
        assert!(flip.settle([0; 32], 5, 2, SLOT + 10).is_some());
    }

    #[test]
    fn cancel_only_after_the_timeout() {
        let mut flip = requested(3, CoinSide::Tails);
        let err = flip.cancel(SLOT + CANCEL_TIMEOUT_SLOTS - 1).unwrap_err();
        assert_eq!(code(err), fair(FairError::CancelTooEarly));
        assert_eq!(flip.status, FlipStatus::Requested);
        assert_eq!(flip.round, 1);

        let cancelled = flip.cancel(SLOT + CANCEL_TIMEOUT_SLOTS).unwrap();
        assert_eq!(cancelled, 1);
        assert_eq!(flip.status, FlipStatus::Cancelled);
        assert_eq!(flip.round, 2, "cancel bumps the round");
    }

    #[test]
    fn cancel_without_a_request_is_rejected() {
        for status in [FlipStatus::Idle, FlipStatus::Settled, FlipStatus::Cancelled] {
            let mut flip = Flip::new(Pubkey::new_unique(), 254);
            flip.status = status;
            let err = flip.cancel(u64::MAX).unwrap_err();
            assert_eq!(code(err), fair(FairError::NoRequestInFlight));
        }
    }

    #[test]
    fn late_callback_after_cancel_is_ignored_even_after_rerequest() {
        let mut flip = requested(3, CoinSide::Tails);
        flip.cancel(SLOT + CANCEL_TIMEOUT_SLOTS).unwrap();
        // While cancelled.
        assert_eq!(flip.settle([1; 32], 3, 1, SLOT), None);
        // After a new request with the same seed.
        let later = SLOT + CANCEL_TIMEOUT_SLOTS + 1;
        let round = flip.begin_request(3, CoinSide::Tails, later).unwrap();
        assert_eq!(round, 3);
        assert_eq!(flip.settle([1; 32], 3, 1, SLOT), None);
        assert!(flip.settle([1; 32], 3, round, later).is_some());
    }

    /// `close_flip` + `init_flip` restarts `round` at 0, so after re-init the
    /// round number of a cancelled request can repeat. The request slot still
    /// differs (cancel needs `CANCEL_TIMEOUT_SLOTS`), so the late callback is
    /// still rejected.
    #[test]
    fn late_callback_after_close_and_reinit_is_ignored() {
        let player = Pubkey::new_unique();
        let mut old = Flip::new(player, 254);
        old.begin_request(3, CoinSide::Heads, SLOT).unwrap();
        old.cancel(SLOT + CANCEL_TIMEOUT_SLOTS).unwrap();
        old.ensure_closable().unwrap();

        let mut fresh = Flip::new(player, 254);
        let later = SLOT + CANCEL_TIMEOUT_SLOTS;
        assert_eq!(fresh.begin_request(3, CoinSide::Heads, later).unwrap(), 1);
        assert_eq!(fresh.settle([0; 32], 3, 1, SLOT), None);
        assert!(fresh.settle([0; 32], 3, 1, later).is_some());
    }

    #[test]
    fn close_refused_only_while_requested() {
        let mut flip = Flip::new(Pubkey::new_unique(), 254);
        flip.ensure_closable().unwrap(); // Idle
        flip.begin_request(0, CoinSide::Heads, SLOT).unwrap();
        let err = flip.ensure_closable().unwrap_err();
        assert_eq!(code(err), fair(FairError::CloseWhileRequested));
        flip.settle([0; 32], 0, 1, SLOT).unwrap();
        flip.ensure_closable().unwrap(); // Settled
        flip.begin_request(0, CoinSide::Heads, SLOT + 1).unwrap();
        flip.cancel(SLOT + 1 + CANCEL_TIMEOUT_SLOTS).unwrap();
        flip.ensure_closable().unwrap(); // Cancelled
    }
}
