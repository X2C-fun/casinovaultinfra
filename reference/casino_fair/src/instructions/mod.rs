//! One module per instruction. Each module owns its `Accounts` struct and its
//! handler, so account validation always sits next to the logic it guards. The
//! state transitions themselves are methods on [`crate::state::Flip`].

pub mod callback_flip;
pub mod cancel_flip;
pub mod close_flip;
pub mod init_flip;
pub mod request_flip;

// Glob re-exports are required: `#[program]` resolves the client/CPI account
// helpers that `#[derive(Accounts)]` generates through the crate root. Handlers
// are named `process_*` so nothing collides here.
pub use callback_flip::*;
pub use cancel_flip::*;
pub use close_flip::*;
pub use init_flip::*;
pub use request_flip::*;
