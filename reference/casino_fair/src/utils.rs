//! Small shared helpers.

use anchor_lang::prelude::*;

/// Unix timestamp of the current slot, stamped onto every event.
pub fn current_timestamp() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// The current slot. Starts and checks the cancel timeout.
pub fn current_slot() -> Result<u64> {
    Ok(Clock::get()?.slot)
}
