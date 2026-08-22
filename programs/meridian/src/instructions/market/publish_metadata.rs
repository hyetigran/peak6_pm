//! Publish permanent Metaplex Token Metadata for a market's Yes/No Pair mints.
//! The mint authority is the Outcome Market PDA, so only this program can sign
//! `CreateMetadataAccountV3` — the market PDA signs via `invoke_signed`. Cosmetic
//! (names/symbols shown in wallets); mint/settlement never depend on it.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::Mint;

use crate::constants::{CONFIG_SEED, OUTCOME_MARKET_SEED, TOKEN_METADATA_PROGRAM_ID};
use crate::error::MeridianError;
use crate::state::{Config, OutcomeMarket};

#[derive(Accounts)]
pub struct PublishMetadata<'info> {
    #[account(mut, address = config.operator @ MeridianError::Unauthorized)]
    pub operator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [OUTCOME_MARKET_SEED, &[market.ticker_id], &market.trading_day.to_le_bytes(), &market.strike_1e6.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, OutcomeMarket>>,
    #[account(address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,
    /// CHECK: Metaplex metadata PDA for yes_mint; validated by the CPI.
    #[account(mut)]
    pub yes_metadata: UncheckedAccount<'info>,
    /// CHECK: Metaplex metadata PDA for no_mint; validated by the CPI.
    #[account(mut)]
    pub no_metadata: UncheckedAccount<'info>,
    /// CHECK: Metaplex Token Metadata program, pinned by address.
    #[account(address = TOKEN_METADATA_PROGRAM_ID)]
    pub token_metadata_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<PublishMetadata>,
    yes_name: String,
    yes_symbol: String,
    no_name: String,
    no_symbol: String,
    uri: String,
) -> Result<()> {
    let m = &ctx.accounts.market;
    let seeds: &[&[u8]] = &[
        OUTCOME_MARKET_SEED,
        std::slice::from_ref(&m.ticker_id),
        &m.trading_day.to_le_bytes(),
        &m.strike_1e6.to_le_bytes(),
        std::slice::from_ref(&m.bump),
    ];
    create_metadata_v3(&ctx, &ctx.accounts.yes_mint.to_account_info(), &ctx.accounts.yes_metadata, yes_name, yes_symbol, uri.clone(), seeds)?;
    create_metadata_v3(&ctx, &ctx.accounts.no_mint.to_account_info(), &ctx.accounts.no_metadata, no_name, no_symbol, uri, seeds)?;
    Ok(())
}

fn write_str(buf: &mut Vec<u8>, s: &str) {
    buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
    buf.extend_from_slice(s.as_bytes());
}

fn create_metadata_v3<'info>(
    ctx: &Context<PublishMetadata<'info>>,
    mint: &AccountInfo<'info>,
    metadata: &UncheckedAccount<'info>,
    name: String,
    symbol: String,
    uri: String,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    let market = ctx.accounts.market.to_account_info();
    // CreateMetadataAccountV3 (discriminator 33) + borsh(CreateMetadataAccountArgsV3)
    let mut data = vec![33u8];
    write_str(&mut data, &name);
    write_str(&mut data, &symbol);
    write_str(&mut data, &uri);
    data.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_basis_points
    data.push(0); // creators: None
    data.push(0); // collection: None
    data.push(0); // uses: None
    data.push(0); // is_mutable: false — permanent (ADR-0016); update_authority is the Market PDA
    data.push(0); // collection_details: None

    let ix = Instruction {
        program_id: TOKEN_METADATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(metadata.key(), false),        // metadata
            AccountMeta::new_readonly(mint.key(), false),   // mint
            AccountMeta::new_readonly(market.key(), true),  // mint authority (PDA signer)
            AccountMeta::new(ctx.accounts.operator.key(), true), // payer
            AccountMeta::new_readonly(market.key(), false), // update authority
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            metadata.to_account_info(),
            mint.clone(),
            market.clone(),
            ctx.accounts.operator.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rent.to_account_info(),
        ],
        &[signer_seeds],
    )?;
    Ok(())
}
