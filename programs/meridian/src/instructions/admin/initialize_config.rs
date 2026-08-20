use anchor_lang::prelude::*;
use crate::constants::*;
use crate::error::MeridianError;
use crate::events::ConfigInitialized;
use crate::state::Config;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub governance: Signer<'info>,
    #[account(
        init,
        payer = governance,
        space = Config::SIZE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    /// CHECK: validated (owner + decimals) then pinned.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: pinned OpenBook program; must be the canonical id and executable.
    #[account(executable, address = OPENBOOK_PROGRAM_ID @ MeridianError::WrongOpenbookProgram)]
    pub openbook_program: UncheckedAccount<'info>,
    /// CHECK: OpenBook ProgramData; identity snapshotted for per-CPI checks.
    pub openbook_programdata: UncheckedAccount<'info>,
    pub token_program: Program<'info, anchor_spl::token::Token>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<InitializeConfig>,
    operator: Pubkey,
    pause_authority: Pubkey,
    override_authority: Pubkey,
    supported_ticker_mask: u8,
    openbook_deployment_slot: u64,
    openbook_executable_sha256: [u8; 32],
    openbook_upgrade_authority: Pubkey,
    min_samples: u8,
    max_stale_slots: u64,
    max_price_band_bps: u16,
) -> Result<()> {
    // quote-mint validation (G12): classic SPL Token, 6 decimals, initialized.
    require!(
        *ctx.accounts.quote_mint.owner == ctx.accounts.token_program.key(),
        MeridianError::WrongQuoteMint
    );
    {
        let d = ctx.accounts.quote_mint.try_borrow_data()?;
        require!(
            d.len() == 82 && d[44] == QUOTE_DECIMALS && d[45] == 1,
            MeridianError::WrongQuoteMint
        );
    }
    let c = &mut ctx.accounts.config;
    c.schema_version = 1;
    c.bump = ctx.bumps.config;
    c.governance = ctx.accounts.governance.key();
    c.operator = operator;
    c.pause_authority = pause_authority;
    c.override_authority = override_authority;
    c.pending_governance = Pubkey::default();
    c.pending_operator = Pubkey::default();
    c.pending_pause_authority = Pubkey::default();
    c.pending_override_authority = Pubkey::default();
    c.quote_mint = ctx.accounts.quote_mint.key();
    c.token_program = ctx.accounts.token_program.key();
    c.quote_decimals = QUOTE_DECIMALS;
    c.supported_ticker_mask = supported_ticker_mask;
    c.paused = false;
    c.openbook_program_id = ctx.accounts.openbook_program.key();
    c.openbook_programdata = ctx.accounts.openbook_programdata.key();
    c.openbook_deployment_slot = openbook_deployment_slot;
    c.openbook_executable_sha256 = openbook_executable_sha256;
    c.openbook_upgrade_authority = openbook_upgrade_authority;
    c.min_samples = min_samples;
    c.max_stale_slots = max_stale_slots;
    c.max_sample_spread_bps = MAX_SAMPLE_SPREAD_BPS;
    c.max_price_band_bps = max_price_band_bps;

    emit!(ConfigInitialized {
        governance: c.governance,
        quote_mint: c.quote_mint,
        openbook_program_id: c.openbook_program_id,
    });
    Ok(())
}
