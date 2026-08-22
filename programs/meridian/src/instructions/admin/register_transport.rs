//! Governance registers an immutable Settlement Transport Version (PRD ID-014)
//! for a ticker. Snapshots the oracle (Pyth adapter) executable identity; never mutated
//! once referenced by a market or unsettled day.

use anchor_lang::prelude::*;
use crate::constants::{CONFIG_SEED, TRANSPORT_VERSION_SEED};
use crate::error::MeridianError;
use crate::state::{Config, FeedVersion};

#[derive(Accounts)]
#[instruction(version_id: u32, ticker_id: u8)]
pub struct RegisterTransport<'info> {
    #[account(mut, address = config.governance @ MeridianError::Unauthorized)]
    pub governance: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init, payer = governance, space = FeedVersion::SIZE,
        seeds = [TRANSPORT_VERSION_SEED, &[ticker_id], &version_id.to_le_bytes()], bump,
    )]
    pub feed_version: Account<'info, FeedVersion>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<RegisterTransport>,
    version_id: u32,
    ticker_id: u8,
    oracle_program_id: Pubkey,
    oracle_programdata: Pubkey,
    oracle_deployment_slot: u64,
    oracle_executable_sha256: [u8; 32],
    oracle_upgrade_authority: Pubkey,
    oracle_feed: Pubkey,
    oracle_job_hash: [u8; 32],
    provider_id: u16,
    close_method_id: u16,
    activated_trading_day: u32,
) -> Result<()> {
    require!(ctx.accounts.config.is_ticker_supported(ticker_id), MeridianError::UnsupportedTicker);
    let f = &mut ctx.accounts.feed_version;
    f.schema_version = 1;
    f.bump = ctx.bumps.feed_version;
    f.version_id = version_id;
    f.ticker_id = ticker_id;
    f.oracle_program_id = oracle_program_id;
    f.oracle_programdata = oracle_programdata;
    f.oracle_deployment_slot = oracle_deployment_slot;
    f.oracle_executable_sha256 = oracle_executable_sha256;
    f.oracle_upgrade_authority = oracle_upgrade_authority;
    f.oracle_feed = oracle_feed;
    f.oracle_job_hash = oracle_job_hash;
    f.provider_id = provider_id;
    f.close_method_id = close_method_id;
    f.activated_trading_day = activated_trading_day;
    Ok(())
}
