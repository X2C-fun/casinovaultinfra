//! On-chain state.
//!
//! One account per player, and only the minimum needed to run a single flip and
//! settle it exactly once. Like the vault, this program keeps accounting out of
//! the chain: it records the committed guess, the randomness it was settled
//! with and the outcome, so anyone can re-derive the result and check it was
//! fair. It does not track balances — `bet` is a documented placeholder, not
//! escrow (see the trust model in [`crate`]).

use anchor_lang::prelude::*;

use ephemeral_rollups_sdk::vrf;

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
            _ => Err(crate::errors::FairError::InvalidGuess.into()),
        }
    }
}

/// Where a flip is in its lifecycle. Stored as a 1-byte enum.
///
/// The transitions are `Idle -> Requested -> Settled`, and `Settled` can go
/// back to `Requested` when the player starts another flip. Only the
/// `Requested` state accepts a settlement, which is what makes a duplicate or
/// stale callback a no-op.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum FlipStatus {
    /// Created, no request ever made (or a previous one fully settled and not
    /// yet re-requested).
    Idle,
    /// A randomness request is in flight, awaiting the oracle callback.
    Requested,
    /// The most recent request has been settled; `last_result` / `won` are
    /// valid for `round`.
    Settled,
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

    /// Monotonic request nonce, bumped on every `request_flip`. The callback
    /// carries the round it was issued for; a mismatch means the callback is
    /// stale (a late delivery after a retry) and is ignored.
    pub round: u64,

    /// Client entropy committed for the live request, echoed back by the
    /// callback. Combined with the VRF output, it ensures neither the player
    /// nor the oracle alone chose the randomness input.
    pub client_seed: u8,

    /// The side the player bet on for the live request.
    pub guess: CoinSide,

    /// Reference-only stake. **Not escrowed by this program.** A real game sets
    /// this when it binds the flip to a `casino_vault` settlement; here it marks
    /// where that binding goes and is left `0`.
    pub bet: u64,

    /// Coin side the last settled round landed on. Meaningful once `status` has
    /// reached `Settled`.
    pub last_result: CoinSide,

    /// The exact VRF output the last round was settled with, kept so the result
    /// can be independently re-derived and audited.
    pub last_randomness: [u8; 32],

    /// Whether the player won the last settled round (`last_result == guess`).
    pub won: bool,

    /// Canonical PDA bump, stored so the callback never re-derives it and never
    /// accepts a caller-supplied bump.
    pub bump: u8,

    /// Zeroed space for future fields, so they can be added without a
    /// reallocation.
    pub reserved: [u8; 64],
}

impl Flip {
    /// Total account size: 8-byte Anchor discriminator + serialised fields.
    pub const SIZE: usize = 8 + Self::INIT_SPACE;

    /// Whether a callback carrying `round` is the one this account is currently
    /// waiting for. This is the idempotency guard: it is `true` exactly once
    /// per request, so a duplicate callback (same round, already `Settled`) or a
    /// stale one (a superseded round) returns `false` and must be a no-op.
    pub fn is_awaiting(&self, round: u64) -> bool {
        self.status == FlipStatus::Requested && self.round == round
    }
}

/// Maps a 32-byte VRF output to a coin side.
///
/// Thin wrapper over the SDK's uniform reducer so the request→side mapping
/// lives in one place and is covered by a unit test.
pub fn coin_side_from_randomness(randomness: &[u8; 32]) -> CoinSide {
    CoinSide::from_u8(vrf::rnd::random_u8_with_range(randomness, 0, 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Locks the account layout down: changing a field without accounting for
    /// the size would silently break an already-created flip account.
    #[test]
    fn flip_size_matches_layout() {
        const PLAYER: usize = 32;
        const STATUS: usize = 1;
        const ROUND: usize = 8;
        const CLIENT_SEED: usize = 1;
        const GUESS: usize = 1;
        const BET: usize = 8;
        const LAST_RESULT: usize = 1;
        const LAST_RANDOMNESS: usize = 32;
        const WON: usize = 1;
        const BUMP: usize = 1;
        const RESERVED: usize = 64;
        const FIELDS: usize = PLAYER
            + STATUS
            + ROUND
            + CLIENT_SEED
            + GUESS
            + BET
            + LAST_RESULT
            + LAST_RANDOMNESS
            + WON
            + BUMP
            + RESERVED;

        assert_eq!(Flip::INIT_SPACE, FIELDS);
        assert_eq!(Flip::SIZE, 8 + FIELDS);
    }

    #[test]
    fn coin_side_mapping_is_fixed() {
        // The numeric contract clients rely on.
        assert_eq!(CoinSide::from_u8(0), CoinSide::Heads);
        assert_eq!(CoinSide::from_u8(1), CoinSide::Tails);
        // Out-of-range bytes fold to Tails rather than panicking.
        assert_eq!(CoinSide::from_u8(2), CoinSide::Tails);
        assert_eq!(CoinSide::from_u8(255), CoinSide::Tails);
    }

    #[test]
    fn guess_validation_rejects_non_sides() {
        assert_eq!(CoinSide::try_from_guess(0).unwrap(), CoinSide::Heads);
        assert_eq!(CoinSide::try_from_guess(1).unwrap(), CoinSide::Tails);
        assert!(CoinSide::try_from_guess(2).is_err());
        assert!(CoinSide::try_from_guess(255).is_err());
    }

    #[test]
    fn randomness_maps_deterministically() {
        // Same randomness in, same side out: verifiability means the mapping is
        // a pure function of the VRF output.
        let a = [0u8; 32];
        let b = [0xffu8; 32];
        assert_eq!(coin_side_from_randomness(&a), coin_side_from_randomness(&a));
        assert_eq!(coin_side_from_randomness(&b), coin_side_from_randomness(&b));
        // And the side is always one of the two valid sides.
        for seed in 0u8..=32 {
            let mut r = [0u8; 32];
            r[0] = seed;
            let side = coin_side_from_randomness(&r);
            assert!(side == CoinSide::Heads || side == CoinSide::Tails);
        }
    }

    #[test]
    fn won_is_guess_equals_result() {
        assert!(CoinSide::Heads == CoinSide::Heads); // win
        assert!(CoinSide::Tails == CoinSide::Tails); // win
        assert!(CoinSide::Heads != CoinSide::Tails); // loss
    }

    #[test]
    fn idempotency_guard_accepts_exactly_the_live_round() {
        let mut flip = Flip {
            player: Pubkey::new_unique(),
            status: FlipStatus::Idle,
            round: 0,
            client_seed: 0,
            guess: CoinSide::Heads,
            bet: 0,
            last_result: CoinSide::Heads,
            last_randomness: [0; 32],
            won: false,
            bump: 255,
            reserved: [0; 64],
        };

        // Idle: nothing to settle.
        assert!(!flip.is_awaiting(0));

        // A request is in flight for round 1.
        flip.status = FlipStatus::Requested;
        flip.round = 1;
        assert!(flip.is_awaiting(1), "the live round settles");
        assert!(!flip.is_awaiting(0), "a stale round does not");
        assert!(!flip.is_awaiting(2), "a future round does not");

        // Once settled, a duplicate callback for the same round is a no-op.
        flip.status = FlipStatus::Settled;
        assert!(!flip.is_awaiting(1), "a duplicate callback cannot re-settle");

        // A new request supersedes the old round; a late callback for round 1
        // can no longer settle round 2.
        flip.status = FlipStatus::Requested;
        flip.round = 2;
        assert!(!flip.is_awaiting(1), "a late callback after retry is ignored");
        assert!(flip.is_awaiting(2));
    }
}
