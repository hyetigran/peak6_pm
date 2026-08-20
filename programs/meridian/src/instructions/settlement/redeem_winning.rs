//! Outcome Redemption (post-settlement): burn `amount` of the WINNING outcome
//! token for exactly `amount` USDC; the losing token pays 0. The $1 complement
//! holds because the vault was funded 1:1 at mint and pair redemptions are
//! still available too (ADR-0003).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use crate::constants::OUTCOME_MARKET_SEED;
use crate::error::MeridianError;
use crate::state::{MarketState, Outcome, OutcomeMarket};

#[derive(Accounts)]
pub struct RedeemWinning<'info> {
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [OUTCOME_MARKET_SEED, &[market.ticker_id], &market.trading_day.to_le_bytes(), &market.strike_1e6.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, OutcomeMarket>>,
    /// CHECK: the winning mint (Yes or No), resolved in-handler.
    #[account(mut)]
    pub winning_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.collateral_vault)]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = user, token::mint = winning_mint)]
    pub user_winning: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::authority = user)]
    pub user_quote: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RedeemWinning>, amount: u64) -> Result<()> {
    require!(amount > 0, MeridianError::CollateralInvariant);
    let m = &ctx.accounts.market;
    require!(m.state == MarketState::Settled as u8, MeridianError::WrongMarketState);
    let winning_mint = match m.outcome {
        x if x == Outcome::Yes as u8 => m.yes_mint,
        x if x == Outcome::No as u8 => m.no_mint,
        _ => return err!(MeridianError::WrongMarketState),
    };
    require!(ctx.accounts.winning_mint.key() == winning_mint, MeridianError::CollateralInvariant);

    // burn winning token
    token::burn(
        CpiContext::new(ctx.accounts.token_program.to_account_info(), Burn {
            mint: ctx.accounts.winning_mint.to_account_info(),
            from: ctx.accounts.user_winning.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        }),
        amount,
    )?;
    // pay 1:1 from the vault
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
        amount,
    )?;
    let m = &mut ctx.accounts.market;
    m.collateral_liability_atoms = m.collateral_liability_atoms.checked_sub(amount).ok_or(MeridianError::Overflow)?;
    Ok(())
}
