//! Governance recovery (ADR-0038). ONE-SHOT, feature-gated, removed by the
//! next upgrade.
//!
//! GOVERNANCE.md §2 makes Config roles self-sovereign: only `governance` may
//! `propose_role`, so a lost governance key leaves Config stuck "until a
//! program upgrade ships a migration". This is that migration. The ONLY key
//! that can call it is the program's own upgrade authority, proven on-chain by
//! reading this program's `ProgramData` account — nobody else, not even the
//! (lost) governance key, and not any other Config role.
//!
//! It does NOT touch operator / pause / override: once governance is
//! recovered those rotate through the normal two-step path (ADR-0024).
//!
//! Compiled only with `--features governance-recovery`. The recovery build is
//! deployed, the instruction is executed once, and the next deploy is a
//! build WITHOUT the feature so the upgrade plane can no longer write Config
//! (GOVERNANCE.md §1: "Config governance cannot upgrade the program" — and,
//! outside this one window, the converse).

use anchor_lang::prelude::*;
use crate::constants::CONFIG_SEED;
use crate::error::MeridianError;
use crate::events::GovernanceReset;
use crate::state::Config;

#[derive(Accounts)]
pub struct ResetGovernance<'info> {
    /// The BPF upgrade authority of THIS program. Proven below via
    /// `program_data.upgrade_authority_address`, never by comparison to any
    /// Config field.
    pub upgrade_authority: Signer<'info>,

    /// This program's executable account; Anchor resolves its ProgramData
    /// address from the upgradeable-loader header so the `program_data`
    /// account cannot be substituted with a different program's.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ MeridianError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::Meridian>,

    #[account(constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ MeridianError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

pub fn handler(ctx: Context<ResetGovernance>, new_governance: Pubkey) -> Result<()> {
    require!(new_governance != Pubkey::default(), MeridianError::InvalidGovernanceKey);
    let c = &mut ctx.accounts.config;
    let previous = c.governance;
    c.governance = new_governance;
    // A pending proposal from the lost key is meaningless now; clear it so the
    // old chain of custody cannot complete a rotation the new key never saw.
    c.pending_governance = Pubkey::default();
    emit!(GovernanceReset {
        previous,
        new_governance,
        upgrade_authority: ctx.accounts.upgrade_authority.key(),
    });
    Ok(())
}
