//! Two-step role rotation (ADR-0024): governance proposes, the incoming key
//! accepts. Operational roles cannot rotate themselves.

use anchor_lang::prelude::*;
use crate::constants::CONFIG_SEED;
use crate::error::MeridianError;
use crate::events::{RoleRotationAccepted, RoleRotationProposed};
use crate::state::Config;

#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub enum Role {
    Governance,
    Operator,
    PauseAuthority,
    OverrideAuthority,
}

impl Role {
    fn code(self) -> u8 {
        match self {
            Role::Governance => 0,
            Role::Operator => 1,
            Role::PauseAuthority => 2,
            Role::OverrideAuthority => 3,
        }
    }
}

#[derive(Accounts)]
pub struct ProposeRole<'info> {
    #[account(address = config.governance @ MeridianError::Unauthorized)]
    pub governance: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

pub fn propose(ctx: Context<ProposeRole>, role: Role, pending: Pubkey) -> Result<()> {
    let c = &mut ctx.accounts.config;
    match role {
        Role::Governance => c.pending_governance = pending,
        Role::Operator => c.pending_operator = pending,
        Role::PauseAuthority => c.pending_pause_authority = pending,
        Role::OverrideAuthority => c.pending_override_authority = pending,
    }
    emit!(RoleRotationProposed { role: role.code(), pending });
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptRole<'info> {
    pub incoming: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

pub fn accept(ctx: Context<AcceptRole>, role: Role) -> Result<()> {
    let c = &mut ctx.accounts.config;
    let who = ctx.accounts.incoming.key();
    let pending = match role {
        Role::Governance => c.pending_governance,
        Role::Operator => c.pending_operator,
        Role::PauseAuthority => c.pending_pause_authority,
        Role::OverrideAuthority => c.pending_override_authority,
    };
    require!(pending != Pubkey::default() && pending == who, MeridianError::NoPendingRotation);
    match role {
        Role::Governance => { c.governance = who; c.pending_governance = Pubkey::default(); }
        Role::Operator => { c.operator = who; c.pending_operator = Pubkey::default(); }
        Role::PauseAuthority => { c.pause_authority = who; c.pending_pause_authority = Pubkey::default(); }
        Role::OverrideAuthority => { c.override_authority = who; c.pending_override_authority = Pubkey::default(); }
    }
    emit!(RoleRotationAccepted { role: role.code(), new_key: who });
    Ok(())
}
