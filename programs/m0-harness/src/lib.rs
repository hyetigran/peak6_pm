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
use anchor_lang::solana_program::program::{get_return_data, invoke_signed};

pub mod openbook;
use openbook::*;

declare_id!("3MmdMxRUF4NWPNdwoQcLhoqfmiKReoaSQR9GwSeQEpRr");

pub const VENUE_AUTHORITY_SEED: &[u8] = b"venue_authority";
pub const CONFIG_SEED: &[u8] = b"config";
pub const VENUE_GATE_SEED: &[u8] = b"venue_gate";
/// ADR-scoped unsignable fee-admin sentinel: a System-Program PDA. Off-curve
/// (no private key can exist) and the System Program has no `invoke_signed`
/// path, so NOTHING can ever produce this signature. G9-proven.
pub const FEE_ADMIN_SENTINEL_SEED: &[u8] = b"meridian_fee_admin_sentinel";
/// V1 production lot scheme (G10): one whole Yes Token per base lot,
/// one cent per price lot.
pub const PINNED_BASE_LOT_SIZE: i64 = 1_000_000;
pub const PINNED_QUOTE_LOT_SIZE: i64 = 10_000;

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

    /// Create a Venue Market via CPI with EVERY safety field pinned in code
    /// (G9 + the G1 create-golden residual): zero fees, unsignable
    /// collect_fee_admin sentinel, `venue_authority` as open_orders_admin and
    /// close_market_admin, consume_events_admin None (permissionless crank),
    /// no oracles, production lot sizes. No caller-supplied header value is
    /// forwarded. Post-CPI the wrapper re-reads the market account and
    /// verifies every pinned field byte-for-byte — fail closed on any drift.
    pub fn create_venue_market(
        ctx: Context<CreateVenueMarket>,
        name: String,
        time_expiry: i64,
    ) -> Result<()> {
        let ob = ctx.accounts.openbook_program.key();
        let (sentinel, _) = Pubkey::find_program_address(
            &[FEE_ADMIN_SENTINEL_SEED],
            &anchor_lang::system_program::ID,
        );
        // borsh args: name, OracleConfigParams{conf_filter f32, staleness None},
        // quote_lot, base_lot, maker_fee, taker_fee, time_expiry
        let mut data = DISC_CREATE_MARKET.to_vec();
        (name, 0.1f32, Option::<u32>::None).serialize(&mut data)?;
        (
            PINNED_QUOTE_LOT_SIZE,
            PINNED_BASE_LOT_SIZE,
            0i64, // maker_fee: zero, always
            0i64, // taker_fee: zero, always
            time_expiry,
        )
            .serialize(&mut data)?;
        let metas = vec![
            AccountMeta::new(ctx.accounts.market.key(), true),
            AccountMeta::new_readonly(ctx.accounts.market_authority.key(), false),
            AccountMeta::new(ctx.accounts.bids.key(), false),
            AccountMeta::new(ctx.accounts.asks.key(), false),
            AccountMeta::new(ctx.accounts.event_heap.key(), false),
            AccountMeta::new(ctx.accounts.admin.key(), true), // payer: operator, never a vault
            AccountMeta::new(ctx.accounts.market_base_vault.key(), false),
            AccountMeta::new(ctx.accounts.market_quote_vault.key(), false),
            AccountMeta::new_readonly(ctx.accounts.base_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.quote_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.associated_token_program.key(), false),
            AccountMeta::new_readonly(ob, false), // oracle_a: None
            AccountMeta::new_readonly(ob, false), // oracle_b: None
            AccountMeta::new_readonly(sentinel, false), // collect_fee_admin: unsignable
            AccountMeta::new_readonly(ctx.accounts.venue_authority.key(), false), // open_orders_admin
            AccountMeta::new_readonly(ob, false), // consume_events_admin: None
            AccountMeta::new_readonly(ctx.accounts.venue_authority.key(), false), // close_market_admin
            AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
            AccountMeta::new_readonly(ob, false),
        ];
        let ix = Instruction {
            program_id: ob,
            accounts: metas,
            data,
        };
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.market.to_account_info(),
                ctx.accounts.market_authority.to_account_info(),
                ctx.accounts.bids.to_account_info(),
                ctx.accounts.asks.to_account_info(),
                ctx.accounts.event_heap.to_account_info(),
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.market_base_vault.to_account_info(),
                ctx.accounts.market_quote_vault.to_account_info(),
                ctx.accounts.base_mint.to_account_info(),
                ctx.accounts.quote_mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.associated_token_program.to_account_info(),
                ctx.accounts.venue_authority.to_account_info(),
                ctx.accounts.fee_admin_sentinel.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.openbook_program.to_account_info(),
            ],
        )?;

        // post-CPI header verification: every pinned field, byte-for-byte
        let data = ctx.accounts.market.try_borrow_data()?;
        require!(
            *ctx.accounts.market.owner == ob,
            HarnessError::HeaderVerificationFailed
        );
        let va = ctx.accounts.venue_authority.key();
        let checks = [
            (read_pubkey(&data, MARKET_COLLECT_FEE_ADMIN_OFFSET) == sentinel),
            (read_pubkey(&data, MARKET_OPEN_ORDERS_ADMIN_OFFSET) == va),
            (read_pubkey(&data, MARKET_CONSUME_EVENTS_ADMIN_OFFSET) == Pubkey::default()),
            (read_pubkey(&data, MARKET_CLOSE_MARKET_ADMIN_OFFSET) == va),
            (read_i64(&data, MARKET_TIME_EXPIRY_OFFSET) == time_expiry),
            (read_i64(&data, MARKET_MAKER_FEE_OFFSET) == 0),
            (read_i64(&data, MARKET_TAKER_FEE_OFFSET) == 0),
            (read_i64(&data, MARKET_QUOTE_LOT_SIZE_OFFSET) == PINNED_QUOTE_LOT_SIZE),
            (read_i64(&data, MARKET_BASE_LOT_SIZE_OFFSET) == PINNED_BASE_LOT_SIZE),
        ];
        require!(
            checks.iter().all(|c| *c),
            HarnessError::HeaderVerificationFailed
        );
        Ok(())
    }

    /// Creates the per-Venue-Market time/pause gate (G3). Admin-only.
    pub fn create_venue_gate(
        ctx: Context<CreateVenueGate>,
        trade_open_ts: i64,
        close_ts: i64,
        rent_refund: Pubkey,
    ) -> Result<()> {
        require!(trade_open_ts < close_ts, HarnessError::InvalidGateWindow);
        let gate = &mut ctx.accounts.venue_gate;
        gate.market = ctx.accounts.market.key();
        gate.trade_open_ts = trade_open_ts;
        gate.close_ts = close_ts;
        gate.paused = false;
        gate.rent_refund = rent_refund;
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
        venue_signed_cpi(
            ctx.accounts.openbook_program.key(),
            metas,
            &[
                ctx.accounts.venue_authority.to_account_info(),
                ctx.accounts.market.to_account_info(),
                ctx.accounts.openbook_program.to_account_info(),
            ],
            DISC_SET_MARKET_EXPIRED.to_vec(),
            ctx.accounts.config.venue_authority_bump,
        )?;
        Ok(())
    }

    /// Prune a user's resting orders after expiry (G3 / ADR-0018 recovery
    /// evidence). Admin-only; `venue_authority` signs as `close_market_admin`.
    /// At the pin this requires the Venue Market to BE expired
    /// (`MarketHasNotExpired` otherwise) — proven both ways in tests.
    pub fn prune_orders(ctx: Context<PruneOrders>, limit: u8) -> Result<()> {
        let metas = vec![
            AccountMeta::new_readonly(ctx.accounts.venue_authority.key(), true),
            AccountMeta::new(ctx.accounts.open_orders_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.market.key(), false),
            AccountMeta::new(ctx.accounts.bids.key(), false),
            AccountMeta::new(ctx.accounts.asks.key(), false),
        ];
        let mut data = DISC_PRUNE_ORDERS.to_vec();
        data.push(limit);
        venue_signed_cpi(
            ctx.accounts.openbook_program.key(),
            metas,
            &[
                ctx.accounts.venue_authority.to_account_info(),
                ctx.accounts.open_orders_account.to_account_info(),
                ctx.accounts.market.to_account_info(),
                ctx.accounts.bids.to_account_info(),
                ctx.accounts.asks.to_account_info(),
                ctx.accounts.openbook_program.to_account_info(),
            ],
            data,
            ctx.accounts.config.venue_authority_bump,
        )?;
        Ok(())
    }

    /// Close an expired, empty Venue Market (G8 / ADR-0027). Admin-only;
    /// `venue_authority` signs as `close_market_admin`. Rent for the market,
    /// books, and EventHeap may go ONLY to the Rent Refund Address that was
    /// snapshotted at gate creation — never a caller-supplied account.
    pub fn close_venue_market(ctx: Context<CloseVenueMarket>) -> Result<()> {
        require!(
            ctx.accounts.sol_destination.key() == ctx.accounts.venue_gate.rent_refund,
            HarnessError::WrongRefundDestination
        );
        let metas = vec![
            AccountMeta::new_readonly(ctx.accounts.venue_authority.key(), true),
            AccountMeta::new(ctx.accounts.market.key(), false),
            AccountMeta::new(ctx.accounts.bids.key(), false),
            AccountMeta::new(ctx.accounts.asks.key(), false),
            AccountMeta::new(ctx.accounts.event_heap.key(), false),
            AccountMeta::new(ctx.accounts.sol_destination.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        ];
        venue_signed_cpi(
            ctx.accounts.openbook_program.key(),
            metas,
            &[
                ctx.accounts.venue_authority.to_account_info(),
                ctx.accounts.market.to_account_info(),
                ctx.accounts.bids.to_account_info(),
                ctx.accounts.asks.to_account_info(),
                ctx.accounts.event_heap.to_account_info(),
                ctx.accounts.sol_destination.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.openbook_program.to_account_info(),
            ],
            DISC_CLOSE_MARKET.to_vec(),
            ctx.accounts.config.venue_authority_bump,
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
        // G10: self-trade behavior is pinned; the wrapper never forwards a
        // caller-chosen value other than AbortTransaction.
        require!(
            args.self_trade_behavior == SelfTradeBehavior::AbortTransaction,
            HarnessError::SelfTradeMustAbort
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
        venue_signed_cpi(
            ob,
            metas,
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
            ix_data(DISC_PLACE_ORDER, &args),
            ctx.accounts.config.venue_authority_bump,
        )?;
        // G10: at the pin, a PostOnly order that would cross — or an order
        // whose expiry already passed — is a SILENT no-op (book.rs:166-170,
        // order.rs:52-54): the venue returns success with no resting order.
        // Meridian fails closed instead: the returned Option<u128> order id
        // must be Some. The id is logged for client-side cancel-by-id.
        let (from, data) = get_return_data().ok_or(HarnessError::OrderNotPosted)?;
        require!(
            from == ctx.accounts.openbook_program.key(),
            HarnessError::WrongOpenbookProgram
        );
        require!(data.first() == Some(&1) && data.len() == 17, HarnessError::OrderNotPosted);
        let id = u128::from_le_bytes(data[1..17].try_into().unwrap());
        msg!("order_id={}", id);
        Ok(())
    }

    /// Take order via CPI with `venue_authority` signing as
    /// `open_orders_admin`. Market Actions are full-fill-or-revert (G4): the
    /// user's base account must change by exactly `max_base_lots ×
    /// base_lot_size`; any partial fill fails the postcondition, reverting
    /// every OpenBook, token, and Meridian change in the transaction — no
    /// partial synthetic exposure survives.
    pub fn place_take_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, PlaceTakeOrderCpi<'info>>,
        args: PlaceTakeOrderArgs,
    ) -> Result<()> {
        check_gate(&ctx.accounts.venue_gate)?;
        require!(args.max_base_lots > 0, HarnessError::ZeroTakeQuantity);
        let base_lot_size = read_i64(
            &ctx.accounts.market.try_borrow_data()?,
            MARKET_BASE_LOT_SIZE_OFFSET,
        );
        // fail closed on corrupt/hostile market bytes before any cast
        require!(base_lot_size > 0, HarnessError::AmountOverflow);
        let expected_base_atoms = (args.max_base_lots as u64)
            .checked_mul(base_lot_size as u64)
            .ok_or(HarnessError::AmountOverflow)?;
        let base_before = read_u64(
            &ctx.accounts.user_base_account.try_borrow_data()?,
            TOKEN_AMOUNT_OFFSET,
        );
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
        venue_signed_cpi(
            ob,
            metas,
            &infos,
            ix_data(DISC_PLACE_TAKE_ORDER, &args),
            ctx.accounts.config.venue_authority_bump,
        )?;

        // G4 exact-delta postcondition: full fill or the whole tx reverts.
        let base_after = read_u64(
            &ctx.accounts.user_base_account.try_borrow_data()?,
            TOKEN_AMOUNT_OFFSET,
        );
        let delta = match args.side {
            Side::Bid => base_after.checked_sub(base_before),
            Side::Ask => base_before.checked_sub(base_after),
        }
        .ok_or(HarnessError::AmountOverflow)?;
        require!(
            delta == expected_base_atoms,
            HarnessError::PartialFillReverted
        );
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
pub struct CreateVenueMarket<'info> {
    #[account(mut, address = config.admin @ HarnessError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: becomes open_orders_admin AND close_market_admin.
    #[account(seeds = [VENUE_AUTHORITY_SEED], bump = config.venue_authority_bump)]
    pub venue_authority: UncheckedAccount<'info>,
    /// CHECK: created by OpenBook (init); must sign.
    #[account(mut)]
    pub market: Signer<'info>,
    /// CHECK: OpenBook PDA ["Market", market]; validated by OpenBook.
    pub market_authority: UncheckedAccount<'info>,
    /// CHECK: pre-created zeroed book account; validated by OpenBook.
    #[account(mut)]
    pub bids: UncheckedAccount<'info>,
    /// CHECK: pre-created zeroed book account; validated by OpenBook.
    #[account(mut)]
    pub asks: UncheckedAccount<'info>,
    /// CHECK: pre-created zeroed heap account; validated by OpenBook.
    #[account(mut)]
    pub event_heap: UncheckedAccount<'info>,
    /// CHECK: ATA(base_mint, market_authority), created by the CPI.
    #[account(mut)]
    pub market_base_vault: UncheckedAccount<'info>,
    /// CHECK: ATA(quote_mint, market_authority), created by the CPI.
    #[account(mut)]
    pub market_quote_vault: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    pub quote_mint: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: validated by OpenBook
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    pub associated_token_program: UncheckedAccount<'info>,
    /// CHECK: OpenBook #[event_cpi] authority PDA.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: the provably unsignable sentinel; address re-derived here so a
    /// wrong account fails closed before the CPI.
    #[account(address = Pubkey::find_program_address(&[FEE_ADMIN_SENTINEL_SEED], &anchor_lang::system_program::ID).0 @ HarnessError::HeaderVerificationFailed)]
    pub fee_admin_sentinel: UncheckedAccount<'info>,
    /// CHECK: fail closed on any program identity mismatch.
    #[account(executable, address = config.openbook_program @ HarnessError::WrongOpenbookProgram)]
    pub openbook_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CreateVenueGate<'info> {
    #[account(mut, address = config.admin @ HarnessError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: the OpenBook Venue Market this gate governs; identity only.
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

#[derive(Accounts)]
pub struct CloseVenueMarket<'info> {
    #[account(address = config.admin @ HarnessError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [VENUE_GATE_SEED, market.key().as_ref()], bump)]
    pub venue_gate: Account<'info, VenueGate>,
    /// CHECK: the close_market_admin PDA; OpenBook enforces the exact match.
    #[account(seeds = [VENUE_AUTHORITY_SEED], bump = config.venue_authority_bump)]
    pub venue_authority: UncheckedAccount<'info>,
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
    /// CHECK: must equal the snapshotted `venue_gate.rent_refund`.
    #[account(mut)]
    pub sol_destination: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: fail closed on any program identity mismatch.
    #[account(executable, address = config.openbook_program @ HarnessError::WrongOpenbookProgram)]
    pub openbook_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PruneOrders<'info> {
    #[account(address = config.admin @ HarnessError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: the close_market_admin PDA; OpenBook enforces the exact match.
    #[account(seeds = [VENUE_AUTHORITY_SEED], bump = config.venue_authority_bump)]
    pub venue_authority: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub open_orders_account: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    pub market: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub bids: UncheckedAccount<'info>,
    /// CHECK: validated by OpenBook
    #[account(mut)]
    pub asks: UncheckedAccount<'info>,
    /// CHECK: fail closed on any program identity mismatch.
    #[account(executable, address = config.openbook_program @ HarnessError::WrongOpenbookProgram)]
    pub openbook_program: UncheckedAccount<'info>,
}


/// Sign a CPI as `venue_authority` — the single scaffold every venue wrapper
/// shares (order placement, expiry, prune, close).
fn venue_signed_cpi(
    program_id: Pubkey,
    metas: Vec<AccountMeta>,
    infos: &[AccountInfo],
    data: Vec<u8>,
    venue_authority_bump: u8,
) -> Result<()> {
    let ix = Instruction { program_id, accounts: metas, data };
    let bump = [venue_authority_bump];
    let seeds: &[&[u8]] = &[VENUE_AUTHORITY_SEED, &bump];
    invoke_signed(&ix, infos, &[seeds])?;
    Ok(())
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
    /// ADR-0027: the only account venue close paths may refund rent to.
    pub rent_refund: Pubkey,
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
    #[msg("take quantity must be positive")]
    ZeroTakeQuantity,
    #[msg("amount arithmetic overflow")]
    AmountOverflow,
    #[msg("Market Action did not fill fully; reverting (no partial exposure)")]
    PartialFillReverted,
    #[msg("rent may only go to the snapshotted Rent Refund Address")]
    WrongRefundDestination,
    #[msg("limit wrapper pins SelfTradeBehavior to AbortTransaction")]
    SelfTradeMustAbort,
    #[msg("order was not posted (PostOnly would cross, or expiry already passed); failing closed")]
    OrderNotPosted,
    #[msg("post-create Venue Market header verification failed")]
    HeaderVerificationFailed,
}
