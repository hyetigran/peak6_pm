//! Immutable Settlement Transport Version (PRD ID-014). One per (ticker,
//! version_id); registered by governance, never mutated once referenced.

use anchor_lang::prelude::*;
use crate::constants::RESERVED_PADDING;

#[account]
pub struct FeedVersion {
    pub schema_version: u8,
    pub bump: u8,
    pub reserved: [u8; RESERVED_PADDING],
    pub version_id: u32,
    pub ticker_id: u8,
    pub switchboard_program_id: Pubkey,
    pub switchboard_programdata: Pubkey,
    pub switchboard_deployment_slot: u64,
    pub switchboard_executable_sha256: [u8; 32],
    pub switchboard_upgrade_authority: Pubkey, // all-zero == None
    pub switchboard_feed: Pubkey,
    pub switchboard_job_hash: [u8; 32],
    pub provider_id: u16,
    pub close_method_id: u16,
    pub activated_trading_day: u32,
}

impl FeedVersion {
    pub const SIZE: usize = 8 + 1 + 1 + RESERVED_PADDING
        + 4 + 1 + 32 + 32 + 8 + 32 + 32 + 32 + 32 + 2 + 2 + 4;
}
