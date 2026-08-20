//! Hand-rolled OpenBook V2 v1.7 CPI adapter, generated from the MIT-licensed
//! IDL (`fixtures/openbook_v2_idl.json` at commit 796a470033bc) and account
//! layouts only — no GPL code. This module is itself G1 evidence that the
//! fallback adapter can be built from the MIT surface alone.
//!
//! Discriminators are anchor `sha256("global:<name>")[..8]`; each constant is
//! golden-tested from the instruction name in `tests/g2.test.ts`.

use anchor_lang::prelude::*;

/// `sha256("global:place_order")[..8]`
pub const DISC_PLACE_ORDER: [u8; 8] = [51, 194, 155, 175, 109, 130, 96, 106];
/// `sha256("global:place_take_order")[..8]`
pub const DISC_PLACE_TAKE_ORDER: [u8; 8] = [3, 44, 71, 3, 26, 199, 203, 85];
/// `sha256("global:set_market_expired")[..8]`
pub const DISC_SET_MARKET_EXPIRED: [u8; 8] = [219, 82, 219, 236, 60, 115, 197, 64];

/// IDL `Side`
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Bid,
    Ask,
}

/// IDL `PlaceOrderType`
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PlaceOrderType {
    Limit,
    ImmediateOrCancel,
    PostOnly,
    Market,
    PostOnlySlide,
}

/// IDL `SelfTradeBehavior`
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SelfTradeBehavior {
    DecrementTake,
    CancelProvide,
    AbortTransaction,
}

/// IDL `PlaceOrderArgs` — field order is the wire contract; do not reorder.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PlaceOrderArgs {
    pub side: Side,
    pub price_lots: i64,
    pub max_base_lots: i64,
    pub max_quote_lots_including_fees: i64,
    pub client_order_id: u64,
    pub order_type: PlaceOrderType,
    pub expiry_timestamp: u64,
    pub self_trade_behavior: SelfTradeBehavior,
    pub limit: u8,
}

/// IDL `PlaceTakeOrderArgs` — field order is the wire contract; do not reorder.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PlaceTakeOrderArgs {
    pub side: Side,
    pub price_lots: i64,
    pub max_base_lots: i64,
    pub max_quote_lots_including_fees: i64,
    pub order_type: PlaceOrderType,
    pub limit: u8,
}

pub fn ix_data<T: AnchorSerialize>(disc: [u8; 8], args: &T) -> Vec<u8> {
    let mut data = disc.to_vec();
    args.serialize(&mut data).expect("borsh serialize");
    data
}
