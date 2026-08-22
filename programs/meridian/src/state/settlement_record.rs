//! Canonical Settlement Record (PRD ID-015): one PDA per (ticker_id,
//! trading_day), shared by every Strike that day. Immutable header from the
//! first Outcome Market; transitions ONCE Pending -> FinalOracle | FinalManual
//! (first valid wins). Permanent, no external mutable authority, no close.

use anchor_lang::prelude::*;
use crate::constants::RESERVED_PADDING;

#[account]
pub struct SettlementRecord {
    pub state: u8, // SettlementRecordState
    pub bump: u8,

    // immutable header (from the first Outcome Market for the tuple)
    pub schema_version: u8,
    pub ticker_id: u8,
    pub trading_day: u32,
    pub close_ts: i64,
    pub prior_official_close_1e6: u64,
    pub settlement_transport_version_id: u32,
    pub oracle_program_id: Pubkey,
    pub oracle_programdata: Pubkey,
    pub oracle_deployment_slot: u64,
    pub oracle_executable_sha256: [u8; 32],
    pub oracle_upgrade_authority: Pubkey,
    pub oracle_feed: Pubkey,
    pub oracle_job_hash: [u8; 32],
    pub provider_id: u16,
    pub close_method_id: u16,
    pub normal_settlement_delay_secs: u32,
    pub min_samples: u8,
    pub max_stale_slots: u64,
    pub max_sample_spread_bps: u16,
    pub max_price_band_bps: u16,
    pub override_delay_secs: u32,

    // common result (zeroed while Pending; written atomically with state)
    pub official_close_1e6: u64,
    pub halt_or_contingency_status: u8,
    pub is_final: u8,
    pub is_unadjusted: u8,
    pub finalized_ts: i64,

    // FinalOracle-only
    pub official_close_observed_ts: i64,
    pub exchange_published_ts: i64,
    pub provider_observed_ts: i64,
    pub provider_revision_hash: [u8; 32],
    pub source_record_id_hash: [u8; 32],
    pub raw_response_sha256: [u8; 32],
    pub delivery_update_slot: u64,
    pub sample_count: u8,
    pub sample_spread_bps: u16,

    // FinalManual-only
    pub manual_source_a_value_1e6: u64,
    pub manual_source_b_value_1e6: u64,
    pub override_reason_code: u16,
    pub manual_evidence_manifest_sha256: [u8; 32],

    pub reserved_padding: [u8; RESERVED_PADDING],
}

impl SettlementRecord {
    pub const SIZE: usize = 8
        + 1 + 1
        // header
        + 1 + 1 + 4 + 8 + 8 + 4 + 32 + 32 + 8 + 32 + 32 + 32 + 32 + 2 + 2 + 4 + 1 + 8 + 2 + 2 + 4
        // common
        + 8 + 1 + 1 + 1 + 8
        // oracle
        + 8 + 8 + 8 + 32 + 32 + 32 + 8 + 1 + 2
        // manual
        + 8 + 8 + 2 + 32
        + RESERVED_PADDING;

    /// Header digest bound into each Outcome Market so later Strikes must match.
    pub fn header_digest(&self) -> [u8; 32] {
        use anchor_lang::solana_program::hash::hashv;
        hashv(&[
            &[self.schema_version, self.ticker_id],
            &self.trading_day.to_le_bytes(),
            &self.close_ts.to_le_bytes(),
            &self.prior_official_close_1e6.to_le_bytes(),
            &self.settlement_transport_version_id.to_le_bytes(),
            self.oracle_feed.as_ref(),
            &self.oracle_job_hash,
            &self.normal_settlement_delay_secs.to_le_bytes(),
            &self.min_samples.to_le_bytes(),
            &self.max_stale_slots.to_le_bytes(),
            &self.max_price_band_bps.to_le_bytes(),
            &self.override_delay_secs.to_le_bytes(),
        ])
        .to_bytes()
    }

    pub fn is_final(&self) -> bool {
        self.is_final == 1 && self.is_unadjusted == 1
    }
}
