use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub governance: Pubkey,
    pub quote_mint: Pubkey,
    pub openbook_program_id: Pubkey,
}

#[event]
pub struct RoleRotationProposed {
    pub role: u8, // 0 gov,1 operator,2 pause,3 override
    pub pending: Pubkey,
}

#[event]
pub struct RoleRotationAccepted {
    pub role: u8,
    pub new_key: Pubkey,
}

/// ADR-0038 one-shot governance recovery by the program upgrade authority.
#[event]
pub struct GovernanceReset {
    pub previous: Pubkey,
    pub new_governance: Pubkey,
    pub upgrade_authority: Pubkey,
}

#[event]
pub struct GlobalPauseSet {
    pub paused: bool,
}

#[event]
pub struct OutcomeMarketCreated {
    pub market: Pubkey,
    pub ticker_id: u8,
    pub trading_day: u32,
    pub strike_1e6: u64,
    pub settlement_record: Pubkey,
}

/// `close_venue` reclaimed the OpenBook market/book/EventHeap rent (ADR-0027).
#[event]
pub struct VenueClosed {
    pub market: Pubkey,
    pub openbook_market: Pubkey,
    pub refund_address: Pubkey,
    pub lamports_reclaimed: u64,
}
