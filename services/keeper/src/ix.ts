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
