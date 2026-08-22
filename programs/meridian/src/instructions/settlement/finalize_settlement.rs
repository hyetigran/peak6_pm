//! Finalize the shared Settlement Record once (Pending -> FinalOracle |
//! FinalManual); first valid finalization wins (ADR-0012/0023). The normal
//! path is permissionless and reads a settlement-delivery account whose
//! Official Close is validated against the frozen quality bounds; the manual
//! path requires the Override Authority and two equal evidenced values after
//! the override delay.
//!
//! LOCALNET NOTE: the delivery account is a mock feed here; on devnet it is
//! the real Switchboard On-Demand feed. The record CONTRACT is identical.

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
    /// CHECK: settlement delivery feed (mock on localnet / Switchboard on
    /// devnet). Its identity must match the record's snapshotted feed.
    #[account(address = record.switchboard_feed @ MeridianError::SettlementHeaderMismatch)]
    pub delivery: UncheckedAccount<'info>,
}

/// Offsets of the normalized delivery payload within the feed account's data
/// (after the account's 8-byte header). The localnet mock feed and a devnet
/// Switchboard normalizer both present this layout.
mod delivery {
    pub const CLOSE_1E6: usize = 8;
    pub const SLOT: usize = 16;
    pub const HALT: usize = 32;
    pub const SAMPLES: usize = 33;
    pub const MIN_LEN: usize = 66;
}

/// Read (official_close_1e6, halt_status, delivery_slot, sample_count) from the
/// owner-pinned feed account's data. BOTH builds read the feed — the caller's
/// args of the same name are advisory and always overridden here, so a cranker
/// can never supply its own Official Close (fail-closed, ADR-0023).
fn parse_delivery(data: &[u8]) -> Result<(u64, u8, u64, u8)> {
    require!(data.len() >= delivery::MIN_LEN, MeridianError::SettlementHeaderMismatch);
    let read_u64 = |o: usize| u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
    Ok((read_u64(delivery::CLOSE_1E6), data[delivery::HALT], read_u64(delivery::SLOT), data[delivery::SAMPLES]))
}

// The close/slot/halt/samples args are advisory — always overridden by the
// feed read below — so they are unused in both builds.
#[allow(unused_variables)]
pub fn finalize_normal(
    ctx: Context<FinalizeSettlementNormal>,
    official_close_1e6: u64,
    halt_status: u8,
    observed_ts: i64,
    delivery_slot: u64,
    sample_count: u8,
    raw_response_sha256: [u8; 32],
) -> Result<()> {
    // The delivery feed is pinned by address (account constraint) AND by owner:
    // it must be owned by the oracle program snapshotted in the record (the
    // harness mock on localnet, Switchboard On-Demand on devnet). Address alone
    // is insufficient — the owner proves it is a genuine oracle account.
    require!(
        ctx.accounts.delivery.owner == &ctx.accounts.record.switchboard_program_id,
        MeridianError::WrongDeliveryOwner
    );

    // The Official Close is READ from the owner-pinned feed account, never
    // trusted from the caller — in BOTH builds. Only the writer differs (the
    // harness mock on localnet, a Switchboard normalizer on devnet).
    let (official_close_1e6, halt_status, delivery_slot, sample_count) = {
        let d = ctx.accounts.delivery.try_borrow_data()?;
        parse_delivery(&d[..])?
    };

    let now = Clock::get()?.unix_timestamp;
    let r = &mut ctx.accounts.record;
    require!(r.state == SettlementRecordState::Pending as u8, MeridianError::AlreadyFinalized);
    require!(now >= r.close_ts + r.normal_settlement_delay_secs as i64, MeridianError::SettlementTooEarly);
    require!(official_close_1e6 > 0, MeridianError::InvalidPriorClose);
    require!(
        halt_status == HaltOrContingencyStatus::NormalOfficialClose as u8
            || halt_status == HaltOrContingencyStatus::OfficialCloseAfterHalt as u8
            || halt_status == HaltOrContingencyStatus::OfficialContingencyClose as u8,
        MeridianError::CollateralInvariant
    );
    // quality bounds (frozen at creation): sample count and freshness
    require!(sample_count >= r.min_samples, MeridianError::CollateralInvariant);
    let cur_slot = Clock::get()?.slot;
    require!(cur_slot.saturating_sub(delivery_slot) <= r.max_stale_slots, MeridianError::CollateralInvariant);

    r.state = SettlementRecordState::FinalOracle as u8;
    r.official_close_1e6 = official_close_1e6;
    r.halt_or_contingency_status = halt_status;
    r.is_final = 1;
    r.is_unadjusted = 1;
    r.finalized_ts = now;
    r.official_close_observed_ts = observed_ts;
    r.provider_observed_ts = observed_ts;
    r.raw_response_sha256 = raw_response_sha256;
    r.delivery_update_slot = delivery_slot;
    r.sample_count = sample_count;
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
    fn payload(close: u64, slot: u64, halt: u8, samples: u8) -> Vec<u8> {
        let mut d = vec![0u8; delivery::MIN_LEN];
        d[delivery::CLOSE_1E6..delivery::CLOSE_1E6 + 8].copy_from_slice(&close.to_le_bytes());
        d[delivery::SLOT..delivery::SLOT + 8].copy_from_slice(&slot.to_le_bytes());
        d[delivery::HALT] = halt;
        d[delivery::SAMPLES] = samples;
        d
    }

    #[test]
    fn reads_the_normalized_layout() {
        let (close, halt, slot, samples) = parse_delivery(&payload(204_590_000, 12_345, 1, 7)).unwrap();
        assert_eq!(close, 204_590_000);
        assert_eq!(halt, 1);
        assert_eq!(slot, 12_345);
        assert_eq!(samples, 7);
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
