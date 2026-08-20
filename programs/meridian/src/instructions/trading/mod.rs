pub mod create_venue_market;
pub mod mint_pair;
pub mod place_limit_order;
pub mod place_take_order;
pub use create_venue_market::*;
pub use mint_pair::*;
pub use place_limit_order::*;
pub use place_take_order::*;

use crate::error::MeridianError;
use crate::state::{MarketState, OutcomeMarket};
use anchor_lang::prelude::*;

/// Trading-window gate: Active, unpaused, not emergency-expired, and inside
/// [trade_open_ts, close_ts). Order-creation wrappers call this.
pub fn require_tradeable(m: &OutcomeMarket, now: i64) -> Result<()> {
    require!(m.state == MarketState::Active as u8, MeridianError::WrongMarketState);
    require!(!m.paused && !m.permanent_pause, MeridianError::TradingClosed);
    require!(!m.emergency_expired, MeridianError::TradingClosed);
    require!(now >= m.trade_open_ts, MeridianError::TradingClosed);
    require!(now < m.close_ts, MeridianError::TradingClosed);
    Ok(())
}
