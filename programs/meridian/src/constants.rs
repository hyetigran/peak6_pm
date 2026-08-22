//! Compile-time constants and canonical wire identities (ARCHITECTURE §21).
//! Values validated by the M0 harness are re-declared here for the production
//! program; see `docs/adr/openbook-v2-pin.md`.

use anchor_lang::prelude::*;

// --- PDA seeds ---------------------------------------------------------
pub const CONFIG_SEED: &[u8] = b"config";
pub const OUTCOME_MARKET_SEED: &[u8] = b"outcome_market";
pub const SETTLEMENT_RECORD_SEED: &[u8] = b"settlement_record";
pub const TRANSPORT_VERSION_SEED: &[u8] = b"transport_version";
pub const VENUE_MARKET_AUTHORITY_SEED: &[u8] = b"venue_market_authority";
pub const COLLATERAL_VAULT_SEED: &[u8] = b"collateral_vault";
pub const YES_MINT_SEED: &[u8] = b"yes_mint";
pub const NO_MINT_SEED: &[u8] = b"no_mint";

// --- Pinned external programs (M0-verified) ----------------------------
/// Canonical OpenBook V2 v1.7 devnet deployment (ADR-0030).
pub const OPENBOOK_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb");
/// Provably unsignable fee-admin sentinel (G9): PDA("meridian_fee_admin_sentinel", System).
pub const FEE_ADMIN_SENTINEL: Pubkey =
    anchor_lang::solana_program::pubkey!("EhAss6gbDU57Cmwwyeq3RwHBVRvBK4CkzLS8yvddFZ1E");

/// Metaplex Token Metadata program (canonical mainnet/devnet address).
pub const TOKEN_METADATA_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
pub const FEE_ADMIN_SENTINEL_SEED: &[u8] = b"meridian_fee_admin_sentinel";

// --- Lot scheme (G10) --------------------------------------------------
/// One whole 6-decimal outcome token per base lot.
pub const BASE_LOT_SIZE: i64 = 1_000_000;
/// One price lot == one cent (6-decimal USDC).
pub const QUOTE_LOT_SIZE: i64 = 10_000;
/// OracleConfigParams.conf_filter forwarded at venue creation (oracles None).
pub const PINNED_CONF_FILTER: f32 = 0.1;
pub const OUTCOME_DECIMALS: u8 = 6;
pub const QUOTE_DECIMALS: u8 = 6;

// --- Settlement timing (techContext / ADR-0012) ------------------------
pub const MIN_OVERRIDE_DELAY_SECS: u32 = 3600;
pub const DEVNET_NORMAL_SETTLEMENT_DELAY_SECS: u32 = 1200; // close+20m
pub const MIN_ADD_STRIKE_LEAD_SECS: i64 = 1800; // close-30m
/// Upper bound on a trading session (trade_open -> close). Trading opens at
/// market creation (ADR-0033), so the window runs from ~23.5h overnight up to a
/// long holiday gap. The worst legitimate consecutive-trading-day gap is ~4
/// nights (e.g. a Monday holiday after a weekend, or Good Friday): ~95h of
/// window after the creation offset. Capped at 5 days, ~90k s of headroom, to
/// bound operator-proposed schedules while admitting every real gap.
pub const MAX_SESSION_SECS: i64 = 432_000; // 5 days
pub const MAX_SAMPLE_SPREAD_BPS: u16 = 0; // exact equality in V1

// --- Zero-fee venue (ADR-0001/0007) ------------------------------------
pub const MAKER_FEE: i64 = 0;
pub const TAKER_FEE: i64 = 0;

// --- Reserved padding on every long-lived account (ARCH L452) ----------
pub const RESERVED_PADDING: usize = 64;

/// Inline maker fill cap — G6-measured practical bound (SBF heap OOMs above).
pub const MAX_INLINE_MAKERS: usize = 11;
