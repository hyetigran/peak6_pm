use anchor_lang::prelude::*;

#[error_code]
pub enum MeridianError {
    #[msg("Config is globally paused")]
    ConfigPaused,
    #[msg("signer is not the required role")]
    Unauthorized,
    #[msg("no pending role rotation to accept")]
    NoPendingRotation,
    #[msg("ticker is not supported")]
    UnsupportedTicker,
    #[msg("quote mint is not the pinned six-decimal SPL mint")]
    WrongQuoteMint,
    #[msg("supplied OpenBook program does not match the pinned identity")]
    WrongOpenbookProgram,
    #[msg("strike must be a positive multiple of $10")]
    InvalidStrike,
    #[msg("prior official close must be positive")]
    InvalidPriorClose,
    #[msg("invalid market schedule (mint/trade/close ordering or lead time)")]
    InvalidSchedule,
    #[msg("Outcome Market is not in the required state")]
    WrongMarketState,
    #[msg("Venue Market already attached")]
    VenueAlreadyAttached,
    #[msg("Venue Market not attached")]
    VenueNotAttached,
    #[msg("permanent metadata must be published and verified before minting")]
    MetadataUnset,
    #[msg("abandonment unavailable: activity has started or state is non-empty")]
    CannotAbandon,
    #[msg("SettlementRecord header does not match the bound market")]
    SettlementHeaderMismatch,
    #[msg("SettlementRecord already finalized")]
    AlreadyFinalized,
    #[msg("settlement not yet permitted (delay not elapsed)")]
    SettlementTooEarly,
    #[msg("manual override requires two equal evidenced values")]
    OverrideValuesUnequal,
    #[msg("order rejected: market not in its trading window or paused")]
    TradingClosed,
    #[msg("Market Action did not fill fully; reverting")]
    PartialFillReverted,
    #[msg("order was not posted (PostOnly would cross, or expiry passed)")]
    OrderNotPosted,
    #[msg("V1 limit orders must be PostOnly with AbortTransaction self-trade")]
    InvalidLimitOrder,
    #[msg("collateral vault or liability invariant violated")]
    CollateralInvariant,
    #[msg("rent may only go to the snapshotted Rent Refund Address")]
    WrongRefundDestination,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("settlement delivery feed is not owned by the pinned oracle program")]
    WrongDeliveryOwner,
}
