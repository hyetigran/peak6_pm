//! Settle an Outcome Market from its finalized shared Settlement Record. The
//! program derives the winner (Official Close at-or-above the Strike => Yes,
//! ADR-0005; equality belongs to Yes). Irreversible once written.

use anchor_lang::prelude::*;
use crate::constants::OUTCOME_MARKET_SEED;
use crate::error::MeridianError;
use crate::state::{MarketState, Outcome, OutcomeMarket, SettlementRecord};

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    /// Permissionless once the record is final.
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [OUTCOME_MARKET_SEED, &[market.ticker_id], &market.trading_day.to_le_bytes(), &market.strike_1e6.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, OutcomeMarket>,
    #[account(address = market.settlement_record @ MeridianError::SettlementHeaderMismatch)]
    pub record: Account<'info, SettlementRecord>,
}

pub fn handler(ctx: Context<SettleMarket>) -> Result<()> {
    let r = &ctx.accounts.record;
    let m = &mut ctx.accounts.market;
    // settle from Created (mint-only, never traded) or Active
    require!(
        m.state == MarketState::Created as u8 || m.state == MarketState::Active as u8,
        MeridianError::WrongMarketState
    );
    require!(r.is_final(), MeridianError::SettlementTooEarly);
    // the bound record must be the one this market froze
    require!(
        m.settlement_record_digest == r.header_digest(),
        MeridianError::SettlementHeaderMismatch
    );
    // at-or-above the Strike wins Yes (equality -> Yes)
    let outcome = if r.official_close_1e6 >= m.strike_1e6 { Outcome::Yes } else { Outcome::No };
    m.outcome = outcome as u8;
    m.settlement_price_1e6 = r.official_close_1e6;
    m.settled_ts = Clock::get()?.unix_timestamp;
    m.manual_settled = r.state == crate::state::SettlementRecordState::FinalManual as u8;
    m.state = MarketState::Settled as u8;
    Ok(())
}
