//! Abandon a Created/Active Outcome Market ONLY while `activity_started` is
//! false and liability/supply are empty (ADR-0011). Leaves a terminal
//! Abandoned tombstone; identity is never recreated.

use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use crate::constants::{CONFIG_SEED, OUTCOME_MARKET_SEED};
use crate::error::MeridianError;
use crate::state::{Config, MarketState, OutcomeMarket};

#[derive(Accounts)]
pub struct AbandonMarket<'info> {
    #[account(address = config.operator @ MeridianError::Unauthorized)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [OUTCOME_MARKET_SEED, &[market.ticker_id], &market.trading_day.to_le_bytes(), &market.strike_1e6.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, OutcomeMarket>,
    #[account(address = market.yes_mint)]
    pub yes_mint: Account<'info, Mint>,
    #[account(address = market.no_mint)]
    pub no_mint: Account<'info, Mint>,
}

pub fn handler(ctx: Context<AbandonMarket>) -> Result<()> {
    let m = &mut ctx.accounts.market;
    require!(
        m.state == MarketState::Created as u8 || m.state == MarketState::Active as u8,
        MeridianError::WrongMarketState
    );
    require!(!m.activity_started, MeridianError::CannotAbandon);
    require!(m.collateral_liability_atoms == 0, MeridianError::CannotAbandon);
    require!(
        ctx.accounts.yes_mint.supply == 0 && ctx.accounts.no_mint.supply == 0,
        MeridianError::CannotAbandon
    );
    require!(!m.has_venue(), MeridianError::CannotAbandon);
    m.state = MarketState::Abandoned as u8;
    Ok(())
}
