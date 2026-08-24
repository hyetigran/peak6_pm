/**
 * Shared Meridian/OpenBook instruction builders, PDAs, and the priority-fee +
 * retry submit path — used by BOTH the localnet demo loop (index.ts) and the
 * production scheduler (scheduler.ts) so the wire format lives in one place.
 */
import { createHash } from "node:crypto";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import { withRetry } from "./loop.js";

export const MERIDIAN_PID = new PublicKey("HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD");
export const OPENBOOK_PID = new PublicKey("opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb");
export const HARNESS_PID = new PublicKey("3MmdMxRUF4NWPNdwoQcLhoqfmiKReoaSQR9GwSeQEpRr");
export const SYS = "11111111111111111111111111111111";
export const EVENT_HEAP_COUNT_OFFSET = 12; // EventHeap header: count u16 @12
/** SettlementRecord.official_close_1e6 (borsh; see state/settlement_record.rs). */
export const RECORD_OFFICIAL_CLOSE = 261;
/** SettlementRecord.state (borsh discriminator + first byte). 0 == Pending. */
export const RECORD_STATE = 8;
/** Delivery-account official_close_1e6 offset (after the 8-byte header). */
export const DELIVERY_CLOSE_1E6 = 8;

const NONE = { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false };

export const disc = (n: string): Buffer => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
export const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const u64 = (n: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
export const i64 = (n: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };

export const configPda = (): PublicKey => PublicKey.findProgramAddressSync([Buffer.from("config")], MERIDIAN_PID)[0];
export const settlementRecordPda = (ticker: number, day: number): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("settlement_record"), Buffer.from([ticker]), u32(day)], MERIDIAN_PID)[0];

export function finalizeNormalIx(op: PublicKey, record: PublicKey, feed: PublicKey, close1e6: bigint, slot: bigint, observedTs: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: op, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: record, isSigner: false, isWritable: true },
      { pubkey: feed, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("finalize_settlement_normal"), u64(close1e6), Buffer.from([1]),
      i64(observedTs), u64(slot), Buffer.from([3]), Buffer.alloc(32, 9)]),
  });
}

/** Publish the Official Close to the harness mock feed (localnet); Meridian reads it back. */
export function publishMockFeedIx(payer: PublicKey, feed: PublicKey, tickerId: number, price1e6: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: HARNESS_PID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: feed, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("publish_mock_feed"), Buffer.from([tickerId]), u64(price1e6)]),
  });
}

export function settleMarketIx(op: PublicKey, market: PublicKey, record: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: op, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: record, isSigner: false, isWritable: false },
    ],
    data: disc("settle_market"),
  });
}

/** abandon_market: turn a Created/Active, empty, no-venue Outcome Market into an
 *  Abandoned tombstone (pre-open re-validation, #21/ADR-0022). Operator-signed. */
export function abandonMarketIx(op: PublicKey, market: PublicKey, yesMint: PublicKey, noMint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: op, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: yesMint, isSigner: false, isWritable: false },
      { pubkey: noMint, isSigner: false, isWritable: false },
    ],
    data: disc("abandon_market"),
  });
}

export function consumeEventsIx(market: PublicKey, heap: PublicKey, limit: bigint, owners: PublicKey[]): TransactionInstruction {
  const data = Buffer.alloc(17);
  disc("consume_events").copy(data); data.writeBigUInt64LE(limit, 8); data[16] = 0;
  return new TransactionInstruction({
    programId: OPENBOOK_PID,
    keys: [NONE, { pubkey: market, isSigner: false, isWritable: true }, { pubkey: heap, isSigner: false, isWritable: true },
      ...owners.map((k) => ({ pubkey: k, isSigner: false, isWritable: true }))],
    data,
  });
}

/** A submit that prepends a priority fee and retries transient failures with
 *  backoff. Safe to retry because every keeper action is idempotent on-chain
 *  (ADR-0031/0023): finalize/settle re-check state, consume is bounded. */
export function makeSend(conn: Connection, op: Keypair, priorityFeeMicroLamports: number, log: (m: string) => void = () => {}) {
  return (ixs: TransactionInstruction[]) =>
    withRetry(
      () => sendAndConfirmTransaction(
        conn,
        new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }), ...ixs),
        [op], { commitment: "confirmed" },
      ),
      { retries: 2, baseMs: 400, onRetry: (a, e) => log(`send retry ${a}: ${(e as Error).message.slice(0, 60)}`) },
    );
}

// --- Venue closure / rent recycling (ADR-0027) --------------------------
// Permissionless wrappers; the OutcomeMarket PDA signs as close_market_admin.

/** OutcomeMarket byte offsets (state/market.rs order) the close path reads. */
export const OUTCOME_MARKET_VENUE_RENT_REFUND = 563;
export const OUTCOME_MARKET_VENUE_CLOSED_TS = 603;
/** OpenBook v1.7 Market: deposit totals must be zero before close. */
export const MARKET_BASE_DEPOSIT_TOTAL = 672;
export const MARKET_QUOTE_DEPOSIT_TOTAL = 712;
/** OpenOrdersAccount: `market` pubkey at disc(8)+owner(32). */
export const OPEN_ORDERS_MARKET_OFFSET = 40;

export function pruneVenueOrdersIx(o: {
  market: PublicKey; obMarket: PublicKey; ooAccount: PublicKey; bids: PublicKey; asks: PublicKey; limit?: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: o.market, isSigner: false, isWritable: false },
      { pubkey: o.obMarket, isSigner: false, isWritable: true },
      { pubkey: o.ooAccount, isSigner: false, isWritable: true },
      { pubkey: o.bids, isSigner: false, isWritable: true },
      { pubkey: o.asks, isSigner: false, isWritable: true },
      { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("prune_venue_orders"), Buffer.from([o.limit ?? 255])]),
  });
}

export function closeVenueIx(o: {
  market: PublicKey; obMarket: PublicKey; bids: PublicKey; asks: PublicKey; eventHeap: PublicKey; solDestination: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: o.market, isSigner: false, isWritable: true },
      { pubkey: o.obMarket, isSigner: false, isWritable: true },
      { pubkey: o.bids, isSigner: false, isWritable: true },
      { pubkey: o.asks, isSigner: false, isWritable: true },
      { pubkey: o.eventHeap, isSigner: false, isWritable: true },
      { pubkey: o.solDestination, isSigner: false, isWritable: true },
      { pubkey: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), isSigner: false, isWritable: false },
      { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false },
    ],
    data: disc("close_venue"),
  });
}

/** Post-settlement rent recycling for one market (ADR-0027): prune every
 *  OpenOrders account's resting orders, then close the venue if no user
 *  deposits remain. Idempotent and safe to re-run: each step is re-proven on
 *  chain. Returns "closed", "already", or the reason it is still blocked
 *  (owners still hold OpenOrders balances — they withdraw via settle_funds). */
export async function reclaimVenue(opts: {
  conn: Connection; send: (ixs: TransactionInstruction[]) => Promise<unknown>;
  market: PublicKey; obMarket: PublicKey; bids: PublicKey; asks: PublicKey; eventHeap: PublicKey;
}): Promise<{ status: "closed" | "already" | "blocked"; reason?: string; lamports?: number }> {
  const { conn, send, market, obMarket, bids, asks, eventHeap } = opts;
  const mInfo = await conn.getAccountInfo(market);
  if (!mInfo) return { status: "blocked", reason: "market account missing" };
  if (mInfo.data.readBigInt64LE(OUTCOME_MARKET_VENUE_CLOSED_TS) !== 0n) return { status: "already" };
  const refund = new PublicKey(mInfo.data.subarray(OUTCOME_MARKET_VENUE_RENT_REFUND, OUTCOME_MARKET_VENUE_RENT_REFUND + 32));

  // 1) prune: every OpenOrders account bound to this venue (memcmp on market).
  const oos = await conn.getProgramAccounts(OPENBOOK_PID, {
    dataSlice: { offset: 0, length: 0 },
    filters: [{ memcmp: { offset: OPEN_ORDERS_MARKET_OFFSET, bytes: obMarket.toBase58() } }],
  });
  for (const oo of oos) await send([pruneVenueOrdersIx({ market, obMarket, ooAccount: oo.pubkey, bids, asks })]);

  // 2) deposits must be zero (the program re-checks; this just gives a reason).
  const ob = await conn.getAccountInfo(obMarket);
  if (!ob) return { status: "already" };
  const base = ob.data.readBigUInt64LE(MARKET_BASE_DEPOSIT_TOTAL), quote = ob.data.readBigUInt64LE(MARKET_QUOTE_DEPOSIT_TOTAL);
  if (base !== 0n || quote !== 0n) {
    return { status: "blocked", reason: `venue holds user deposits (base ${base}, quote ${quote}) across ${oos.length} OpenOrders — owners must settle_funds` };
  }
  const before = (await conn.getBalance(refund)) ?? 0;
  await send([closeVenueIx({ market, obMarket, bids, asks, eventHeap, solDestination: refund })]);
  const after = (await conn.getBalance(refund)) ?? 0;
  return { status: "closed", lamports: after - before };
}
