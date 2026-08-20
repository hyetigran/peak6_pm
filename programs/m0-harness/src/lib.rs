//! Meridian M0 validation harness.
//!
//! This is NOT the production Meridian program. It exists to prove the M0
//! hard gates (PRD v0.7 §15) against the pinned OpenBook V2 v1.7 build —
//! Meridian's finalized devnet copy `923gYkFCtTtrL9pX7vQNKR7QJchb2jpY3s26xiWuDxz4`
//! (ADR-0029), or the same artifact loaded at the same ID on localnet.
//!
//! G2 scope (this revision): the PDA universal order gate. The harness owns
//! `venue_authority`, the `open_orders_admin` of every test Venue Market.
//! Direct OpenBook orders must fail; orders through these wrappers must
//! succeed. Later gates extend this program; no fee or collateral-withdrawal
//! plumbing may ever appear here (ADR-0001/0007).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

pub mod openbook;
use openbook::*;

declare_id!("3MmdMxRUF4NWPNdwoQcLhoqfmiKReoaSQR9GwSeQEpRr");

pub const VENUE_AUTHORITY_SEED: &[u8] = b"venue_authority";
pub const CONFIG_SEED: &[u8] = b"config";
pub const VENUE_GATE_SEED: &[u8] = b"venue_gate";

#[program]
pub mod m0_harness {
    use super::*;

    /// Stores the pinned OpenBook program identity. Every wrapper checks the
    /// supplied program account against it (fail closed on mismatch).
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.openbook_program = ctx.accounts.openbook_program.key();
        config.venue_authority_bump = ctx.bumps.venue_authority;
        Ok(())
    }

    /// Creates the per-market time/pause gate (G3). Admin-only.
    pub fn create_venue_gate(
        ctx: Context<CreateVenueGate>,
        trade_open_ts: i64,
        close_ts: i64,
    ) -> Result<()> {
        require!(trade_open_ts < close_ts, HarnessError::InvalidGateWindow);
        let gate = &mut ctx.accounts.venue_gate;
        gate.market = ctx.accounts.market.key();
        gate.trade_open_ts = trade_open_ts;
        gate.close_ts = close_ts;
        gate.paused = false;
        Ok(())
    }

    /// Pause or unpause order placement (G3). Admin-only. Pausing never
    /// cancels resting orders (ADR-0010); cancel/consume/settle stay
    /// available because they never pass through these wrappers.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        ctx.accounts.venue_gate.paused = paused;
        Ok(())
    }

    /// One-way venue expiry via OpenBook `set_market_expired` (G3 /
    /// ADR-0018 evidence). Admin-only; `venue_authority` signs as
    /// `close_market_admin`. At the pin this sets `time_expiry = -1` and
    /// rejects markets that are already expired.
    pub fn expire_market(ctx: Context<ExpireMarket>) -> Result<()> {
        let metas = vec![
            AccountMeta::new_readonly(ctx.accounts.venue_authority.key(), true),
            AccountMeta::new(ctx.accounts.market.key(), false),
        ];
        let ix = Instruction {
            program_id: ctx.accounts.openbook_program.key(),
            accounts: metas,
            data: DISC_SET_MARKET_EXPIRED.to_vec(),
        };
        let bump = [ctx.accounts.config.venue_authority_bump];
        let seeds: &[&[u8]] = &[VENUE_AUTHORITY_SEED, &bump];
        invoke_signed(
            &ix,
            &[
                ctx.accounts.venue_authority.to_account_info(),
                ctx.accounts.market.to_account_info(),
                ctx.accounts.openbook_program.to_account_info(),
            ],
            &[seeds],
        )?;
        Ok(())
    }

    /// PostOnly limit order via CPI with `venue_authority` signing as
    /// `open_orders_admin`. Rejects every non-PostOnly order type: V1 limits
    /// are PostOnly (freeze policy), and the G2 positive path must be the
    /// same shape production uses.
    pub fn place_limit_order(ctx: Context<PlaceLimitOrder>, args: PlaceOrderArgs) -> Result<()> {
        require!(
            args.order_type == PlaceOrderType::PostOnly,
            HarnessError::LimitOrdersMustBePostOnly
        );
        check_gate(&ctx.accounts.venue_gate)?;
        let ob = ctx.accounts.openbook_program.key();
        // IDL account order for place_order. Optional accounts follow the
        // anchor 0.28 convention: None == the callee program id, read-only.
        let metas = vec![
            AccountMeta::new_readonly(ctx.accounts.user.key(), true),
            AccountMeta::new(ctx.accounts.open_orders_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.venue_authority.key(), true), // open_orders_admin (PDA signs)
            AccountMeta::new(ctx.accounts.user_token_account.key(), false),
            AccountMeta::new(ctx.accounts.market.key(), false),
            AccountMeta::new(ctx.accounts.bids.key(), false),
            AccountMeta::new(ctx.accounts.asks.key(), false),
            AccountMeta::new(ctx.accounts.event_heap.key(), false),
            AccountMeta::new(ctx.accounts.market_vault.key(), false),
            AccountMeta::new_readonly(ob, false), // oracle_a: None
            AccountMeta::new_readonly(ob, false), // oracle_b: None
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        ];
        let ix = Instruction {
            program_id: ob,
            accounts: metas,
            data: ix_data(DISC_PLACE_ORDER, &args),
        };
        let bump = [ctx.accounts.config.venue_authority_bump];
        let seeds: &[&[u8]] = &[VENUE_AUTHORITY_SEED, &bump];
        invoke_signed(
            &ix,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.open_orders_account.to_account_info(),
                ctx.accounts.venue_authority.to_account_info(),
                ctx.accounts.user_token_account.to_account_info(),
                ctx.accounts.market.to_account_info(),
                ctx.accounts.bids.to_account_info(),
                ctx.accounts.asks.to_account_info(),
                ctx.accounts.event_heap.to_account_info(),
                ctx.accounts.market_vault.to_account_info(),
                ctx.accounts.openbook_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[seeds],
        )?;
        Ok(())
    }

    /// Take order via CPI with `venue_authority` signing as
    /// `open_orders_admin`. Full-fill-or-revert enforcement is G4/G5 work and
    /// is intentionally absent from this revision.
    pub fn place_take_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, PlaceTakeOrderCpi<'info>>,
        args: PlaceTakeOrderArgs,
    ) -> Result<()> {
        check_gate(&ctx.accounts.venue_gate)?;
        let ob = ctx.accounts.openbook_program.key();
        let mut metas = vec![
            AccountMeta::new(ctx.accounts.user.key(), true),
            AccountMeta::new(ctx.accounts.user.key(), true), // penalty_payer = user
            AccountMeta::new(ctx.accounts.market.key(), false),
            AccountMeta::new_readonly(ctx.accounts.market_authority.key(), false),
            AccountMeta::new(ctx.accounts.bids.key(), false),
            AccountMeta::new(ctx.accounts.asks.key(), false),
            AccountMeta::new(ctx.accounts.market_base_vault.key(), false),
            AccountMeta::new(ctx.accounts.market_quote_vault.key(), false),
            AccountMeta::new(ctx.accounts.event_heap.key(), false),
            AccountMeta::new(ctx.accounts.user_base_account.key(), false),
            AccountMeta::new(ctx.accounts.user_quote_account.key(), false),
            AccountMeta::new_readonly(ob, false), // oracle_a: None
            AccountMeta::new_readonly(ob, false), // oracle_b: None
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.venue_authority.key(), true), // open_orders_admin
        ];
        // G6: expected maker OpenOrders accounts so fills settle inline.
        for acc in ctx.remaining_accounts {
            metas.push(AccountMeta::new(acc.key(), false));
        }
        let ix = Instruction {
            program_id: ob,
            accounts: metas,
            data: ix_data(DISC_PLACE_TAKE_ORDER, &args),
        };
        let mut infos = vec![
            ctx.accounts.user.to_account_info(),
            ctx.accounts.market.to_account_info(),
            ctx.accounts.market_authority.to_account_info(),
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
            ctx.accounts.venue_authority.to_account_info(),
        ];
        infos.extend(ctx.remaining_accounts.iter().cloned());
        let bump = [ctx.accounts.config.venue_authority_bump];
        let seeds: &[&[u8]] = &[VENUE_AUTHORITY_SEED, &bump];
        invoke_signed(&ix, &infos, &[seeds])?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    /// CHECK: PDA existence proof only; bump stored in config.
    #[account(seeds = [VENUE_AUTHORITY_SEED], bump)]
    pub venue_authority: UncheckedAccount<'info>,
    /// CHECK: executable identity is snapshotted; wrappers compare against it.
    #[account(executable)]
    pub openbook_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceLimitOrder<'info> {
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [VENUE_GATE_SEED, market.key().as_ref()],
        bump,
        constraint = venue_gate.market == market.key() @ HarnessError::WrongGate,
    )]
    pub venue_gate: Account<'info, VenueGate>,
    /// CHECK: the open_orders_admin PDA; OpenBook enforces the exact match.
    #[account(seeds = [VENUE_AUTHORITY_SEED], bump = config.venue_authority_bump)]
    pub venue_authority: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub open_orders_account: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub user_token_account: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub bids: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub asks: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub event_heap: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub market_vault: UncheckedAccount<'info>,
    /// CHECK: fail closed on any program identity mismatch.
    #[account(executable, address = config.openbook_program @ HarnessError::WrongOpenbookProgram)]
    pub openbook_program: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PlaceTakeOrderCpi<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [VENUE_GATE_SEED, market.key().as_ref()],
        bump,
        constraint = venue_gate.market == market.key() @ HarnessError::WrongGate,
    )]
    pub venue_gate: Account<'info, VenueGate>,
    /// CHECK: the open_orders_admin PDA; OpenBook enforces the exact match.
    #[account(seeds = [VENUE_AUTHORITY_SEED], bump = config.venue_authority_bump)]
    pub venue_authority: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    pub market_authority: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub bids: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub asks: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub market_base_vault: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub market_quote_vault: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub event_heap: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub user_base_account: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub user_quote_account: UncheckedAccount<'info>,
    /// CHECK: fail closed on any program identity mismatch.
    #[account(executable, address = config.openbook_program @ HarnessError::WrongOpenbookProgram)]
    pub openbook_program: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateVenueGate<'info> {
    #[account(mut, address = config.admin @ HarnessError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: OpenBook market this gate governs; identity only.
    pub market: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + VenueGate::INIT_SPACE,
        seeds = [VENUE_GATE_SEED, market.key().as_ref()],
        bump,
    )]
    pub venue_gate: Account<'info, VenueGate>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(address = config.admin @ HarnessError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [VENUE_GATE_SEED, venue_gate.market.as_ref()], bump)]
    pub venue_gate: Account<'info, VenueGate>,
}

#[derive(Accounts)]
pub struct ExpireMarket<'info> {
    #[account(address = config.admin @ HarnessError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: the close_market_admin PDA; OpenBook enforces the exact match.
    #[account(seeds = [VENUE_AUTHORITY_SEED], bump = config.venue_authority_bump)]
    pub venue_authority: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: fail closed on any program identity mismatch.
    #[account(executable, address = config.openbook_program @ HarnessError::WrongOpenbookProgram)]
    pub openbook_program: UncheckedAccount<'info>,
}

/// G3 gate: orders only inside [trade_open_ts, close_ts) and never Paused.
/// Logs the exact Clock reading first so boundary tests judge by the very
/// timestamp the checks (and the subsequent OpenBook CPI) observed.
fn check_gate(gate: &VenueGate) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    msg!("gate_now={}", now);
    require!(now >= gate.trade_open_ts, HarnessError::OrderBeforeOpen);
    require!(!gate.paused, HarnessError::VenuePaused);
    require!(now < gate.close_ts, HarnessError::TradingClosed);
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct VenueGate {
    pub market: Pubkey,
    pub trade_open_ts: i64,
    pub close_ts: i64,
    pub paused: bool,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub openbook_program: Pubkey,
    pub venue_authority_bump: u8,
}

#[error_code]
pub enum HarnessError {
    #[msg("supplied OpenBook program does not match the pinned identity")]
    WrongOpenbookProgram,
    #[msg("V1 limit orders must be PostOnly")]
    LimitOrdersMustBePostOnly,
    #[msg("signer is not the harness admin")]
    NotAdmin,
    #[msg("venue gate does not govern this market")]
    WrongGate,
    #[msg("gate window is invalid: trade_open_ts must precede close_ts")]
    InvalidGateWindow,
    #[msg("order rejected: before trade open")]
    OrderBeforeOpen,
    #[msg("order rejected: venue is Paused")]
    VenuePaused,
    #[msg("order rejected: at or after close")]
    TradingClosed,
}
