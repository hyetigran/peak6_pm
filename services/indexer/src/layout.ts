/** Byte-exact decoders for Meridian Anchor accounts (offsets match the Rust
 * struct field order; each Anchor account has an 8-byte discriminator). */
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";

export const acctDisc = (name: string): Buffer =>
  createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);

export const TICKER = ["Invalid", "AAPL", "AMZN", "GOOGL", "META", "MSFT", "NVDA", "TSLA"];
export const STATE = ["Uninitialized", "Created", "Active", "Settled", "Abandoned"];
export const OUTCOME = ["Unset", "Yes", "No"];

class Cursor {
  off = 8; // skip discriminator
  constructor(public d: Buffer) {}
  u8() { return this.d.readUInt8(this.off++); }
  bool() { return this.u8() === 1; }
  u16() { const v = this.d.readUInt16LE(this.off); this.off += 2; return v; }
  u32() { const v = this.d.readUInt32LE(this.off); this.off += 4; return v; }
  u64() { const v = this.d.readBigUInt64LE(this.off); this.off += 8; return v; }
  i64() { const v = this.d.readBigInt64LE(this.off); this.off += 8; return v; }
  pk() { const v = new PublicKey(this.d.subarray(this.off, this.off + 32)); this.off += 32; return v; }
  skip(n: number) { this.off += n; }
}

export interface OutcomeMarketRow {
  pubkey: string; tickerId: number; ticker: string; tradingDay: number;
  strike1e6: string; mintOpenTs: number; tradeOpenTs: number; closeTs: number;
  state: number; stateName: string; activityStarted: boolean; paused: boolean;
  emergencyExpired: boolean; settlementPrice1e6: string; outcome: number; outcomeName: string;
  settledTs: number; settlementRecord: string; yesMint: string; noMint: string;
  collateralVault: string; openbookMarket: string; bids: string; asks: string;
  eventHeap: string; openbookBaseVault: string; openbookQuoteVault: string;
  collateralLiabilityAtoms: string;
}

export function decodeOutcomeMarket(pubkey: string, d: Buffer): OutcomeMarketRow {
  const c = new Cursor(d);
  c.skip(2); // schema_version, bump
  const tickerId = c.u8();
  const tradingDay = c.u32();
  const strike = c.u64();
  const mintOpenTs = Number(c.i64()), tradeOpenTs = Number(c.i64()), closeTs = Number(c.i64());
  const state = c.u8();
  const activityStarted = c.bool();
  const paused = c.bool();
  c.u8(); // permanent_pause
  c.u16(); // permanent_pause_reason
  const emergencyExpired = c.bool();
  c.i64(); // emergency_expired_ts
  c.u16(); // emergency_reason_code
  const settlementPrice = c.u64();
  const outcome = c.u8();
  const settledTs = Number(c.i64());
  const settlementRecord = c.pk();
  c.skip(32); // settlement_record_digest
  c.u8(); // manual_settled
  const yesMint = c.pk(), noMint = c.pk(), collateralVault = c.pk();
  c.pk(); // program_yes_trade_ata
  const openbookMarket = c.pk();
  c.pk(); // openbook_market_authority
  const bids = c.pk(), asks = c.pk(), eventHeap = c.pk();
  const openbookBaseVault = c.pk(), openbookQuoteVault = c.pk();
  c.u8(); // venue_market_authority_bump
  c.skip(32); // metadata_manifest
  c.pk(); c.pk(); // rent refunds
  const liability = c.u64();
  return {
    pubkey, tickerId, ticker: TICKER[tickerId] ?? "?", tradingDay,
    strike1e6: strike.toString(), mintOpenTs, tradeOpenTs, closeTs,
    state, stateName: STATE[state] ?? "?", activityStarted, paused, emergencyExpired,
    settlementPrice1e6: settlementPrice.toString(), outcome, outcomeName: OUTCOME[outcome] ?? "?",
    settledTs, settlementRecord: settlementRecord.toBase58(),
    yesMint: yesMint.toBase58(), noMint: noMint.toBase58(), collateralVault: collateralVault.toBase58(),
    openbookMarket: openbookMarket.toBase58(), bids: bids.toBase58(), asks: asks.toBase58(),
    eventHeap: eventHeap.toBase58(), openbookBaseVault: openbookBaseVault.toBase58(),
    openbookQuoteVault: openbookQuoteVault.toBase58(),
    collateralLiabilityAtoms: liability.toString(),
  };
}

/** OpenBook V2 BookSide decoder (pinned v1.7). Each bids/asks account holds a
 * full BookSide; every LeafNode is one resting order on that side. Layout:
 * disc(8) + roots[2]*8 + reserved_roots[4]*8 + reserved[256] +
 * OrderTreeNodes header(528) -> nodes[1024] each 88 bytes.
 * LeafNode: tag@0(==2), key u128@8 (price = high 64 bits), quantity i64@56.
 * With base_lot=1e6, quote_lot=1e4, 6-dp tokens: price_lots == cents,
 * quantity_lots == whole shares. */
const BOOK_NODES_OFFSET = 8 + 16 + 32 + 256 + 528; // 840
const NODE_SIZE = 88;
const MAX_NODES = 1024;
const LEAF_TAG = 2;

export interface BookLevel { price: number; shares: number }

export function decodeBookSide(data: Buffer): { price: number; shares: number }[] {
  const leaves: { price: number; shares: number }[] = [];
  for (let i = 0; i < MAX_NODES; i++) {
    const off = BOOK_NODES_OFFSET + i * NODE_SIZE;
    if (off + NODE_SIZE > data.length) break;
    if (data[off] !== LEAF_TAG) continue;
    const price = Number(data.readBigUInt64LE(off + 16)); // high 64 bits of key
    const shares = Number(data.readBigInt64LE(off + 56));
    if (shares > 0) leaves.push({ price, shares });
  }
  return leaves;
}

/** Aggregate leaves into price levels; sort bids desc, asks asc. */
export function ladder(leaves: { price: number; shares: number }[], side: "bid" | "ask"): BookLevel[] {
  const by = new Map<number, number>();
  for (const l of leaves) by.set(l.price, (by.get(l.price) ?? 0) + l.shares);
  const levels = [...by.entries()].map(([price, shares]) => ({ price, shares }));
  levels.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
  return levels;
}
