//! Small shared helpers.

use anchor_lang::prelude::*;

/// Unix timestamp of the current slot, stamped onto every event.
pub fn current_timestamp() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}
