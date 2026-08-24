//! Venue closure and rent recycling (ARCHITECTURE §"close_venue", ADR-0027).
//!
//! The OutcomeMarket PDA is the OpenBook `close_market_admin` (set at
//! `create_venue_market`, never mutable), so only this program can expire,
//! prune, or close a venue. Both wrappers are permissionless: every check that
//! matters is proven on-chain, and the only rent destination `close_venue`
//! accepts is the `venue_rent_refund_address` snapshotted at creation.
//!
//! Order of operations after `settle_market` (the keeper drives this):
//!   1. `prune_venue_orders` per OpenOrders account with resting orders — the
//!      venue is expired first (one-way `set_market_expired`, ADR-0018) so the
//!      pinned `prune_orders` accepts; cancelled orders credit the owner's
//!      OpenOrders position, which the owner withdraws with OpenBook
//!      `settle_funds` (owner-signed, unchanged recovery path).
//!   2. `close_venue` once `base_deposit_total == quote_deposit_total == 0`:
//!      no user funds can be stranded because OpenBook `close_market` would
//!      delete the Market account `settle_funds` needs. OpenBook itself then
//!      re-proves expiry + empty book + empty EventHeap before closing.
//!
//! Not reclaimable (ARCHITECTURE L2454): the two venue vault ATAs, the
//! Yes/No mints, the SettlementRecord, and immutable metadata.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed};
use crate::constants::{OUTCOME_MARKET_SEED, CONFIG_SEED};
use crate::error::MeridianError;
use crate::events::VenueClosed;
use crate::openbook::*;
use crate::state::{Config, MarketState, OutcomeMarket};

/// Pinned v1.7 predicate (`Market::is_expired`): expired iff
/// `time_expiry != 0 && time_expiry < now` (`-1` is the one-way fuse).
fn venue_expired(market_data: &[u8], now: i64) -> bool {
    let te = read_i64(market_data, MARKET_TIME_EXPIRY_OFFSET);
    te != 0 && te < now
}

/// Only markets that can never trade again may have their venue torn down.
fn require_terminal(m: &OutcomeMarket) -> Result<()> {
    require!(
        m.state == MarketState::Settled as u8 || m.state == MarketState::Abandoned as u8,
        MeridianError::WrongMarketState
    );
    require!(m.has_venue(), MeridianError::VenueNotAttached);
    require!(m.venue_closed_ts == 0, MeridianError::VenueAlreadyClosed);
    Ok(())
}

fn market_seeds(m: &OutcomeMarket) -> [Vec<u8>; 5] {
    [
        OUTCOME_MARKET_SEED.to_vec(),
        vec![m.ticker_id],
        m.trading_day.to_le_bytes().to_vec(),
        m.strike_1e6.to_le_bytes().to_vec(),
        vec![m.bump],
    ]
}

/// `set_market_expired` signed by the market PDA, skipped when the venue is
/// already expired (the pin rejects a re-expire with `MarketHasExpired`).
fn ensure_expired<'info>(
    market: &Box<Account<'info, OutcomeMarket>>,
    openbook_market: &AccountInfo<'info>,
    openbook_program: &AccountInfo<'info>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let already = {
        let data = openbook_market.try_borrow_data()?;
        require!(data.len() >= MARKET_ACCOUNT_LEN, MeridianError::VenueAccountMismatch);
        venue_expired(&data, now)
    };
    if already {
        return Ok(());
    }
    let seeds = market_seeds(market);
    let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    let ix = Instruction {
        program_id: openbook_program.key(),
        accounts: vec![
            AccountMeta::new_readonly(market.key(), true),
            AccountMeta::new(openbook_market.key(), false),
        ],
        data: DISC_SET_MARKET_EXPIRED.to_vec(),
    };
    invoke_signed(
        &ix,
        &[market.to_account_info(), openbook_market.clone(), openbook_program.clone()],
        &[&seed_refs],
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct PruneVenueOrders<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [OUTCOME_MARKET_SEED, &[market.ticker_id], &market.trading_day.to_le_bytes(), &market.strike_1e6.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, OutcomeMarket>>,
    /// CHECK: pinned to `market.openbook_market`; OpenBook validates the rest.
    #[account(mut, address = market.openbook_market @ MeridianError::VenueAccountMismatch)]
    pub openbook_market: UncheckedAccount<'info>,
    /// CHECK: OpenBook validates ownership and its `market` binding.
    #[account(mut)]
    pub open_orders_account: UncheckedAccount<'info>,
    /// CHECK: pinned to `market.bids`.
    #[account(mut, address = market.bids @ MeridianError::VenueAccountMismatch)]
    pub bids: UncheckedAccount<'info>,
    /// CHECK: pinned to `market.asks`.
    #[account(mut, address = market.asks @ MeridianError::VenueAccountMismatch)]
    pub asks: UncheckedAccount<'info>,
    /// CHECK: pinned OpenBook program
    #[account(executable, address = config.openbook_program_id @ MeridianError::WrongOpenbookProgram)]
    pub openbook_program: UncheckedAccount<'info>,
}

pub fn prune_venue_orders(ctx: Context<PruneVenueOrders>, limit: u8) -> Result<()> {
    let m = &ctx.accounts.market;
    require_terminal(m)?;
    ensure_expired(
        m,
        &ctx.accounts.openbook_market.to_account_info(),
        &ctx.accounts.openbook_program.to_account_info(),
    )?;

    let seeds = market_seeds(m);
    let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    let mut data = DISC_PRUNE_ORDERS.to_vec();
    data.push(limit);
    let ix = Instruction {
        program_id: ctx.accounts.openbook_program.key(),
        accounts: vec![
            AccountMeta::new_readonly(m.key(), true),
            AccountMeta::new(ctx.accounts.open_orders_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.openbook_market.key(), false),
            AccountMeta::new(ctx.accounts.bids.key(), false),
            AccountMeta::new(ctx.accounts.asks.key(), false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            m.to_account_info(),
            ctx.accounts.open_orders_account.to_account_info(),
            ctx.accounts.openbook_market.to_account_info(),
            ctx.accounts.bids.to_account_info(),
            ctx.accounts.asks.to_account_info(),
            ctx.accounts.openbook_program.to_account_info(),
        ],
        &[&seed_refs],
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct CloseVenue<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [OUTCOME_MARKET_SEED, &[market.ticker_id], &market.trading_day.to_le_bytes(), &market.strike_1e6.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, OutcomeMarket>>,
    /// CHECK: pinned to `market.openbook_market`.
    #[account(mut, address = market.openbook_market @ MeridianError::VenueAccountMismatch)]
    pub openbook_market: UncheckedAccount<'info>,
    /// CHECK: pinned to `market.bids`.
    #[account(mut, address = market.bids @ MeridianError::VenueAccountMismatch)]
    pub bids: UncheckedAccount<'info>,
    /// CHECK: pinned to `market.asks`.
    #[account(mut, address = market.asks @ MeridianError::VenueAccountMismatch)]
    pub asks: UncheckedAccount<'info>,
    /// CHECK: pinned to `market.event_heap`.
    #[account(mut, address = market.event_heap @ MeridianError::VenueAccountMismatch)]
    pub event_heap: UncheckedAccount<'info>,
    /// CHECK: rent may go ONLY to the snapshotted Venue Rent Refund Address.
    #[account(mut, address = market.venue_rent_refund_address @ MeridianError::WrongRefundDestination)]
    pub sol_destination: UncheckedAccount<'info>,
    /// CHECK: pinned to the token program the Config was initialized with.
    #[account(address = config.token_program @ MeridianError::CollateralInvariant)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: pinned OpenBook program
    #[account(executable, address = config.openbook_program_id @ MeridianError::WrongOpenbookProgram)]
    pub openbook_program: UncheckedAccount<'info>,
}

pub fn close_venue(ctx: Context<CloseVenue>) -> Result<()> {
    let m = &ctx.accounts.market;
    require_terminal(m)?;

    // No user value may be stranded: OpenBook `close_market` deletes the
    // Market account that `settle_funds` needs, so both deposit totals must
    // already be zero (every OpenOrders position withdrawn).
    {
        let data = ctx.accounts.openbook_market.try_borrow_data()?;
        require!(data.len() >= MARKET_ACCOUNT_LEN, MeridianError::VenueAccountMismatch);
        let base = read_u64(&data, MARKET_BASE_DEPOSIT_TOTAL_OFFSET);
        let quote = read_u64(&data, MARKET_QUOTE_DEPOSIT_TOTAL_OFFSET);
        require!(base == 0 && quote == 0, MeridianError::VenueNotEmpty);
    }

    ensure_expired(
        m,
        &ctx.accounts.openbook_market.to_account_info(),
        &ctx.accounts.openbook_program.to_account_info(),
    )?;

    let reclaim = ctx.accounts.openbook_market.lamports()
        + ctx.accounts.bids.lamports()
        + ctx.accounts.asks.lamports()
        + ctx.accounts.event_heap.lamports();

    let seeds = market_seeds(m);
    let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
    let ix = Instruction {
        program_id: ctx.accounts.openbook_program.key(),
        accounts: vec![
            AccountMeta::new_readonly(m.key(), true),
            AccountMeta::new(ctx.accounts.openbook_market.key(), false),
            AccountMeta::new(ctx.accounts.bids.key(), false),
            AccountMeta::new(ctx.accounts.asks.key(), false),
            AccountMeta::new(ctx.accounts.event_heap.key(), false),
            AccountMeta::new(ctx.accounts.sol_destination.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        ],
        data: DISC_CLOSE_MARKET.to_vec(),
    };
    invoke_signed(
        &ix,
        &[
            m.to_account_info(),
            ctx.accounts.openbook_market.to_account_info(),
            ctx.accounts.bids.to_account_info(),
            ctx.accounts.asks.to_account_info(),
            ctx.accounts.event_heap.to_account_info(),
            ctx.accounts.sol_destination.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.openbook_program.to_account_info(),
        ],
        &[&seed_refs],
    )?;

    let m = &mut ctx.accounts.market;
    m.venue_closed_ts = Clock::get()?.unix_timestamp;
    emit!(VenueClosed {
        market: m.key(),
        openbook_market: m.openbook_market,
        refund_address: m.venue_rent_refund_address,
        lamports_reclaimed: reclaim,
    });
    Ok(())
}
