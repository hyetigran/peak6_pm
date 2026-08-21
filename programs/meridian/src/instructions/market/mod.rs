pub mod create_outcome_market;
pub mod abandon_market;
pub mod publish_metadata;
pub use create_outcome_market::*;
pub use abandon_market::*;
pub use publish_metadata::*;

use crate::error::MeridianError;
use anchor_lang::prelude::*;

/// Strike must be a positive whole-dollar multiple of $10 in 1e6 units.
pub fn validate_strike(strike_1e6: u64) -> Result<()> {
    require!(strike_1e6 > 0, MeridianError::InvalidStrike);
    // $10 == 10_000_000 in 1e6 units
    require!(strike_1e6 % 10_000_000 == 0, MeridianError::InvalidStrike);
    Ok(())
}

/// Validate the market schedule: mint < trade < close, a 30-minute
/// mint-to-trade interval, a 3.5h or 6.5h session, and the add-strike lead
/// time relative to `now`.
pub fn validate_schedule(mint_open_ts: i64, trade_open_ts: i64, close_ts: i64, now: i64) -> Result<()> {
    use crate::constants::MIN_ADD_STRIKE_LEAD_SECS;
    require!(mint_open_ts < trade_open_ts && trade_open_ts < close_ts, MeridianError::InvalidSchedule);
    #[cfg(not(feature = "localnet"))]
    {
        require!(trade_open_ts - mint_open_ts == 1800, MeridianError::InvalidSchedule);
        let session = close_ts - trade_open_ts;
        require!(session == 12_600 || session == 23_400, MeridianError::InvalidSchedule); // 3.5h or 6.5h
        require!(now <= close_ts - MIN_ADD_STRIKE_LEAD_SECS, MeridianError::InvalidSchedule);
    }
    #[cfg(feature = "localnet")]
    let _ = now;
    Ok(())
}
