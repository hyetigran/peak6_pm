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
/// mint-to-trade interval, a bounded trading session, and the add-strike lead
/// time relative to `now`.
pub fn validate_schedule(mint_open_ts: i64, trade_open_ts: i64, close_ts: i64, now: i64) -> Result<()> {
    use crate::constants::MIN_ADD_STRIKE_LEAD_SECS;
    require!(mint_open_ts < trade_open_ts && trade_open_ts < close_ts, MeridianError::InvalidSchedule);
    #[cfg(not(feature = "localnet"))]
    {
        use crate::constants::MAX_SESSION_SECS;
        require!(trade_open_ts - mint_open_ts == 1800, MeridianError::InvalidSchedule);
        // Trading opens when the market exists (ADR-0033): the session runs from
        // trade_open to close and may span from ~23.5h overnight up to a
        // long-weekend/holiday gap, so bound it instead of pinning 3.5h/6.5h.
        // (mint < trade < close above guarantees the session is positive.)
        require!(close_ts - trade_open_ts <= MAX_SESSION_SECS, MeridianError::InvalidSchedule);
        require!(now <= close_ts - MIN_ADD_STRIKE_LEAD_SECS, MeridianError::InvalidSchedule);
    }
    #[cfg(feature = "localnet")]
    let _ = now;
    Ok(())
}

#[cfg(all(test, not(feature = "localnet")))]
mod schedule_tests {
    use super::validate_schedule;
    use crate::constants::MAX_SESSION_SECS;

    // mint at 0, trade at the required 30m lead, close = trade + session.
    fn sched(session: i64, now: i64) -> anchor_lang::Result<()> {
        validate_schedule(0, 1800, 1800 + session, now)
    }

    #[test]
    fn accepts_creation_to_close_windows() {
        assert!(sched(84_600, 0).is_ok(), "~23.5h overnight window");
        assert!(sched(342_000, 0).is_ok(), "~95h long-weekend/holiday window");
        assert!(sched(MAX_SESSION_SECS, 0).is_ok(), "exactly the cap");
    }

    #[test]
    fn still_accepts_the_old_fixed_sessions() {
        assert!(sched(12_600, 0).is_ok(), "3.5h half-day session");
        assert!(sched(23_400, 0).is_ok(), "6.5h regular session");
    }

    #[test]
    fn rejects_sessions_over_the_cap() {
        assert!(sched(MAX_SESSION_SECS + 1, 0).is_err());
    }

    #[test]
    fn requires_exact_30m_mint_to_trade_lead() {
        assert!(validate_schedule(0, 1799, 1799 + 23_400, 0).is_err());
        assert!(validate_schedule(0, 1801, 1801 + 23_400, 0).is_err());
    }

    #[test]
    fn requires_mint_lt_trade_lt_close() {
        assert!(validate_schedule(1800, 1800, 100_000, 0).is_err(), "mint == trade");
        assert!(validate_schedule(0, 1800, 1800, 0).is_err(), "trade == close");
        assert!(validate_schedule(0, 1800, 1000, 0).is_err(), "close < trade");
    }

    #[test]
    fn enforces_add_strike_lead() {
        let close = 1800 + 23_400;
        assert!(validate_schedule(0, 1800, close, close - 1800).is_ok(), "exactly close-30m");
        assert!(validate_schedule(0, 1800, close, close - 1799).is_err(), "inside the 30m lead");
    }
}
