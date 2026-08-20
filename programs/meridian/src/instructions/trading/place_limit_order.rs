//! PostOnly limit order (one of the four Directional Intents). The market PDA
//! signs as `open_orders_admin`; V1 limits are PostOnly with AbortTransaction
//! self-trade. The venue returns an Option<u128> order id in CPI return data;
//! a None (PostOnly would cross, or past expiry) fails closed (G10).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{get_return_data, invoke_signed};
use crate::constants::{CONFIG_SEED, OUTCOME_MARKET_SEED};
use crate::error::MeridianError;
use crate::openbook::*;
use crate::state::{Config, OutcomeMarket};
use super::require_tradeable;

#[derive(Accounts)]
pub struct PlaceLimitOrder<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [OUTCOME_MARKET_SEED, &[market.ticker_id], &market.trading_day.to_le_bytes(), &market.strike_1e6.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, OutcomeMarket>>,
    /// CHECK: user's OpenOrders account
    #[account(mut)] pub open_orders_account: UncheckedAccount<'info>,
    /// CHECK: user's token account (quote for bids, base for asks)
    #[account(mut)] pub user_token_account: UncheckedAccount<'info>,
    /// CHECK: == market.openbook_market
    #[account(mut, address = market.openbook_market @ MeridianError::VenueNotAttached)]
    pub openbook_market: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, address = market.bids)] pub bids: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, address = market.asks)] pub asks: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, address = market.event_heap)] pub event_heap: UncheckedAccount<'info>,
    /// CHECK: the venue base or quote vault
    #[account(mut)] pub market_vault: UncheckedAccount<'info>,
    /// CHECK: pinned OpenBook program
    #[account(executable, address = config.openbook_program_id @ MeridianError::WrongOpenbookProgram)]
    pub openbook_program: UncheckedAccount<'info>,
    /// CHECK: token program
    pub token_program: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<PlaceLimitOrder>, args: PlaceOrderArgs) -> Result<()> {
    require!(args.order_type == PlaceOrderType::PostOnly, MeridianError::InvalidLimitOrder);
    require!(args.self_trade_behavior == SelfTradeBehavior::AbortTransaction, MeridianError::InvalidLimitOrder);
    let now = Clock::get()?.unix_timestamp;
    require_tradeable(&ctx.accounts.market, now)?;

    let ob = ctx.accounts.openbook_program.key();
    let m = &ctx.accounts.market;
    let metas = vec![
        AccountMeta::new_readonly(ctx.accounts.user.key(), true),
        AccountMeta::new(ctx.accounts.open_orders_account.key(), false),
        AccountMeta::new_readonly(m.key(), true), // open_orders_admin = market PDA
        AccountMeta::new(ctx.accounts.user_token_account.key(), false),
        AccountMeta::new(ctx.accounts.openbook_market.key(), false),
        AccountMeta::new(ctx.accounts.bids.key(), false),
        AccountMeta::new(ctx.accounts.asks.key(), false),
        AccountMeta::new(ctx.accounts.event_heap.key(), false),
        AccountMeta::new(ctx.accounts.market_vault.key(), false),
        AccountMeta::new_readonly(ob, false),
        AccountMeta::new_readonly(ob, false),
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
    ];
    let ix = Instruction { program_id: ob, accounts: metas, data: ix_data(DISC_PLACE_ORDER, &args) };
    let seeds: &[&[u8]] = &[
        OUTCOME_MARKET_SEED, &[m.ticker_id], &m.trading_day.to_le_bytes(),
        &m.strike_1e6.to_le_bytes(), &[m.bump],
    ];
    invoke_signed(&ix, &[
        ctx.accounts.user.to_account_info(),
        ctx.accounts.open_orders_account.to_account_info(),
        ctx.accounts.market.to_account_info(),
        ctx.accounts.user_token_account.to_account_info(),
        ctx.accounts.openbook_market.to_account_info(),
        ctx.accounts.bids.to_account_info(),
        ctx.accounts.asks.to_account_info(),
        ctx.accounts.event_heap.to_account_info(),
        ctx.accounts.market_vault.to_account_info(),
        ctx.accounts.openbook_program.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
    ], &[seeds])?;

    // fail closed if nothing was posted (G10 silent no-op)
    let (from, data) = get_return_data().ok_or(MeridianError::OrderNotPosted)?;
    require!(from == ob, MeridianError::WrongOpenbookProgram);
    require!(data.first() == Some(&1) && data.len() == 17, MeridianError::OrderNotPosted);

    ctx.accounts.market.activity_started = true;
    Ok(())
}
