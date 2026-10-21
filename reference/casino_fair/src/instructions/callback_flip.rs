//! `callback_flip` — the VRF oracle's settlement callback.
//!
//! This is never called by a client: the VRF oracle invokes it once it has
//! produced the randomness for a `request_flip`. Everything that makes it safe
//! lives in the account context and [`Flip::settle`].

use anchor_lang::prelude::*;

use ephemeral_rollups_sdk::anchor::vrf_callback;

use crate::constants::FLIP_SEED;
use crate::events::FlipSettledEvent;
use crate::state::Flip;
use crate::utils::current_timestamp;

/// Accounts for [`process_callback_flip`].
///
/// `#[vrf_callback]` injects a `vrf_program_identity: Signer` bound to this
/// program's scoped identity PDA. That signer is the whole security of the
/// callback: without the macro the struct still compiles, but anyone could call
/// `callback_flip` with randomness of their choosing and settle a flip in their
/// favour. It MUST stay.
#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackFlip<'info> {
    /// The flip being settled. Re-derived from the player recorded in the
    /// account, so the oracle-supplied account must be the canonical PDA — the
    /// callback cannot be redirected onto a different flip.
    #[account(
        mut,
        seeds = [FLIP_SEED, flip.player.as_ref()],
        bump = flip.bump,
    )]
    pub flip: Account<'info, Flip>,
}

/// Settles the request `randomness` was produced for, exactly once.
///
/// `client_seed`, `round` and `requested_slot` are the trailing
/// `callback_args` the request forwarded. All three, plus `status ==
/// Requested`, must match the live request ([`Flip::is_awaiting`]); otherwise
/// (a duplicate, a callback for a cancelled or superseded request, or
/// mismatched arguments) the handler returns `Ok` without touching state.
pub fn process_callback_flip(
    ctx: Context<CallbackFlip>,
    randomness: [u8; 32],
    client_seed: u8,
    round: u64,
    requested_slot: u64,
) -> Result<()> {
    let flip = &mut ctx.accounts.flip;

    let Some(settlement) = flip.settle(randomness, client_seed, round, requested_slot) else {
        msg!(
            "Ignoring VRF callback: arg round={} seed={} slot={} vs live round={} seed={} slot={} status={:?}",
            round,
            client_seed,
            requested_slot,
            flip.round,
            flip.client_seed,
            flip.requested_slot,
            flip.status
        );
        return Ok(());
    };

    emit!(FlipSettledEvent {
        player: flip.player,
        round: settlement.round,
        guess: settlement.guess,
        result: settlement.result,
        won: settlement.won,
        timestamp: current_timestamp()?,
    });

    Ok(())
}
