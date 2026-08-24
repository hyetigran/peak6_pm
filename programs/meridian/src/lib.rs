//! Meridian — same-day MAG7 binary Outcome Markets on Solana (V1, devnet).
//!
//! Built on the M0-validated OpenBook V2 v1.7 integration and pair-collateral
//! model. Protocol-fee-free (ADR-0001/0007); one Yes/USDC OpenBook Venue
//! Market per Outcome Market; settlement from one shared Settlement Record per
//! ticker and Trading Day.

use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod openbook;
pub mod state;
pub mod instructions;

use instructions::*;
use instructions::rotate_role::Role;
use openbook::{PlaceOrderArgs, PlaceTakeOrderArgs};

declare_id!("HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD");

#[program]
pub mod meridian {
    use super::*;

    /// One-time global Config with roles, pinned OpenBook identity, quote-mint
    /// pin, and settlement-quality bounds.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        operator: Pubkey,
        pause_authority: Pubkey,
        override_authority: Pubkey,
        supported_ticker_mask: u8,
        openbook_deployment_slot: u64,
        openbook_executable_sha256: [u8; 32],
        openbook_upgrade_authority: Pubkey,
        min_samples: u8,
        max_stale_slots: u64,
        max_price_band_bps: u16,
    ) -> Result<()> {
        initialize_config::handler(
            ctx, operator, pause_authority, override_authority, supported_ticker_mask,
            openbook_deployment_slot, openbook_executable_sha256, openbook_upgrade_authority,
            min_samples, max_stale_slots, max_price_band_bps,
        )
    }

    /// Governance proposes a role rotation; the incoming key must accept.
    pub fn propose_role(ctx: Context<ProposeRole>, role: Role, pending: Pubkey) -> Result<()> {
        rotate_role::propose(ctx, role, pending)
    }
    pub fn accept_role(ctx: Context<AcceptRole>, role: Role) -> Result<()> {
        rotate_role::accept(ctx, role)
    }

    /// Pause Authority toggles the global pause.
    pub fn set_global_pause(ctx: Context<SetGlobalPause>, paused: bool) -> Result<()> {
        set_global_pause::handler(ctx, paused)
    }

    /// Create an Outcome Market (first-of-day or Add Strike share this path);
    /// creates the Yes/No Pair and binds the shared Settlement Record.
    #[allow(clippy::too_many_arguments)]
    pub fn create_outcome_market(
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
        create_outcome_market::handler(
            ctx, ticker_id, trading_day, strike_1e6, prior_official_close_1e6,
            mint_open_ts, trade_open_ts, close_ts, metadata_manifest_sha256,
            normal_settlement_delay_secs, override_delay_secs,
        )
    }

    /// Abandon a Created/Active market while untouched (ADR-0011).
    pub fn abandon_market(ctx: Context<AbandonMarket>) -> Result<()> {
        abandon_market::handler(ctx)
    }

    /// Publish permanent Metaplex Token Metadata for the Yes/No Pair mints.
    pub fn publish_metadata(
        ctx: Context<PublishMetadata>,
        yes_name: String,
        yes_symbol: String,
        no_name: String,
        no_symbol: String,
        uri: String,
    ) -> Result<()> {
        publish_metadata::handler(ctx, yes_name, yes_symbol, no_name, no_symbol, uri)
    }

    /// Attach the single Yes/USDC OpenBook Venue Market (Created -> Active).
    pub fn create_venue_market(ctx: Context<CreateVenueMarket>, name: String, time_expiry: i64) -> Result<()> {
        create_venue_market::handler(ctx, name, time_expiry)
    }

    /// Mint a Pair: q USDC -> q Yes + q No.
    pub fn mint_pair(ctx: Context<MintPair>, q_atoms: u64) -> Result<()> {
        mint_pair::handler(ctx, q_atoms)
    }

    /// Direct Pair Redemption: burn q Yes + q No -> q USDC.
    pub fn redeem_pair_direct(ctx: Context<RedeemPairDirect>, q_atoms: u64) -> Result<()> {
        mint_pair::redeem_pair_direct(ctx, q_atoms)
    }

    /// PostOnly limit order (Directional Intent).
    pub fn place_limit_order(ctx: Context<PlaceLimitOrder>, args: PlaceOrderArgs) -> Result<()> {
        place_limit_order::handler(ctx, args)
    }

    /// Market Action (take) — full-fill-or-revert.
    pub fn place_take_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, PlaceTakeOrder<'info>>,
        args: PlaceTakeOrderArgs,
    ) -> Result<()> {
        place_take_order::handler(ctx, args)
    }

    /// Sell No via market-assisted Pair Redemption (redeem_no_via_market).
    pub fn redeem_no_via_market<'info>(
        ctx: Context<'_, '_, 'info, 'info, RedeemNoViaMarket<'info>>,
        q_lots: i64,
        price_lots: i64,
    ) -> Result<()> {
        redeem_no::handler(ctx, q_lots, price_lots)
    }

    /// Finalize the shared Settlement Record (normal, permissionless).
    pub fn finalize_settlement_normal(
        ctx: Context<FinalizeSettlementNormal>, official_close_1e6: u64, halt_status: u8,
        observed_ts: i64, delivery_slot: u64, sample_count: u8, raw_response_sha256: [u8; 32],
    ) -> Result<()> {
        finalize_settlement::finalize_normal(ctx, official_close_1e6, halt_status, observed_ts, delivery_slot, sample_count, raw_response_sha256)
    }

    /// Finalize the shared Settlement Record (manual override).
    pub fn finalize_settlement_manual(
        ctx: Context<FinalizeSettlementManual>, source_a_1e6: u64, source_b_1e6: u64,
        reason_code: u16, manifest_sha256: [u8; 32],
    ) -> Result<()> {
        finalize_settlement::finalize_manual(ctx, source_a_1e6, source_b_1e6, reason_code, manifest_sha256)
    }

    /// Settle an Outcome Market from its finalized record (derive the winner).
    pub fn settle_market(ctx: Context<SettleMarket>) -> Result<()> {
        settle_market::handler(ctx)
    }

    /// Prune a user's resting venue orders after settlement (permissionless;
    /// the market PDA signs as OpenBook `close_market_admin`). Expires the
    /// venue first if it is not already expired.
    pub fn prune_venue_orders(ctx: Context<PruneVenueOrders>, limit: u8) -> Result<()> {
        close_venue::prune_venue_orders(ctx, limit)
    }

    /// Close the expired, empty OpenBook venue of a Settled/Abandoned market
    /// and return its rent ONLY to the snapshotted Venue Rent Refund Address.
    pub fn close_venue(ctx: Context<CloseVenue>) -> Result<()> {
        close_venue::close_venue(ctx)
    }

    /// Outcome Redemption: burn winning tokens for \$1 each.
    pub fn redeem_winning(ctx: Context<RedeemWinning>, amount: u64) -> Result<()> {
        redeem_winning::handler(ctx, amount)
    }

    /// Governance registers an immutable Settlement Transport Version.
    #[allow(clippy::too_many_arguments)]
    pub fn register_transport(
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
        register_transport::handler(
            ctx, version_id, ticker_id, oracle_program_id, oracle_programdata,
            oracle_deployment_slot, oracle_executable_sha256, oracle_upgrade_authority,
            oracle_feed, oracle_job_hash, provider_id, close_method_id, activated_trading_day,
        )
    }
}
