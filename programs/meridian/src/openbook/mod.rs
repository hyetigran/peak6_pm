//! OpenBook V2 v1.7 CPI adapter — generated from the MIT IDL and account
//! layouts only (no GPL). Every discriminator, byte offset, and account order
//! here was validated by the M0 harness (`docs/adr/openbook-v2-pin.md`).
pub mod cpi;
pub use cpi::*;
