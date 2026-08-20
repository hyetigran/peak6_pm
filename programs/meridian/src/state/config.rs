//! Global Config account (ARCHITECTURE §6.1): versioned, role-governed,
//! protocol-fee-free. Owns the pinned OpenBook identity, the quote-mint pin,
//! and per-run settlement-quality bounds. No fee/treasury fields (ADR-0001/0007).

use anchor_lang::prelude::*;
use crate::constants::RESERVED_PADDING;

#[account]
pub struct Config {
    pub schema_version: u8,
    pub bump: u8,

    // roles — each rotation is two-step (propose + accept)
    pub governance: Pubkey,
    pub pending_governance: Pubkey,
    pub operator: Pubkey,
    pub pending_operator: Pubkey,
    pub pause_authority: Pubkey,
    pub pending_pause_authority: Pubkey,
    pub override_authority: Pubkey,
    pub pending_override_authority: Pubkey,

    // global
    pub quote_mint: Pubkey,
    pub token_program: Pubkey,
    pub quote_decimals: u8,
    pub supported_ticker_mask: u8, // bit i set => TickerId i supported
    pub paused: bool,

    // pinned OpenBook identity (G1 / ADR-0030 monitored)
    pub openbook_program_id: Pubkey,
    pub openbook_programdata: Pubkey,
    pub openbook_deployment_slot: u64,
    pub openbook_executable_sha256: [u8; 32],
    pub openbook_upgrade_authority: Pubkey, // all-zero == None (monitored, not required)

    // settlement-quality bounds (frozen per run; published by G11)
    pub min_samples: u8,
    pub max_stale_slots: u64,
    pub max_sample_spread_bps: u16,
    pub max_price_band_bps: u16,

    pub reserved: [u8; RESERVED_PADDING],
}

impl Config {
    pub const SIZE: usize = 8 // disc
        + 1 + 1
        + 32 * 8            // roles
        + 32 + 32 + 1 + 1 + 1 // global
        + 32 + 32 + 8 + 32 + 32 // openbook identity
        + 1 + 8 + 2 + 2     // quality
        + RESERVED_PADDING;

    pub fn is_ticker_supported(&self, ticker: u8) -> bool {
        ticker != 0 && ticker < 8 && (self.supported_ticker_mask & (1u8 << ticker)) != 0
    }
}
