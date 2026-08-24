//! Outcome Market (ARCHITECTURE §7): one per (ticker, trading_day, strike).
//! A Pair of Yes/No mints, a collateral vault, a bound SettlementRecord, and
//! (once attached) a single Yes/USDC OpenBook Venue Market.

use anchor_lang::prelude::*;
use crate::constants::RESERVED_PADDING;

#[account]
pub struct OutcomeMarket {
    pub schema_version: u8,
    pub bump: u8,

    // identity
    pub ticker_id: u8,
    pub trading_day: u32,
    pub strike_1e6: u64,

    // lifecycle
    pub mint_open_ts: i64,
    pub trade_open_ts: i64,
    pub close_ts: i64,
    pub state: u8,           // MarketState
    pub activity_started: bool, // monotonic; first mint/order sets true
    pub paused: bool,
    pub permanent_pause: bool,
    pub permanent_pause_reason: u16,
    pub emergency_expired: bool,
    pub emergency_expired_ts: i64,
    pub emergency_reason_code: u16,

    // outcome (written at settlement)
    pub settlement_price_1e6: u64,
    pub outcome: u8,        // Outcome
    pub settled_ts: i64,
    pub settlement_record: Pubkey,
    pub settlement_record_digest: [u8; 32],
    pub manual_settled: bool,

    // assets
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub collateral_vault: Pubkey,
    pub program_yes_trade_ata: Pubkey,

    // venue (zeroed until create_venue_market)
    pub openbook_market: Pubkey,
    pub openbook_market_authority: Pubkey,
    pub bids: Pubkey,
    pub asks: Pubkey,
    pub event_heap: Pubkey,
    pub openbook_base_vault: Pubkey,
    pub openbook_quote_vault: Pubkey,
    pub venue_market_authority_bump: u8,

    // metadata manifest (published + verified before mint, ADR-0016)
    pub metadata_manifest_sha256: [u8; 32],

    // rent refunds (snapshotted at creation, ADR-0027)
    pub market_rent_refund_address: Pubkey,
    pub venue_rent_refund_address: Pubkey,

    // accounting (ADR-0002): supply-derived USDC-atom obligation
    pub collateral_liability_atoms: u64,

    // venue closure (ADR-0027): unix ts when `close_venue` reclaimed the
    // OpenBook rent to `venue_rent_refund_address`; 0 while the venue is live.
    pub venue_closed_ts: i64,

    pub reserved: [u8; RESERVED_PADDING - 8],
}

impl OutcomeMarket {
    pub const SIZE: usize = 8
        + 1 + 1
        + 1 + 4 + 8                         // identity
        + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 2 + 1 + 8 + 2 // lifecycle
        + 8 + 1 + 8 + 32 + 32 + 1           // outcome
        + 32 * 4                            // assets
        + 32 * 7 + 1                        // venue
        + 32                                // metadata manifest
        + 32 + 32                           // rent refunds
        + 8                                 // liability
        + 8                                 // venue_closed_ts
        + (RESERVED_PADDING - 8);

    pub fn has_venue(&self) -> bool {
        self.openbook_market != Pubkey::default()
    }

    /// Venue attached and its OpenBook accounts not yet closed.
    pub fn venue_live(&self) -> bool {
        self.has_venue() && self.venue_closed_ts == 0
    }
}
