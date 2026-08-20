//! The shared creation primitive (ARCHITECTURE §7): create an Outcome Market
//! for (ticker, trading_day, strike). Creates the Yes/No Pair mints and the
//! collateral vault under the market PDA, and initializes-or-matches the
//! canonical ticker/day SettlementRecord Pending header.
//!
//! Both first-of-day creation and intraday Add Strike use this one path; the
//! only difference is whether the SettlementRecord is created here or matched.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::error::MeridianError;
use crate::events::OutcomeMarketCreated;
use crate::state::*;
use super::{validate_schedule, validate_strike};

#[derive(Accounts)]
#[instruction(ticker_id: u8, trading_day: u32, strike_1e6: u64)]
pub struct CreateOutcomeMarket<'info> {
    #[account(mut, address = config.operator @ MeridianError::Unauthorized)]
    pub operator: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED], bump = config.bump,
        constraint = !config.paused @ MeridianError::ConfigPaused,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = operator,
        space = OutcomeMarket::SIZE,
        seeds = [OUTCOME_MARKET_SEED, &[ticker_id], &trading_day.to_le_bytes(), &strike_1e6.to_le_bytes()],
        bump,
    )]
    pub market: Box<Account<'info, OutcomeMarket>>,

    /// Canonical ticker/day Settlement Record — created here if first for the
    /// tuple, otherwise its header must match.
    #[account(
        init_if_needed,
        payer = operator,
        space = SettlementRecord::SIZE,
        seeds = [SETTLEMENT_RECORD_SEED, &[ticker_id], &trading_day.to_le_bytes()],
        bump,
    )]
    pub settlement_record: Box<Account<'info, SettlementRecord>>,

    /// Immutable transport version resolved off-chain; its identity is
    /// snapshotted into the record header on first creation.
    pub feed_version: Box<Account<'info, FeedVersion>>,

    #[account(address = config.quote_mint @ MeridianError::WrongQuoteMint)]
    pub quote_mint: Box<Account<'info, Mint>>,

    #[account(
        init, payer = operator,
        seeds = [YES_MINT_SEED, market.key().as_ref()], bump,
        mint::decimals = OUTCOME_DECIMALS, mint::authority = market,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(
        init, payer = operator,
        seeds = [NO_MINT_SEED, market.key().as_ref()], bump,
        mint::decimals = OUTCOME_DECIMALS, mint::authority = market,
    )]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(
        init, payer = operator,
        associated_token::mint = quote_mint, associated_token::authority = market,
    )]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateOutcomeMarket>,
    ticker_id: u8,
    trading_day: u32,
    strike_1e6: u64,
    prior_official_close_1e6: u64,
    mint_open_ts: i64,
    trade_open_ts: i64,
    close_ts: i64,
    metadata_manifest_sha256: [u8; 32],
    normal_settlement_delay_secs: u32,
    override_delay_secs: u32,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(ctx.accounts.config.is_ticker_supported(ticker_id), MeridianError::UnsupportedTicker);
    require!(prior_official_close_1e6 > 0, MeridianError::InvalidPriorClose);
    require!(metadata_manifest_sha256 != [0u8; 32], MeridianError::MetadataUnset);
    validate_strike(strike_1e6)?;
    validate_schedule(mint_open_ts, trade_open_ts, close_ts, now)?;
    #[cfg(not(feature = "localnet"))]
    {
        require!(
            normal_settlement_delay_secs >= DEVNET_NORMAL_SETTLEMENT_DELAY_SECS,
            MeridianError::InvalidSchedule
        );
        require!(override_delay_secs >= MIN_OVERRIDE_DELAY_SECS, MeridianError::InvalidSchedule);
    }
    require!(ctx.accounts.feed_version.ticker_id == ticker_id, MeridianError::SettlementHeaderMismatch);

    let cfg = &ctx.accounts.config;
    let fv = &ctx.accounts.feed_version;
    let rec = &mut ctx.accounts.settlement_record;

    // init-or-match the canonical ticker/day header
    if rec.schema_version == 0 {
        rec.state = SettlementRecordState::Pending as u8;
        rec.bump = ctx.bumps.settlement_record;
        rec.schema_version = 1;
        rec.ticker_id = ticker_id;
        rec.trading_day = trading_day;
        rec.close_ts = close_ts;
        rec.prior_official_close_1e6 = prior_official_close_1e6;
        rec.settlement_transport_version_id = fv.version_id;
        rec.switchboard_program_id = fv.switchboard_program_id;
        rec.switchboard_programdata = fv.switchboard_programdata;
        rec.switchboard_deployment_slot = fv.switchboard_deployment_slot;
        rec.switchboard_executable_sha256 = fv.switchboard_executable_sha256;
        rec.switchboard_upgrade_authority = fv.switchboard_upgrade_authority;
        rec.switchboard_feed = fv.switchboard_feed;
        rec.switchboard_job_hash = fv.switchboard_job_hash;
        rec.provider_id = fv.provider_id;
        rec.close_method_id = fv.close_method_id;
        rec.normal_settlement_delay_secs = normal_settlement_delay_secs;
        rec.min_samples = cfg.min_samples;
        rec.max_stale_slots = cfg.max_stale_slots;
        rec.max_sample_spread_bps = cfg.max_sample_spread_bps;
        rec.max_price_band_bps = cfg.max_price_band_bps;
        rec.override_delay_secs = override_delay_secs;
    } else {
        // later Strike for the same tuple: header must match exactly
        require!(
            rec.ticker_id == ticker_id
                && rec.trading_day == trading_day
                && rec.close_ts == close_ts
                && rec.prior_official_close_1e6 == prior_official_close_1e6
                && rec.settlement_transport_version_id == fv.version_id
                && rec.normal_settlement_delay_secs == normal_settlement_delay_secs
                && rec.override_delay_secs == override_delay_secs,
            MeridianError::SettlementHeaderMismatch
        );
    }

    let m = &mut ctx.accounts.market;
    m.schema_version = 1;
    m.bump = ctx.bumps.market;
    m.ticker_id = ticker_id;
    m.trading_day = trading_day;
    m.strike_1e6 = strike_1e6;
    m.mint_open_ts = mint_open_ts;
    m.trade_open_ts = trade_open_ts;
    m.close_ts = close_ts;
    m.state = MarketState::Created as u8;
    m.activity_started = false;
    m.paused = false;
    m.permanent_pause = false;
    m.emergency_expired = false;
    m.outcome = Outcome::Unset as u8;
    m.settlement_record = ctx.accounts.settlement_record.key();
    m.settlement_record_digest = ctx.accounts.settlement_record.header_digest();
    m.yes_mint = ctx.accounts.yes_mint.key();
    m.no_mint = ctx.accounts.no_mint.key();
    m.collateral_vault = ctx.accounts.collateral_vault.key();
    m.metadata_manifest_sha256 = metadata_manifest_sha256;
    m.market_rent_refund_address = ctx.accounts.operator.key();
    m.venue_rent_refund_address = ctx.accounts.operator.key();
    m.collateral_liability_atoms = 0;

    emit!(OutcomeMarketCreated {
        market: m.key(),
        ticker_id,
        trading_day,
        strike_1e6,
        settlement_record: ctx.accounts.settlement_record.key(),
    });
    Ok(())
}
