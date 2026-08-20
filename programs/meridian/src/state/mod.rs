pub mod config;
pub mod feed_version;
pub mod market;
pub mod settlement_record;

pub use config::*;
pub use feed_version::*;
pub use market::*;
pub use settlement_record::*;

use anchor_lang::prelude::*;

/// Canonical wire enums — permanent discriminants (ARCHITECTURE L452).
/// Declaration order is never serialized implicitly; explicit `u8` repr.
#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum TickerId {
    Invalid = 0,
    Aapl = 1,
    Amzn = 2,
    Googl = 3,
    Meta = 4,
    Msft = 5,
    Nvda = 6,
    Tsla = 7,
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketState {
    Uninitialized = 0,
    Created = 1,
    Active = 2,
    Settled = 3,
    Abandoned = 4,
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    Unset = 0,
    Yes = 1,
    No = 2,
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum SettlementRecordState {
    Pending = 0,
    FinalOracle = 1,
    FinalManual = 2,
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum HaltOrContingencyStatus {
    Invalid = 0,
    NormalOfficialClose = 1,
    OfficialCloseAfterHalt = 2,
    OfficialContingencyClose = 3,
}
