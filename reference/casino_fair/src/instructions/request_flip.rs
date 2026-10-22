//! `request_flip` — commit a guess and ask the VRF oracle for randomness.

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use ephemeral_rollups_sdk::anchor::vrf;
use ephemeral_rollups_sdk::vrf::{
    instructions::{create_request_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};

use crate::constants::{is_allowed_oracle_queue, FLIP_SEED};
use crate::errors::FairError;
use crate::events::FlipRequestedEvent;
use crate::state::{CoinSide, Flip};
use crate::utils::{current_slot, current_timestamp};

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

    /// CHECK: The VRF oracle queue. Restricted by
    /// [`is_allowed_oracle_queue`]: only the base-layer `DEFAULT_QUEUE` unless
    /// the `ephemeral` / `test-queue` cargo features opt in to more.
    #[account(
        mut,
        constraint = is_allowed_oracle_queue(&oracle_queue.key()) @ FairError::InvalidOracleQueue,
    )]
    pub oracle_queue: UncheckedAccount<'info>,
}

/// Records the guess, bumps the round and fires the VRF request.
///
/// See [`Flip::begin_request`] for the rules (one live request per account;
/// guess and seed committed before the CPI).
pub fn process_request_flip(ctx: Context<RequestFlip>, client_seed: u8, guess: u8) -> Result<()> {
    // Reject anything that is not a coin side rather than coercing it.
    let guess = CoinSide::try_from_guess(guess)?;
    let slot = current_slot()?;

    // Commit the request in its own scope so the mutable borrow of the flip
    // ends before the VRF CPI (which borrows `ctx.accounts` immutably).
    let (round, player, flip_key) = {
        let flip = &mut ctx.accounts.flip;
        let round = flip.begin_request(client_seed, guess, slot)?;
        (round, flip.player, flip.key())
    };

    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.payer.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::CallbackFlip::DISCRIMINATOR.to_vec(),
        // The one client byte, repeated. A request tag, not meaningful entropy.
        caller_seed: [client_seed; 32],
        // The account the callback must receive and write: this flip.
        accounts_metas: Some(vec![SerializableAccountMeta {
            pubkey: flip_key,
            is_signer: false,
            is_writable: true,
        }]),
        callback_args: Some(encode_callback_args(client_seed, round, slot)),
    });

    ctx.accounts
        .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;

    emit!(FlipRequestedEvent {
        player,
        round,
        guess,
        requested_slot: slot,
        timestamp: current_timestamp()?,
    });

    Ok(())
}

/// The trailing Borsh arguments of
/// `callback_flip(randomness, client_seed, round, requested_slot)`.
///
/// The oracle appends `callback_args` after `randomness`, so the bytes must be
/// the Borsh encoding of `(u8, u64, u64)`: the seed byte, then the round and
/// the request slot as little-endian `u64`s. These bind the callback to exactly
/// this request (see [`Flip::is_awaiting`]).
pub fn encode_callback_args(client_seed: u8, round: u64, requested_slot: u64) -> Vec<u8> {
    let mut args = Vec::with_capacity(17);
    args.push(client_seed);
    args.extend_from_slice(&round.to_le_bytes());
    args.extend_from_slice(&requested_slot.to_le_bytes());
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::InstructionData;

    /// The bytes the oracle sends back must decode into exactly the arguments
    /// `callback_flip` declares, or every callback would fail to deserialize.
    #[test]
    fn callback_args_match_the_callback_instruction_encoding() {
        let randomness = [7u8; 32];
        let mut oracle_data = crate::instruction::CallbackFlip::DISCRIMINATOR.to_vec();
        oracle_data.extend_from_slice(&randomness);
        oracle_data.extend_from_slice(&encode_callback_args(0xAB, 0x0102_0304_0506_0708, 99));

        let expected = crate::instruction::CallbackFlip {
            randomness,
            client_seed: 0xAB,
            round: 0x0102_0304_0506_0708,
            requested_slot: 99,
        };
        assert_eq!(oracle_data, expected.data());
    }
}
