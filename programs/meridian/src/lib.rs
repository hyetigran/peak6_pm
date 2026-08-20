//! Meridian — same-day MAG7 binary Outcome Markets on Solana (V1, devnet).
//!
//! Built on the M0-validated OpenBook V2 v1.7 integration and pair-collateral
//! model. Protocol-fee-free (ADR-0001/0007); one Yes/USDC OpenBook Venue
//! Market per Outcome Market; settlement from one shared Settlement Record per
//! ticker and Trading Day.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod openbook;
pub mod state;
pub mod instructions;

use instructions::*;
use instructions::rotate_role::Role;

declare_id!("FF6mu5FFb1q1Qz88x1HnhkePdF8Q1dXWnTfUUSkzUT3t");

#[program]
pub mod meridian {
    use super::*;

    /// One-time global Config with roles, pinned OpenBook identity, quote-mint
    /// pin, and settlement-quality bounds.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        operator: Pubkey,
        pause_authority: Pubkey,
        override_authority: Pubkey,
        supported_ticker_mask: u8,
        openbook_deployment_slot: u64,
        openbook_executable_sha256: [u8; 32],
        openbook_upgrade_authority: Pubkey,
        min_samples: u8,
        max_stale_slots: u64,
        max_price_band_bps: u16,
    ) -> Result<()> {
        initialize_config::handler(
            ctx, operator, pause_authority, override_authority, supported_ticker_mask,
            openbook_deployment_slot, openbook_executable_sha256, openbook_upgrade_authority,
            min_samples, max_stale_slots, max_price_band_bps,
        )
    }

    /// Governance proposes a role rotation; the incoming key must accept.
    pub fn propose_role(ctx: Context<ProposeRole>, role: Role, pending: Pubkey) -> Result<()> {
        rotate_role::propose(ctx, role, pending)
    }
    pub fn accept_role(ctx: Context<AcceptRole>, role: Role) -> Result<()> {
        rotate_role::accept(ctx, role)
    }

    /// Pause Authority toggles the global pause.
    pub fn set_global_pause(ctx: Context<SetGlobalPause>, paused: bool) -> Result<()> {
        set_global_pause::handler(ctx, paused)
    }
}
