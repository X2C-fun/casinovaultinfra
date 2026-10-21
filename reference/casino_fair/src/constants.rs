//! Program-wide constants.
//!
//! There is one `Flip` PDA per player, derived from a fixed seed prefix and the
//! player's key. Defining the seed once here keeps every context deriving the
//! very same address.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::vrf::consts as vrf_consts;

/// Seed prefix of the per-player [`crate::state::Flip`] PDA.
///
/// Full seeds: `["flip", player]`
pub const FLIP_SEED: &[u8] = b"flip";

/// How many slots must pass after `request_flip` before the player may
/// `cancel_flip` an unfulfilled request.
///
/// 150 slots is roughly one minute at Solana's ~400 ms target slot time. A
/// healthy MagicBlock VRF oracle fulfils within a few slots, so this is long
/// enough that the oracle normally settles first and short enough that a flip
/// is not stuck for long when it does not. Cancelling is a **re-roll vector**
/// when a stake is attached; see `docs/fairness.md` before relying on it.
pub const CANCEL_TIMEOUT_SLOTS: u64 = 150;

/// Whether `queue` is a VRF oracle queue this build accepts.
///
/// By default only the **base-layer** queue (`DEFAULT_QUEUE`) is accepted: it
/// is the one a Solana devnet transaction is fulfilled on, and its oracle key is
/// not public. The other MagicBlock queues are opt-in at compile time:
///
/// * feature `ephemeral` — also accept `DEFAULT_EPHEMERAL_QUEUE` (only useful
///   when the flip account is delegated to an ephemeral rollup, which this
///   program does not do itself).
/// * feature `test-queue` — also accept `DEFAULT_TEST_QUEUE` (and, together with
///   `ephemeral`, `DEFAULT_EPHEMERAL_TEST_QUEUE`). Test queues are served by
///   local/test oracles whose keys may be known, which makes outcomes
///   **predictable**. Never enable this for a deployment that settles value.
///
/// A request sent to a queue that is never fulfilled on the cluster would
/// otherwise sit in `Requested` until the cancel timeout, so the default is the
/// narrowest set that actually works on the base layer.
pub fn is_allowed_oracle_queue(queue: &Pubkey) -> bool {
    if *queue == vrf_consts::DEFAULT_QUEUE {
        return true;
    }
    if cfg!(feature = "ephemeral") && *queue == vrf_consts::DEFAULT_EPHEMERAL_QUEUE {
        return true;
    }
    if cfg!(feature = "test-queue") && *queue == vrf_consts::DEFAULT_TEST_QUEUE {
        return true;
    }
    cfg!(all(feature = "test-queue", feature = "ephemeral"))
        && *queue == vrf_consts::DEFAULT_EPHEMERAL_TEST_QUEUE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_feature_enabled_queues_are_accepted() {
        assert!(is_allowed_oracle_queue(&vrf_consts::DEFAULT_QUEUE));
        assert_eq!(
            is_allowed_oracle_queue(&vrf_consts::DEFAULT_EPHEMERAL_QUEUE),
            cfg!(feature = "ephemeral")
        );
        assert_eq!(
            is_allowed_oracle_queue(&vrf_consts::DEFAULT_TEST_QUEUE),
            cfg!(feature = "test-queue")
        );
        assert_eq!(
            is_allowed_oracle_queue(&vrf_consts::DEFAULT_EPHEMERAL_TEST_QUEUE),
            cfg!(all(feature = "test-queue", feature = "ephemeral"))
        );
        assert!(!is_allowed_oracle_queue(&Pubkey::new_unique()));
        assert!(!is_allowed_oracle_queue(&Pubkey::default()));
    }
}
