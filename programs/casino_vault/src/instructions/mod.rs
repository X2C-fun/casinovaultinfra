//! One module per instruction. Each module owns its `Accounts` struct and its
//! handler, so account validation always sits next to the logic it guards.

pub mod admin;
pub mod deposit;
pub mod initialize;
pub mod set_paused;
pub mod withdraw;

// Glob re-exports are required: `#[program]` resolves the client/CPI account
// helpers that `#[derive(Accounts)]` generates through the crate root. Handlers
// are named `process_*` so nothing collides here.
pub use admin::*;
pub use deposit::*;
pub use initialize::*;
pub use set_paused::*;
pub use withdraw::*;
