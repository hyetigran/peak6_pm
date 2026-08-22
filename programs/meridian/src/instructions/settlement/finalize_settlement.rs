//! Finalize the shared Settlement Record once (Pending -> FinalOracle |
//! FinalManual); first valid finalization wins (ADR-0012/0023). The normal
//! path is permissionless and reads a settlement-delivery account whose
//! Official Close is validated against the frozen quality bounds; the manual
//! path requires the Override Authority and two equal evidenced values after
//! the override delay.
//!
//! LOCALNET NOTE: the delivery account is a mock feed here; on devnet it is
//! the real Pyth-adapter delivery account. The record CONTRACT is identical.

use anchor_lang::prelude::*;
use crate::constants::{CONFIG_SEED, SETTLEMENT_RECORD_SEED};
use crate::error::MeridianError;
use crate::state::{Config, HaltOrContingencyStatus, SettlementRecord, SettlementRecordState};

#[derive(Accounts)]
pub struct FinalizeSettlementNormal<'info> {
    /// Permissionless: anyone may pay to finalize a valid normal result.
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [SETTLEMENT_RECORD_SEED, &[record.ticker_id], &record.trading_day.to_le_bytes()],
        bump = record.bump,
    )]
    pub record: Account<'info, SettlementRecord>,
    /// CHECK: settlement delivery feed (harness mock on localnet / Pyth adapter on
    /// devnet). Its identity must match the record's snapshotted feed.
    #[account(address = record.oracle_feed @ MeridianError::SettlementHeaderMismatch)]
    pub delivery: UncheckedAccount<'info>,
}

/// Offsets of the normalized delivery payload within the feed account's data
/// (after the account's 8-byte header). The localnet mock feed and a devnet
/// Pyth adapter both present this layout.
mod delivery {
    pub const CLOSE_1E6: usize = 8;
    pub const SLOT: usize = 16;
    pub const OBSERVED_TS: usize = 24;
    pub const HALT: usize = 32;
    pub const SAMPLES: usize = 33;
    pub const MIN_LEN: usize = 66;
}

/// The normalized reading the delivery feed provides — named fields so the
/// close/slot/halt/samples can't be transposed on the settlement path.
struct DeliveryReading {
    official_close_1e6: u64,
    halt_status: u8,
    delivery_slot: u64,
    sample_count: u8,
    /// Oracle publish time of the reading (capture-at-close, ADR-0034).
    observed_ts: i64,
}

/// Read the delivery reading from the owner-pinned feed account's data. BOTH
/// builds read the feed — the caller's args of the same name are advisory and
/// always overridden here, so a cranker can never supply its own Official Close
/// (fail-closed, ADR-0023).
fn parse_delivery(data: &[u8]) -> Result<DeliveryReading> {
    require!(data.len() >= delivery::MIN_LEN, MeridianError::SettlementHeaderMismatch);
    let read_u64 = |o: usize| u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
    Ok(DeliveryReading {
        official_close_1e6: read_u64(delivery::CLOSE_1E6),
        halt_status: data[delivery::HALT],
        delivery_slot: read_u64(delivery::SLOT),
        sample_count: data[delivery::SAMPLES],
        observed_ts: i64::from_le_bytes(data[delivery::OBSERVED_TS..delivery::OBSERVED_TS + 8].try_into().unwrap()),
    })
}

/// Capture-at-close (ADR-0034, #26): the delivered reading must have been
/// observed AT the Official Close — not a stale pre-close tick, not a later
/// after-hours print. Strict build only; the localnet demo settles synthetic
/// closes against whatever the mock/weekend feed holds.
#[cfg(not(feature = "localnet"))]
fn check_observed_at_close(observed_ts: i64, close_ts: i64) -> Result<()> {
    use crate::constants::{OBSERVED_AFTER_CLOSE_MAX_SECS, OBSERVED_BEFORE_CLOSE_MAX_SECS};
    require!(
        observed_ts >= close_ts - OBSERVED_BEFORE_CLOSE_MAX_SECS
            && observed_ts <= close_ts + OBSERVED_AFTER_CLOSE_MAX_SECS,
        MeridianError::ObservedOutsideCloseWindow
    );
    Ok(())
}

// The `_`-prefixed args are advisory — the feed (read below) is authoritative,
// never the caller. Only raw_response_sha256 is still caller-supplied.
pub fn finalize_normal(
    ctx: Context<FinalizeSettlementNormal>,
    _official_close_1e6: u64,
    _halt_status: u8,
    _observed_ts: i64,
    _delivery_slot: u64,
    _sample_count: u8,
    raw_response_sha256: [u8; 32],
) -> Result<()> {
    // The delivery feed is pinned by address (account constraint) AND by owner:
    // it must be owned by the oracle program snapshotted in the record (the
    // harness mock on localnet, the Pyth adapter on devnet). Address alone
    // is insufficient — the owner proves it is a genuine oracle account.
    require!(
        ctx.accounts.delivery.owner == &ctx.accounts.record.oracle_program_id,
        MeridianError::WrongDeliveryOwner
    );

    // The Official Close is READ from the owner-pinned feed account, never
    // trusted from the caller — in BOTH builds. Only the writer differs (the
    // harness mock on localnet, the Pyth adapter on devnet).
    let feed = {
        let d = ctx.accounts.delivery.try_borrow_data()?;
        parse_delivery(&d[..])?
    };

    let now = Clock::get()?.unix_timestamp;
    let r = &mut ctx.accounts.record;
    require!(r.state == SettlementRecordState::Pending as u8, MeridianError::AlreadyFinalized);
    require!(now >= r.close_ts + r.normal_settlement_delay_secs as i64, MeridianError::SettlementTooEarly);
    require!(feed.official_close_1e6 > 0, MeridianError::InvalidPriorClose);
    require!(
        feed.halt_status == HaltOrContingencyStatus::NormalOfficialClose as u8
            || feed.halt_status == HaltOrContingencyStatus::OfficialCloseAfterHalt as u8
            || feed.halt_status == HaltOrContingencyStatus::OfficialContingencyClose as u8,
        MeridianError::CollateralInvariant
    );
    // quality bounds (frozen at creation): sample count and freshness
    require!(feed.sample_count >= r.min_samples, MeridianError::CollateralInvariant);
    let cur_slot = Clock::get()?.slot;
    require!(cur_slot.saturating_sub(feed.delivery_slot) <= r.max_stale_slots, MeridianError::CollateralInvariant);
    #[cfg(not(feature = "localnet"))]
    check_observed_at_close(feed.observed_ts, r.close_ts)?;

    r.state = SettlementRecordState::FinalOracle as u8;
    r.official_close_1e6 = feed.official_close_1e6;
    r.halt_or_contingency_status = feed.halt_status;
    r.is_final = 1;
    r.is_unadjusted = 1;
    r.finalized_ts = now;
    r.official_close_observed_ts = feed.observed_ts;
    r.provider_observed_ts = feed.observed_ts;
    r.raw_response_sha256 = raw_response_sha256;
    r.delivery_update_slot = feed.delivery_slot;
    r.sample_count = feed.sample_count;
    Ok(())
}

#[derive(Accounts)]
pub struct FinalizeSettlementManual<'info> {
    #[account(address = config.override_authority @ MeridianError::Unauthorized)]
    pub override_authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [SETTLEMENT_RECORD_SEED, &[record.ticker_id], &record.trading_day.to_le_bytes()],
        bump = record.bump,
    )]
    pub record: Account<'info, SettlementRecord>,
}

pub fn finalize_manual(
    ctx: Context<FinalizeSettlementManual>,
    source_a_1e6: u64,
    source_b_1e6: u64,
    reason_code: u16,
    manifest_sha256: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let r = &mut ctx.accounts.record;
    require!(r.state == SettlementRecordState::Pending as u8, MeridianError::AlreadyFinalized);
    require!(now >= r.close_ts + r.override_delay_secs as i64, MeridianError::SettlementTooEarly);
    // the program derives the outcome from evidenced PRICE; two equal values
    require!(source_a_1e6 == source_b_1e6 && source_a_1e6 > 0, MeridianError::OverrideValuesUnequal);

    r.state = SettlementRecordState::FinalManual as u8;
    r.official_close_1e6 = source_a_1e6;
    r.halt_or_contingency_status = HaltOrContingencyStatus::NormalOfficialClose as u8;
    r.is_final = 1;
    r.is_unadjusted = 1;
    r.finalized_ts = now;
    r.manual_source_a_value_1e6 = source_a_1e6;
    r.manual_source_b_value_1e6 = source_b_1e6;
    r.override_reason_code = reason_code;
    r.manual_evidence_manifest_sha256 = manifest_sha256;
    Ok(())
}

#[cfg(test)]
mod delivery_tests {
    use super::{delivery, parse_delivery};

    // Build a minimal normalized delivery payload at the pinned offsets.
    // Arg order matches DeliveryReading's field order (close, halt, slot, samples, observed).
    fn payload(close: u64, halt: u8, slot: u64, samples: u8) -> Vec<u8> {
        payload_at(close, halt, slot, samples, 0)
    }
    fn payload_at(close: u64, halt: u8, slot: u64, samples: u8, observed: i64) -> Vec<u8> {
        let mut d = vec![0u8; delivery::MIN_LEN];
        d[delivery::OBSERVED_TS..delivery::OBSERVED_TS + 8].copy_from_slice(&observed.to_le_bytes());
        d[delivery::CLOSE_1E6..delivery::CLOSE_1E6 + 8].copy_from_slice(&close.to_le_bytes());
        d[delivery::SLOT..delivery::SLOT + 8].copy_from_slice(&slot.to_le_bytes());
        d[delivery::HALT] = halt;
        d[delivery::SAMPLES] = samples;
        d
    }

    #[test]
    fn reads_the_normalized_layout() {
        let r = parse_delivery(&payload(204_590_000, 1, 12_345, 7)).unwrap();
        assert_eq!(r.official_close_1e6, 204_590_000);
        assert_eq!(r.halt_status, 1);
        assert_eq!(r.delivery_slot, 12_345);
        assert_eq!(r.sample_count, 7);
    }

    #[test]
    fn reads_observed_ts() {
        assert_eq!(parse_delivery(&payload_at(1, 1, 1, 1, 1_700_000_000)).unwrap().observed_ts, 1_700_000_000);
        assert_eq!(parse_delivery(&payload_at(1, 1, 1, 1, -5)).unwrap().observed_ts, -5);
    }

    #[test]
    fn rejects_an_undersized_account() {
        assert!(parse_delivery(&vec![0u8; delivery::MIN_LEN - 1]).is_err());
    }

    #[test]
    fn accepts_exactly_min_len() {
        assert!(parse_delivery(&payload(1, 0, 0, 0)).is_ok());
    }
}

#[cfg(all(test, not(feature = "localnet")))]
mod capture_at_close_tests {
    use super::check_observed_at_close;
    use crate::constants::{OBSERVED_AFTER_CLOSE_MAX_SECS, OBSERVED_BEFORE_CLOSE_MAX_SECS};
    const CLOSE: i64 = 1_700_000_000;

    #[test]
    fn accepts_the_close_tick_and_the_window_edges() {
        assert!(check_observed_at_close(CLOSE, CLOSE).is_ok());
        assert!(check_observed_at_close(CLOSE - OBSERVED_BEFORE_CLOSE_MAX_SECS, CLOSE).is_ok());
        assert!(check_observed_at_close(CLOSE + OBSERVED_AFTER_CLOSE_MAX_SECS, CLOSE).is_ok());
    }

    #[test]
    fn rejects_a_stale_pre_close_tick() {
        assert!(check_observed_at_close(CLOSE - OBSERVED_BEFORE_CLOSE_MAX_SECS - 1, CLOSE).is_err());
        assert!(check_observed_at_close(CLOSE - 86_400, CLOSE).is_err()); // yesterday's close
        assert!(check_observed_at_close(0, CLOSE).is_err()); // unset
    }

    #[test]
    fn rejects_a_late_after_hours_print() {
        assert!(check_observed_at_close(CLOSE + OBSERVED_AFTER_CLOSE_MAX_SECS + 1, CLOSE).is_err());
        assert!(check_observed_at_close(CLOSE + 1200, CLOSE).is_err()); // "latest" at settlement time
    }
}
