//! Meridian oracle adapter (Pyth).
//!
//! Reads a verified Pyth `PriceUpdateV2` and writes the **normalized delivery
//! layout** Meridian's `finalize_settlement` reads (`official_close_1e6@8,
//! delivery_slot@16, observed_ts@24, halt_status@32, sample_count@33`). The
//! adapter OWNS the delivery account, so Meridian's owner-pin
//! (`delivery.owner == record.switchboard_program_id`) points at THIS program;
//! `register_transport` snapshots this program id + the delivery account.
//!
//! This is the swap unit (ADR-0017 versioned transports): swapping oracles is a
//! new adapter + a new transport version — Meridian never changes. Pyth carries
//! no "official close" / halt semantics, so `halt_status` is set to
//! NormalOfficialClose; this adapter feeds the SYNTHETIC devnet demo
//! (ADR-0028), not the ADR-0021 NOCP proof (that's the Switchboard track).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};

declare_id!("Egc4ykuRJaDz7VfWS9EB9U2hsP2aU9repCCk8XGnk7w4");

const NORMAL_OFFICIAL_CLOSE: u8 = 1; // mirrors meridian HaltOrContingencyStatus
const DELIVERY_SEED: &[u8] = b"delivery"; // &[u8] so PDA seeds unify

#[error_code]
pub enum PythAdapterError {
    #[msg("Pyth price must be positive")]
    NonPositivePrice,
    #[msg("price scaling overflowed u64")]
    ScaleOverflow,
}

#[program]
pub mod pyth_adapter {
    use super::*;

    /// Read the pinned Pyth feed and write the per-ticker delivery account.
    /// `feed_id_hex` is the Pyth feed id (e.g. AAPL); `max_age_secs` bounds
    /// staleness at read time (Meridian re-checks freshness by slot). The price
    /// is READ from the Pyth account, never a caller arg. The delivery account is
    /// per-ticker (stable address, overwritten each settlement) to match the
    /// harness mock feed and the single feed a Meridian `FeedVersion` pins.
    pub fn crank(
        ctx: Context<Crank>,
        feed_id_hex: String,
        max_age_secs: u64,
        _ticker_id: u8,
    ) -> Result<()> {
        let update = &ctx.accounts.price_update;
        let feed_id = get_feed_id_from_hex(&feed_id_hex)?;
        let price = update.get_price_no_older_than(&Clock::get()?, max_age_secs, &feed_id)?;

        let d = &mut ctx.accounts.delivery;
        d.official_close_1e6 = scale_to_1e6(price.price, price.exponent)?;
        d.delivery_slot = update.posted_slot;
        d.observed_ts = price.publish_time;
        d.halt_status = NORMAL_OFFICIAL_CLOSE;
        d.sample_count = verification_samples(update);
        // A genuine sha256 digest of the raw reading (feed + price + slot + time)
        // — off-chain provenance/audit; Meridian reads this field from the caller
        // arg, not the delivery account, so it is inert on-chain.
        d.raw_response_sha256 = hashv(&[
            &feed_id,
            &price.price.to_le_bytes(),
            &update.posted_slot.to_le_bytes(),
            &price.publish_time.to_le_bytes(),
        ])
        .to_bytes();
        Ok(())
    }
}

/// Convert a Pyth price (`price * 10^expo` USD) to `official_close_1e6`
/// (USD scaled by 1e6): `price * 10^(expo + 6)`, rounded half-up when scaling
/// down. Pure and unit-tested — the one place a decimal mistake would misprice
/// settlement.
pub fn scale_to_1e6(price: i64, expo: i32) -> Result<u64> {
    require!(price > 0, PythAdapterError::NonPositivePrice);
    let price = price as u128;
    let shift = expo + 6;
    let scaled: u128 = if shift >= 0 {
        let mul = 10u128.checked_pow(shift as u32).ok_or(PythAdapterError::ScaleOverflow)?;
        price.checked_mul(mul).ok_or(PythAdapterError::ScaleOverflow)?
    } else {
        let div = 10u128.checked_pow((-shift) as u32).ok_or(PythAdapterError::ScaleOverflow)?;
        (price + div / 2) / div // round half-up
    };
    u64::try_from(scaled).map_err(|_| PythAdapterError::ScaleOverflow.into())
}

/// How many oracle signatures verified this update -> Meridian's sample_count
/// (`>= min_samples`). Full verification reports the guardian quorum.
fn verification_samples(update: &PriceUpdateV2) -> u8 {
    use pyth_solana_receiver_sdk::price_update::VerificationLevel;
    match update.verification_level {
        VerificationLevel::Partial { num_signatures } => num_signatures,
        VerificationLevel::Full => u8::MAX,
    }
}

#[derive(Accounts)]
#[instruction(feed_id_hex: String, max_age_secs: u64, ticker_id: u8)]
pub struct Crank<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    /// Verified Pyth price update (owned by the Pyth receiver program).
    pub price_update: Account<'info, PriceUpdateV2>,
    /// The per-ticker delivery account this adapter owns and Meridian reads. Its
    /// stable, deterministic address is what `register_transport` pins once as
    /// the record's `switchboard_feed`; each settlement overwrites it in place
    /// (same model as the harness mock feed).
    #[account(
        init_if_needed, payer = cranker, space = 8 + DeliveryFeed::INIT_SPACE,
        seeds = [DELIVERY_SEED, &[ticker_id]], bump,
    )]
    pub delivery: Account<'info, DeliveryFeed>,
    pub system_program: Program<'info, System>,
}

/// Byte-identical to the meridian/harness delivery layout: official_close_1e6@8,
/// delivery_slot@16, observed_ts@24, halt_status@32, sample_count@33, len 66.
#[account]
#[derive(InitSpace)]
pub struct DeliveryFeed {
    pub official_close_1e6: u64,
    pub delivery_slot: u64,
    pub observed_ts: i64,
    pub halt_status: u8,
    pub sample_count: u8,
    pub raw_response_sha256: [u8; 32],
}

#[cfg(test)]
mod tests {
    use super::scale_to_1e6;

    #[test]
    fn scales_expo_minus_8_to_1e6() {
        // AAPL $204.59 as Pyth price 20_459_000_000 e-8 -> 204_590_000 (×1e6)
        assert_eq!(scale_to_1e6(20_459_000_000, -8).unwrap(), 204_590_000);
    }

    #[test]
    fn scales_expo_minus_5_up() {
        // $204.59 as 20_459_000 e-5 -> shift +1 -> 204_590_000
        assert_eq!(scale_to_1e6(20_459_000, -5).unwrap(), 204_590_000);
    }

    #[test]
    fn scales_expo_minus_2_equals_1e6_shift4() {
        // $204.59 as 20_459 e-2 -> shift +4 -> 204_590_000
        assert_eq!(scale_to_1e6(20_459, -2).unwrap(), 204_590_000);
    }

    #[test]
    fn rounds_half_up_when_scaling_down() {
        // 1 e-7 -> shift -1 -> (1 + 5)/10 = 0 ; 5 e-7 -> (5+5)/10 = 1
        assert_eq!(scale_to_1e6(4, -7).unwrap(), 0);
        assert_eq!(scale_to_1e6(5, -7).unwrap(), 1);
    }

    #[test]
    fn rejects_non_positive_price() {
        assert!(scale_to_1e6(0, -8).is_err());
        assert!(scale_to_1e6(-100, -8).is_err());
    }
}
