//! `request_flip` — commit a guess and ask the VRF oracle for randomness.

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use ephemeral_rollups_sdk::anchor::vrf;
use ephemeral_rollups_sdk::vrf::{
    self,
    instructions::{create_request_scoped_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};

use crate::constants::FLIP_SEED;
use crate::errors::FairError;
use crate::events::FlipRequestedEvent;
use crate::state::{CoinSide, Flip, FlipStatus};
use crate::utils::current_timestamp;

/// Accounts for [`process_request_flip`].
///
/// `#[vrf]` injects the `program_identity`, `vrf_program`, `slot_hashes` and
/// `system_program` accounts plus the `invoke_signed_vrf` helper used below.
#[vrf]
#[derive(Accounts)]
pub struct RequestFlip<'info> {
    /// The player, and the payer of the VRF request. Bound into the flip PDA
    /// seeds, so a request can only be made for the signer's own flip.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The player's flip account. `bump = flip.bump` with the player-keyed
    /// seeds ties this account to `payer`: a different signer re-derives a
    /// different PDA and fails the seeds check.
    #[account(
        mut,
        seeds = [FLIP_SEED, payer.key().as_ref()],
        bump = flip.bump,
    )]
    pub flip: Account<'info, Flip>,

    /// CHECK: The VRF oracle queue. Pinned to the recognised queues so a flip
    /// cannot be pointed at an attacker-controlled queue. `DEFAULT_QUEUE` is the
    /// base-layer (Solana devnet/mainnet) queue; the others cover the ephemeral
    /// rollup and localnet.
    #[account(
        mut,
        constraint = (
            oracle_queue.key() == vrf::consts::DEFAULT_QUEUE
                || oracle_queue.key() == vrf::consts::DEFAULT_EPHEMERAL_QUEUE
                || oracle_queue.key() == vrf::consts::DEFAULT_TEST_QUEUE
                || oracle_queue.key() == vrf::consts::DEFAULT_EPHEMERAL_TEST_QUEUE
        ) @ FairError::InvalidOracleQueue,
    )]
    pub oracle_queue: UncheckedAccount<'info>,
}

/// Records the guess, bumps the round and fires the VRF request.
///
/// Rejects a second request while one is already `Requested`: the VRF lifecycle
/// is one live request per account, otherwise two callbacks could race over the
/// same state. The guess and the client seed are committed *before* the request
/// so the player cannot change their call once randomness is in flight.
pub fn process_request_flip(
    ctx: Context<RequestFlip>,
    client_seed: u8,
    guess: u8,
) -> Result<()> {
    // Reject anything that is not a coin side rather than coercing it.
    let guess = CoinSide::try_from_guess(guess)?;

    // Commit the request in its own scope so the mutable borrow of the flip
    // ends before the VRF CPI (which borrows `ctx.accounts` immutably).
    let (round, player, flip_key) = {
        let flip = &mut ctx.accounts.flip;
        require!(
            flip.status != FlipStatus::Requested,
            FairError::RequestInProgress
        );

        // Bump the round first: the new value is the nonce that binds this
        // request to exactly one permitted callback.
        let round = flip.round.checked_add(1).ok_or(FairError::MathOverflow)?;
        flip.round = round;
        flip.status = FlipStatus::Requested;
        flip.client_seed = client_seed;
        flip.guess = guess;
        (round, flip.player, flip.key())
    };

    // Forward the callback the data it needs to bind itself to THIS request.
    // `callback_args` is appended after `randomness` as the trailing Borsh
    // arguments of `callback_flip(randomness, client_seed, round)`, so the bytes
    // are the Borsh encoding of `(u8, u64)`: one seed byte then the round as 8
    // little-endian bytes.
    let mut callback_args = Vec::with_capacity(9);
    callback_args.push(client_seed);
    callback_args.extend_from_slice(&round.to_le_bytes());

    let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.payer.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::CallbackFlip::DISCRIMINATOR.to_vec(),
        // Client entropy folded into the VRF input.
        caller_seed: [client_seed; 32],
        // The account the callback must receive and write: this flip.
        accounts_metas: Some(vec![SerializableAccountMeta {
            pubkey: flip_key,
            is_signer: false,
            is_writable: true,
        }]),
        callback_args: Some(callback_args),
        ..Default::default()
    });

    ctx.accounts
        .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;

    emit!(FlipRequestedEvent {
        player,
        round,
        guess,
        timestamp: current_timestamp()?,
    });

    Ok(())
}
