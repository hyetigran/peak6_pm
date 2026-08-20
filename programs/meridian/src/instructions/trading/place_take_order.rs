//! Market Action (take) — full-fill-or-revert (G4). The user's outcome-token
//! account must change by exactly `max_base_lots * BASE_LOT_SIZE`; any partial
//! fill fails the postcondition and reverts. Market PDA signs as
//! open_orders_admin; the USER is penalty_payer (never collateral).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use crate::constants::{BASE_LOT_SIZE, CONFIG_SEED, OUTCOME_MARKET_SEED};
use crate::error::MeridianError;
use crate::openbook::*;
use crate::state::{Config, OutcomeMarket};
use super::require_tradeable;

#[derive(Accounts)]
pub struct PlaceTakeOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [OUTCOME_MARKET_SEED, &[market.ticker_id], &market.trading_day.to_le_bytes(), &market.strike_1e6.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, OutcomeMarket>>,
    /// CHECK: == market.openbook_market
    #[account(mut, address = market.openbook_market @ MeridianError::VenueNotAttached)]
    pub openbook_market: UncheckedAccount<'info>,
    /// CHECK: OpenBook ["Market", market] authority
    #[account(address = market.openbook_market_authority)]
    pub openbook_market_authority: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, address = market.bids)] pub bids: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, address = market.asks)] pub asks: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, address = market.openbook_base_vault)] pub market_base_vault: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, address = market.openbook_quote_vault)] pub market_quote_vault: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut, address = market.event_heap)] pub event_heap: UncheckedAccount<'info>,
    /// CHECK: user base (Yes) token account — the full-fill target
    #[account(mut)] pub user_base_account: UncheckedAccount<'info>,
    /// CHECK: user quote account
    #[account(mut)] pub user_quote_account: UncheckedAccount<'info>,
    /// CHECK: pinned OpenBook program
    #[account(executable, address = config.openbook_program_id @ MeridianError::WrongOpenbookProgram)]
    pub openbook_program: UncheckedAccount<'info>,
    /// CHECK: token program
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, PlaceTakeOrder<'info>>,
    args: PlaceTakeOrderArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require_tradeable(&ctx.accounts.market, now)?;
    require!(args.max_base_lots > 0, MeridianError::PartialFillReverted);
    let expected = (args.max_base_lots as u64)
        .checked_mul(BASE_LOT_SIZE as u64).ok_or(MeridianError::Overflow)?;
    let base_before = read_u64(&ctx.accounts.user_base_account.try_borrow_data()?, TOKEN_AMOUNT_OFFSET);

    let ob = ctx.accounts.openbook_program.key();
    let m = &ctx.accounts.market;
    let mut metas = vec![
        AccountMeta::new(ctx.accounts.user.key(), true),
        AccountMeta::new(ctx.accounts.user.key(), true), // penalty_payer = user
        AccountMeta::new(ctx.accounts.openbook_market.key(), false),
        AccountMeta::new_readonly(ctx.accounts.openbook_market_authority.key(), false),
        AccountMeta::new(ctx.accounts.bids.key(), false),
        AccountMeta::new(ctx.accounts.asks.key(), false),
        AccountMeta::new(ctx.accounts.market_base_vault.key(), false),
        AccountMeta::new(ctx.accounts.market_quote_vault.key(), false),
        AccountMeta::new(ctx.accounts.event_heap.key(), false),
        AccountMeta::new(ctx.accounts.user_base_account.key(), false),
        AccountMeta::new(ctx.accounts.user_quote_account.key(), false),
        AccountMeta::new_readonly(ob, false),
        AccountMeta::new_readonly(ob, false),
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        AccountMeta::new_readonly(m.key(), true), // open_orders_admin = market PDA
    ];
    for acc in ctx.remaining_accounts { metas.push(AccountMeta::new(acc.key(), false)); }
    let ix = Instruction { program_id: ob, accounts: metas, data: ix_data(DISC_PLACE_TAKE_ORDER, &args) };
    let mut infos = vec![
        ctx.accounts.user.to_account_info(),
        ctx.accounts.openbook_market.to_account_info(),
        ctx.accounts.openbook_market_authority.to_account_info(),
        ctx.accounts.bids.to_account_info(),
        ctx.accounts.asks.to_account_info(),
        ctx.accounts.market_base_vault.to_account_info(),
        ctx.accounts.market_quote_vault.to_account_info(),
        ctx.accounts.event_heap.to_account_info(),
        ctx.accounts.user_base_account.to_account_info(),
        ctx.accounts.user_quote_account.to_account_info(),
        ctx.accounts.openbook_program.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.market.to_account_info(),
    ];
    infos.extend(ctx.remaining_accounts.iter().cloned());
    let seeds: &[&[u8]] = &[
        OUTCOME_MARKET_SEED, &[m.ticker_id], &m.trading_day.to_le_bytes(),
        &m.strike_1e6.to_le_bytes(), &[m.bump],
    ];
    invoke_signed(&ix, &infos, &[seeds])?;

    let base_after = read_u64(&ctx.accounts.user_base_account.try_borrow_data()?, TOKEN_AMOUNT_OFFSET);
    let delta = match args.side {
        Side::Bid => base_after.checked_sub(base_before),
        Side::Ask => base_before.checked_sub(base_after),
    }.ok_or(MeridianError::Overflow)?;
    require!(delta == expected, MeridianError::PartialFillReverted);
    ctx.accounts.market.activity_started = true;
    Ok(())
}
