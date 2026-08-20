use anchor_lang::prelude::*;
use crate::constants::CONFIG_SEED;
use crate::error::MeridianError;
use crate::events::GlobalPauseSet;
use crate::state::Config;

#[derive(Accounts)]
pub struct SetGlobalPause<'info> {
    #[account(address = config.pause_authority @ MeridianError::Unauthorized)]
    pub pause_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

pub fn handler(ctx: Context<SetGlobalPause>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    emit!(GlobalPauseSet { paused });
    Ok(())
}
