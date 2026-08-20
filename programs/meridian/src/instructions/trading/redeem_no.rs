//! Sell No as market-assisted Pair Redemption (`redeem_no_via_market`,
//! ADR-0008 / G5). Burn the user's No, buy exactly q Yes on the venue with
//! VAULT collateral (full-fill-or-revert), burn the acquired Yes to complete
//! the pair, and pay the user the released remainder. The OutcomeMarket PDA is
//! the single authority (vault owner + open_orders_admin); the USER is the
//! venue penalty_payer, never the collateral vault.
//!
//! Invariant enforced on-chain: vault delta == liability delta == -q_atoms.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{self, Burn, Token, Transfer};

use crate::constants::{BASE_LOT_SIZE, OUTCOME_MARKET_SEED};
use crate::error::MeridianError;
use crate::openbook::*;
use crate::state::{Config, OutcomeMarket};
use super::require_tradeable;

/// Read an SPL token account's `amount` (offset 64) from raw bytes — avoids a
/// typed deserialization on the accounts struct (SBF stack budget).
fn read_amount(ai: &UncheckedAccount) -> Result<u64> {
    Ok(read_u64(&ai.try_borrow_data()?, TOKEN_AMOUNT_OFFSET))
}

#[derive(Accounts)]
pub struct RedeemNoViaMarket<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    // singleton, program-owned; no seeds re-derivation (SBF stack budget).
    pub config: Box<Account<'info, Config>>,
    // No seeds re-derivation (SBF stack budget): the market's own fields pin
    // every other account (mints, vault, venue), and the handler signs with
    // the stored bump — a mismatched market cannot produce a valid signature.
    #[account(mut)]
    pub market: Box<Account<'info, OutcomeMarket>>,
    /// CHECK: address-pinned; used only in CPI (burn).
    #[account(mut, address = market.yes_mint)]
    pub yes_mint: UncheckedAccount<'info>,
    /// CHECK: address-pinned; used only in CPI (burn).
    #[account(mut, address = market.no_mint)]
    pub no_mint: UncheckedAccount<'info>,
    /// CHECK: address-pinned collateral vault; balance read via raw bytes.
    #[account(mut, address = market.collateral_vault)]
    pub collateral_vault: UncheckedAccount<'info>,
    /// CHECK: the canonical program Yes-trade ATA — verified in-handler; the
    /// client pre-creates it (idempotent ATA create). Buys land here, then burn.
    #[account(mut)]
    pub trade_yes_ata: UncheckedAccount<'info>,
    /// CHECK: payout destination; token program enforces validity in CPI.
    #[account(mut)]
    pub user_quote: UncheckedAccount<'info>,
    /// CHECK: user's No account; the user signs the burn so the token program checks ownership.
    #[account(mut)]
    pub user_no: UncheckedAccount<'info>,
    /// CHECK: == market.openbook_market
    #[account(mut, address = market.openbook_market @ MeridianError::VenueNotAttached)]
    pub openbook_market: UncheckedAccount<'info>,
    /// CHECK:
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
    /// CHECK: pinned OpenBook program
    #[account(executable, address = config.openbook_program_id @ MeridianError::WrongOpenbookProgram)]
    pub openbook_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// The vault-funded Yes buy, isolated in its own stack frame (SBF 4KB limit).
#[inline(never)]
fn vault_buy_yes<'info>(
    ctx: &Context<'_, '_, 'info, 'info, RedeemNoViaMarket<'info>>,
    q_lots: i64,
    price_lots: i64,
    seeds: &[&[u8]],
) -> Result<()> {
    let m = &ctx.accounts.market;
    let ob = ctx.accounts.openbook_program.key();
    let args = PlaceTakeOrderArgs {
        side: Side::Bid, price_lots, max_base_lots: q_lots,
        max_quote_lots_including_fees: price_lots.checked_mul(q_lots).ok_or(MeridianError::Overflow)?,
        order_type: PlaceOrderType::ImmediateOrCancel, limit: 16,
    };
    let mut metas = vec![
        AccountMeta::new(m.key(), true),
        AccountMeta::new(ctx.accounts.user.key(), true),
        AccountMeta::new(ctx.accounts.openbook_market.key(), false),
        AccountMeta::new_readonly(ctx.accounts.openbook_market_authority.key(), false),
        AccountMeta::new(ctx.accounts.bids.key(), false),
        AccountMeta::new(ctx.accounts.asks.key(), false),
        AccountMeta::new(ctx.accounts.market_base_vault.key(), false),
        AccountMeta::new(ctx.accounts.market_quote_vault.key(), false),
        AccountMeta::new(ctx.accounts.event_heap.key(), false),
        AccountMeta::new(ctx.accounts.trade_yes_ata.key(), false),
        AccountMeta::new(ctx.accounts.collateral_vault.key(), false),
        AccountMeta::new_readonly(ob, false),
        AccountMeta::new_readonly(ob, false),
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        AccountMeta::new_readonly(m.key(), true),
    ];
    for acc in ctx.remaining_accounts { metas.push(AccountMeta::new(acc.key(), false)); }
    let mut infos = vec![
        ctx.accounts.market.to_account_info(),
        ctx.accounts.user.to_account_info(),
        ctx.accounts.openbook_market.to_account_info(),
        ctx.accounts.openbook_market_authority.to_account_info(),
        ctx.accounts.bids.to_account_info(),
        ctx.accounts.asks.to_account_info(),
        ctx.accounts.market_base_vault.to_account_info(),
        ctx.accounts.market_quote_vault.to_account_info(),
        ctx.accounts.event_heap.to_account_info(),
        ctx.accounts.trade_yes_ata.to_account_info(),
        ctx.accounts.collateral_vault.to_account_info(),
        ctx.accounts.openbook_program.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
    ];
    infos.extend(ctx.remaining_accounts.iter().cloned());
    let ix = Instruction { program_id: ob, accounts: metas, data: ix_data(DISC_PLACE_TAKE_ORDER, &args) };
    invoke_signed(&ix, &infos, &[seeds])?;
    Ok(())
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, RedeemNoViaMarket<'info>>,
    q_lots: i64,
    price_lots: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require_tradeable(&ctx.accounts.market, now)?;
    require!(q_lots > 0 && price_lots > 0, MeridianError::PartialFillReverted);
    let q_atoms = (q_lots as u64).checked_mul(BASE_LOT_SIZE as u64).ok_or(MeridianError::Overflow)?;

    // verify the program Yes-trade ATA is canonical for (yes_mint, market)
    let expected_ata = anchor_spl::associated_token::get_associated_token_address(
        &ctx.accounts.market.key(), &ctx.accounts.market.yes_mint);
    require!(ctx.accounts.trade_yes_ata.key() == expected_ata, MeridianError::CollateralInvariant);

    let m = &ctx.accounts.market;
    let seeds: &[&[u8]] = &[
        OUTCOME_MARKET_SEED, &[m.ticker_id], &m.trading_day.to_le_bytes(),
        &m.strike_1e6.to_le_bytes(), &[m.bump],
    ];

    // 1. USER signs the No burn — collateral never moves without it
    token::burn(CpiContext::new(ctx.accounts.token_program.to_account_info(), Burn {
        mint: ctx.accounts.no_mint.to_account_info(),
        from: ctx.accounts.user_no.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    }), q_atoms)?;

    // 2. buy exactly q Yes with VAULT quote; market PDA is trader +
    //    open_orders_admin; the USER is penalty_payer
    let vault_before = read_amount(&ctx.accounts.collateral_vault)?;
    let yes_before = read_amount(&ctx.accounts.trade_yes_ata)?;
    vault_buy_yes(&ctx, q_lots, price_lots, seeds)?;

    // 3. exact q Yes acquired (G4 postcondition)
    let yes_after = read_amount(&ctx.accounts.trade_yes_ata)?;
    require!(yes_after.checked_sub(yes_before) == Some(q_atoms), MeridianError::PartialFillReverted);
    // 4. burn the acquired Yes (market PDA signs)
    token::burn(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Burn {
        mint: ctx.accounts.yes_mint.to_account_info(),
        from: ctx.accounts.trade_yes_ata.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    }, &[seeds]), q_atoms)?;

    // 5. pay the user the released remainder: q - spent
    let vault_mid = read_amount(&ctx.accounts.collateral_vault)?;
    let spent = vault_before.checked_sub(vault_mid).ok_or(MeridianError::Overflow)?;
    let payout = q_atoms.checked_sub(spent).ok_or(MeridianError::CollateralInvariant)?;
    token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer {
        from: ctx.accounts.collateral_vault.to_account_info(),
        to: ctx.accounts.user_quote.to_account_info(),
        authority: ctx.accounts.market.to_account_info(),
    }, &[seeds]), payout)?;

    // 6. invariant: vault delta == q_atoms exactly
    let vault_after = read_amount(&ctx.accounts.collateral_vault)?;
    require!(
        vault_before.checked_sub(vault_after) == Some(q_atoms),
        MeridianError::CollateralInvariant
    );
    let m = &mut ctx.accounts.market;
    m.collateral_liability_atoms = m.collateral_liability_atoms.checked_sub(q_atoms).ok_or(MeridianError::Overflow)?;
    m.program_yes_trade_ata = ctx.accounts.trade_yes_ata.key();
    Ok(())
}
