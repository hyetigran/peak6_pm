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
