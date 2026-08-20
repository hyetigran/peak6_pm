//! Attach the single Yes/USDC OpenBook Venue Market to a Created Outcome
//! Market (ARCHITECTURE §8). The OutcomeMarket PDA is `open_orders_admin` and
//! `close_market_admin`; `collect_fee_admin` is the unsignable sentinel; zero
//! fees; production lots. Operator funds rent. No post-create mutation path.

use anchor_lang::prelude::*;
use crate::constants::*;
use crate::error::MeridianError;
use crate::openbook::*;
use crate::state::{Config, MarketState, OutcomeMarket};

#[derive(Accounts)]
pub struct CreateVenueMarket<'info> {
    #[account(mut, address = config.operator @ MeridianError::Unauthorized)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = !config.paused @ MeridianError::ConfigPaused)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [OUTCOME_MARKET_SEED, &[market.ticker_id], &market.trading_day.to_le_bytes(), &market.strike_1e6.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, OutcomeMarket>>,
    /// CHECK: OpenBook market (created by the CPI, must sign).
    #[account(mut)]
    pub openbook_market: Signer<'info>,
    /// CHECK: OpenBook ["Market", openbook_market] PDA.
    pub openbook_market_authority: UncheckedAccount<'info>,
    /// CHECK: pre-created zeroed book/heap accounts (operator-funded).
    #[account(mut)] pub bids: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut)] pub asks: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut)] pub event_heap: UncheckedAccount<'info>,
    /// CHECK: ATA(yes_mint, openbook_market_authority), created by the CPI.
    #[account(mut)] pub market_base_vault: UncheckedAccount<'info>,
    /// CHECK: ATA(quote_mint, openbook_market_authority), created by the CPI.
    #[account(mut)] pub market_quote_vault: UncheckedAccount<'info>,
    #[account(address = market.yes_mint)]
    /// CHECK: base mint == Yes
    pub yes_mint: UncheckedAccount<'info>,
    #[account(address = config.quote_mint @ MeridianError::WrongQuoteMint)]
    /// CHECK: quote mint == pinned USDC
    pub quote_mint: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: token program
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: ATA program
    pub associated_token_program: UncheckedAccount<'info>,
    /// CHECK: OpenBook event_cpi authority PDA
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: the unsignable fee-admin sentinel
    #[account(address = FEE_ADMIN_SENTINEL @ MeridianError::CollateralInvariant)]
    pub fee_admin_sentinel: UncheckedAccount<'info>,
    /// CHECK: pinned OpenBook program
    #[account(executable, address = config.openbook_program_id @ MeridianError::WrongOpenbookProgram)]
    pub openbook_program: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<CreateVenueMarket>, name: String, time_expiry: i64) -> Result<()> {
    let m = &ctx.accounts.market;
    require!(m.state == MarketState::Created as u8, MeridianError::WrongMarketState);
    require!(!m.has_venue(), MeridianError::VenueAlreadyAttached);
    let ob = ctx.accounts.openbook_program.key();

    let mut data = DISC_CREATE_MARKET.to_vec();
    (name, PINNED_CONF_FILTER, Option::<u32>::None).serialize(&mut data)?;
    (QUOTE_LOT_SIZE, BASE_LOT_SIZE, MAKER_FEE, TAKER_FEE, time_expiry).serialize(&mut data)?;

    let market_key = ctx.accounts.market.key();
    let seeds: &[&[u8]] = &[
        OUTCOME_MARKET_SEED, &[m.ticker_id], &m.trading_day.to_le_bytes(),
        &m.strike_1e6.to_le_bytes(), &[m.bump],
    ];
    let metas = vec![
        AccountMeta::new(ctx.accounts.openbook_market.key(), true),
        AccountMeta::new_readonly(ctx.accounts.openbook_market_authority.key(), false),
        AccountMeta::new(ctx.accounts.bids.key(), false),
        AccountMeta::new(ctx.accounts.asks.key(), false),
        AccountMeta::new(ctx.accounts.event_heap.key(), false),
        AccountMeta::new(ctx.accounts.operator.key(), true),
        AccountMeta::new(ctx.accounts.market_base_vault.key(), false),
        AccountMeta::new(ctx.accounts.market_quote_vault.key(), false),
        AccountMeta::new_readonly(ctx.accounts.yes_mint.key(), false),
        AccountMeta::new_readonly(ctx.accounts.quote_mint.key(), false),
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.associated_token_program.key(), false),
        AccountMeta::new_readonly(ob, false), // oracle_a None
        AccountMeta::new_readonly(ob, false), // oracle_b None
        AccountMeta::new_readonly(ctx.accounts.fee_admin_sentinel.key(), false),
        AccountMeta::new_readonly(market_key, false), // open_orders_admin = market PDA
        AccountMeta::new_readonly(ob, false),         // consume_events_admin None
        AccountMeta::new_readonly(market_key, false), // close_market_admin = market PDA
        AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
        AccountMeta::new_readonly(ob, false),
    ];
    let ix = anchor_lang::solana_program::instruction::Instruction { program_id: ob, accounts: metas, data };
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            ctx.accounts.openbook_market.to_account_info(),
            ctx.accounts.openbook_market_authority.to_account_info(),
            ctx.accounts.bids.to_account_info(),
            ctx.accounts.asks.to_account_info(),
            ctx.accounts.event_heap.to_account_info(),
            ctx.accounts.operator.to_account_info(),
            ctx.accounts.market_base_vault.to_account_info(),
            ctx.accounts.market_quote_vault.to_account_info(),
            ctx.accounts.yes_mint.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.associated_token_program.to_account_info(),
            ctx.accounts.market.to_account_info(),
            ctx.accounts.fee_admin_sentinel.to_account_info(),
            ctx.accounts.event_authority.to_account_info(),
            ctx.accounts.openbook_program.to_account_info(),
        ],
        &[seeds],
    )?;

    let m = &mut ctx.accounts.market;
    m.openbook_market = ctx.accounts.openbook_market.key();
    m.openbook_market_authority = ctx.accounts.openbook_market_authority.key();
    m.bids = ctx.accounts.bids.key();
    m.asks = ctx.accounts.asks.key();
    m.event_heap = ctx.accounts.event_heap.key();
    m.openbook_base_vault = ctx.accounts.market_base_vault.key();
    m.openbook_quote_vault = ctx.accounts.market_quote_vault.key();
    m.program_yes_trade_ata = Pubkey::default(); // set on first market-assisted redeem path (M2)
    m.state = MarketState::Active as u8;
    Ok(())
}
