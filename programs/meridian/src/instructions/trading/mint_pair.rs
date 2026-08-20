//! Mint a Pair: deposit q USDC atoms into the collateral vault, mint q Yes +
//! q No to the user (1 atom == 1 atom, ADR-0002). Sets `activity_started`;
//! raises `collateral_liability_atoms`. Requires the mint window open.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};
use crate::constants::{CONFIG_SEED, OUTCOME_MARKET_SEED};
use crate::error::MeridianError;
use crate::state::{Config, MarketState, OutcomeMarket};

#[derive(Accounts)]
pub struct MintPair<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, constraint = !config.paused @ MeridianError::ConfigPaused)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [OUTCOME_MARKET_SEED, &[market.ticker_id], &market.trading_day.to_le_bytes(), &market.strike_1e6.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, OutcomeMarket>>,
    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.collateral_vault)]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = user, token::mint = config.quote_mint)]
    pub user_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = user, token::mint = yes_mint)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = user, token::mint = no_mint)]
    pub user_no: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<MintPair>, q_atoms: u64) -> Result<()> {
    require!(q_atoms > 0, MeridianError::CollateralInvariant);
    let now = Clock::get()?.unix_timestamp;
    let m = &ctx.accounts.market;
    require!(
        m.state == MarketState::Active as u8 || m.state == MarketState::Created as u8,
        MeridianError::WrongMarketState
    );
    require!(!m.paused && !m.permanent_pause && !m.emergency_expired, MeridianError::TradingClosed);
    require!(now >= m.mint_open_ts && now < m.close_ts, MeridianError::TradingClosed);

    // user -> vault
    token::transfer(
        CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer {
            from: ctx.accounts.user_quote.to_account_info(),
            to: ctx.accounts.collateral_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        }),
        q_atoms,
    )?;
    // market PDA mints the pair
    let seeds: &[&[u8]] = &[
        OUTCOME_MARKET_SEED, &[m.ticker_id], &m.trading_day.to_le_bytes(),
        &m.strike_1e6.to_le_bytes(), &[m.bump],
    ];
    for (mint, to) in [
        (ctx.accounts.yes_mint.to_account_info(), ctx.accounts.user_yes.to_account_info()),
        (ctx.accounts.no_mint.to_account_info(), ctx.accounts.user_no.to_account_info()),
    ] {
        token::mint_to(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), MintTo {
                mint, to, authority: ctx.accounts.market.to_account_info(),
            }, &[seeds]),
            q_atoms,
        )?;
    }
    let m = &mut ctx.accounts.market;
    m.activity_started = true;
    m.collateral_liability_atoms = m.collateral_liability_atoms.checked_add(q_atoms).ok_or(MeridianError::Overflow)?;
    // solvency: vault >= liability
    ctx.accounts.collateral_vault.reload()?;
    require!(ctx.accounts.collateral_vault.amount >= m.collateral_liability_atoms, MeridianError::CollateralInvariant);
    Ok(())
}

/// Direct Pair Redemption: burn q Yes + q No, release q USDC (ADR-0003).
/// Available in any non-terminal state, including paused (recovery).
#[derive(Accounts)]
pub struct RedeemPairDirect<'info> {
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [OUTCOME_MARKET_SEED, &[market.ticker_id], &market.trading_day.to_le_bytes(), &market.strike_1e6.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, OutcomeMarket>>,
    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.collateral_vault)]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = user)]
    pub user_quote: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = user, token::mint = yes_mint)]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = user, token::mint = no_mint)]
    pub user_no: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn redeem_pair_direct(ctx: Context<RedeemPairDirect>, q_atoms: u64) -> Result<()> {
    require!(q_atoms > 0, MeridianError::CollateralInvariant);
    let m = &ctx.accounts.market;
    for (mint, from) in [
        (ctx.accounts.yes_mint.to_account_info(), ctx.accounts.user_yes.to_account_info()),
        (ctx.accounts.no_mint.to_account_info(), ctx.accounts.user_no.to_account_info()),
    ] {
        token::burn(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), Burn {
                mint, from, authority: ctx.accounts.user.to_account_info(),
            }),
            q_atoms,
        )?;
    }
    let seeds: &[&[u8]] = &[
        OUTCOME_MARKET_SEED, &[m.ticker_id], &m.trading_day.to_le_bytes(),
        &m.strike_1e6.to_le_bytes(), &[m.bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
            from: ctx.accounts.collateral_vault.to_account_info(),
            to: ctx.accounts.user_quote.to_account_info(),
            authority: ctx.accounts.market.to_account_info(),
        }, &[seeds]),
        q_atoms,
    )?;
    let m = &mut ctx.accounts.market;
    m.collateral_liability_atoms = m.collateral_liability_atoms.checked_sub(q_atoms).ok_or(MeridianError::Overflow)?;
    ctx.accounts.collateral_vault.reload()?;
    require!(ctx.accounts.collateral_vault.amount >= m.collateral_liability_atoms, MeridianError::CollateralInvariant);
    Ok(())
}
