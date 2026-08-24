/**
 * Wire-format golden for the keeper's venue-close builders (ADR-0027). Locks
 * discriminators and account order/flags against the program's
 * PruneVenueOrders / CloseVenue contexts. Pure (no validator).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  pruneVenueOrdersIx, closeVenueIx, configPda, MERIDIAN_PID, OPENBOOK_PID,
  OUTCOME_MARKET_VENUE_RENT_REFUND, OUTCOME_MARKET_VENUE_CLOSED_TS, MARKET_BASE_DEPOSIT_TOTAL, MARKET_QUOTE_DEPOSIT_TOTAL,
} from "../services/keeper/src/ix.js";
import * as sdk from "@meridian/sdk/meridian";

const disc = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const k = () => Keypair.generate().publicKey;

test("pruneVenueOrdersIx: discriminator + u8 limit; config, market(ro), ob market, oo, bids, asks (w), program", () => {
  const o = { market: k(), obMarket: k(), ooAccount: k(), bids: k(), asks: k(), limit: 7 };
  const ix = pruneVenueOrdersIx(o);
  assert.ok(ix.programId.equals(MERIDIAN_PID));
  assert.deepEqual(Uint8Array.from(ix.data), Uint8Array.from(Buffer.concat([disc("prune_venue_orders"), Buffer.from([7])])));
  const keys = ix.keys.map((x) => [x.pubkey.toBase58(), x.isSigner, x.isWritable]);
  assert.deepEqual(keys, [
    [configPda().toBase58(), false, false], [o.market.toBase58(), false, false], [o.obMarket.toBase58(), false, true],
    [o.ooAccount.toBase58(), false, true], [o.bids.toBase58(), false, true], [o.asks.toBase58(), false, true],
    [OPENBOOK_PID.toBase58(), false, false],
  ]);
  assert.equal(pruneVenueOrdersIx({ ...o, limit: undefined }).data[8], 255, "default limit 255");
});

test("closeVenueIx: discriminator only; market/ob/bids/asks/heap/destination writable, no signer", () => {
  const o = { market: k(), obMarket: k(), bids: k(), asks: k(), eventHeap: k(), solDestination: k() };
  const ix = closeVenueIx(o);
  assert.deepEqual(Uint8Array.from(ix.data), Uint8Array.from(disc("close_venue")));
  assert.equal(ix.keys.filter((x) => x.isSigner).length, 0, "permissionless: no signer in the context");
  const w = ix.keys.filter((x) => x.isWritable).map((x) => x.pubkey.toBase58());
  assert.deepEqual(w, [o.market, o.obMarket, o.bids, o.asks, o.eventHeap, o.solDestination].map((p) => p.toBase58()));
  assert.equal(ix.keys[7].pubkey.toBase58(), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  assert.ok(ix.keys[8].pubkey.equals(OPENBOOK_PID));
});

test("keeper and SDK builders agree byte-for-byte; layout offsets match the SDK", () => {
  const o = { market: k(), obMarket: k(), bids: k(), asks: k(), eventHeap: k(), solDestination: k(), ooAccount: k() };
  const eq = (a: any, b: any) => assert.deepEqual(
    [Uint8Array.from(a.data), a.keys.map((x: any) => [x.pubkey.toBase58(), x.isSigner, x.isWritable])],
    [Uint8Array.from(b.data), b.keys.map((x: any) => [x.pubkey.toBase58(), x.isSigner, x.isWritable])]);
  eq(closeVenueIx(o), sdk.closeVenueIx(o));
  eq(pruneVenueOrdersIx(o), sdk.pruneVenueOrdersIx(o));
  assert.equal(OUTCOME_MARKET_VENUE_RENT_REFUND, sdk.OUTCOME_MARKET_VENUE_OFFSETS.VENUE_RENT_REFUND);
  assert.equal(OUTCOME_MARKET_VENUE_CLOSED_TS, sdk.OUTCOME_MARKET_VENUE_OFFSETS.VENUE_CLOSED_TS);
  // OutcomeMarket: ...liability(u64)@595 then venue_closed_ts@603 (state/market.rs), 667 total
  assert.equal(OUTCOME_MARKET_VENUE_CLOSED_TS + 8 + 56, 667);
  // OpenBook v1.7 Market: market_base_vault@640, base_deposit_total@672, market_quote_vault@680, quote_deposit_total@712
  assert.equal(MARKET_BASE_DEPOSIT_TOTAL, 640 + 32);
  assert.equal(MARKET_QUOTE_DEPOSIT_TOTAL, 680 + 32);
});
