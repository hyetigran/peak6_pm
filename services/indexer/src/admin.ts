/**
 * Admin/operator actions for the localnet demo Ops console. The demo operator
 * and pause-authority (governance) keypairs live in .demo-config.json (written
 * by seed-demo.ts); these helpers sign with them. On a real deployment these
 * roles are cold/multisig keys and this path would not exist.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";

const MERIDIAN_PID = new PublicKey("HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD");
const HARNESS_PID = new PublicKey("3MmdMxRUF4NWPNdwoQcLhoqfmiKReoaSQR9GwSeQEpRr");
const CONFIG_PAUSED_OFFSET = 332; // 8 disc + 2 + 8*32 roles + 32 + 32 + 1 + 1

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };

const configPda = () => PublicKey.findProgramAddressSync([Buffer.from("config")], MERIDIAN_PID)[0];
const settlementRecordPda = (ticker: number, day: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("settlement_record"), Buffer.from([ticker]), u32(day)], MERIDIAN_PID)[0];

type DemoCfg = { governance: number[]; operator: number[]; transports?: Record<string, string> };
function loadCfg(): DemoCfg {
  return JSON.parse(fs.readFileSync(process.env.DEMO_CONFIG ?? ".demo-config.json", "utf8"));
}
const kp = (secret: number[]) => Keypair.fromSecretKey(Uint8Array.from(secret));

/** Read Config.paused live from chain. */
export async function readPaused(conn: Connection): Promise<boolean> {
  const info = await conn.getAccountInfo(configPda());
  if (!info) return false;
  return info.data[CONFIG_PAUSED_OFFSET] === 1;
}

/** set_global_pause(paused) — signed by the pause authority (governance in demo). */
export async function setGlobalPause(conn: Connection, paused: boolean): Promise<string> {
  const gov = kp(loadCfg().governance);
  const ix = new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: gov.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc("set_global_pause"), Buffer.from([paused ? 1 : 0])]),
  });
  return sendAndConfirmTransaction(conn, new Transaction().add(ix), [gov], { commitment: "confirmed" });
}

export interface SettleRow {
  ticker_id: number; trading_day: number; strike_1e6: string; close_ts: number;
  settled_ts: number; settlement_record: string; pubkey: string;
}

/**
 * Settle one Outcome Market: finalize the shared Settlement Record (if not
 * already final) at `close1e6`, then settle_market to derive the winner.
 * Signed by the operator. Requires the market to be past close_ts.
 */
export async function settleMarket(conn: Connection, row: SettleRow, close1e6: bigint): Promise<{ sig: string; finalized: boolean }> {
  const cfg = loadCfg();
  const op = kp(cfg.operator);
  const now = Math.floor(Date.now() / 1000);
  if (now < row.close_ts) throw new Error(`market not closed yet (closes in ${row.close_ts - now}s)`);

  const record = settlementRecordPda(row.ticker_id, row.trading_day);
  const recInfo = await conn.getAccountInfo(record);
  const pending = !recInfo || recInfo.data[8] === 0; // SettlementRecordState::Pending
  let finalized = false;

  if (pending) {
    const feedB58 = cfg.transports?.[String(row.ticker_id)];
    if (!feedB58) throw new Error(`no transport feed recorded for ticker ${row.ticker_id}; re-seed the demo`);
    const feed = new PublicKey(feedB58);
    const slot = BigInt(await conn.getSlot("confirmed"));
    // publish the Official Close to the harness mock feed; Meridian reads it back
    const publishIx = new TransactionInstruction({
      programId: HARNESS_PID,
      keys: [
        { pubkey: op.publicKey, isSigner: true, isWritable: true },
        { pubkey: feed, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("publish_mock_feed"), Buffer.from([row.ticker_id]), u64(close1e6)]),
    });
    await sendAndConfirmTransaction(conn, new Transaction().add(publishIx), [op], { commitment: "confirmed" });
    const finalizeIx = new TransactionInstruction({
      programId: MERIDIAN_PID,
      keys: [
        { pubkey: op.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda(), isSigner: false, isWritable: false },
        { pubkey: record, isSigner: false, isWritable: true },
        { pubkey: feed, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("finalize_settlement_normal"), u64(close1e6), Buffer.from([1]),
        i64(BigInt(now)), u64(slot), Buffer.from([3]), Buffer.alloc(32, 9)]),
    });
    await sendAndConfirmTransaction(conn, new Transaction().add(finalizeIx), [op], { commitment: "confirmed" });
    finalized = true;
  }

  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(settleMarketIx(op.publicKey, row.pubkey, record)), [op], { commitment: "confirmed" });
  return { sig, finalized };
}

function settleMarketIx(cranker: PublicKey, market: string, record: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: cranker, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(market), isSigner: false, isWritable: true },
      { pubkey: record, isSigner: false, isWritable: false },
    ],
    data: disc("settle_market"),
  });
}

/**
 * Manual Settlement Override: finalize the record via the Override Authority
 * (governance in demo) with two equal evidenced values, then settle. Used when
 * the oracle path is unavailable. Gated on-chain by the override delay.
 */
export async function overrideSettle(conn: Connection, row: SettleRow, close1e6: bigint, reasonCode = 1): Promise<{ sig: string; finalized: boolean }> {
  const cfg = loadCfg();
  const gov = kp(cfg.governance); // override authority in demo
  const op = kp(cfg.operator);
  const now = Math.floor(Date.now() / 1000);
  if (now < row.close_ts) throw new Error(`market not closed yet (closes in ${row.close_ts - now}s)`);

  const record = settlementRecordPda(row.ticker_id, row.trading_day);
  const recInfo = await conn.getAccountInfo(record);
  const pending = !recInfo || recInfo.data[8] === 0;
  let finalized = false;

  if (pending) {
    const finalizeIx = new TransactionInstruction({
      programId: MERIDIAN_PID,
      keys: [
        { pubkey: gov.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda(), isSigner: false, isWritable: false },
        { pubkey: record, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([disc("finalize_settlement_manual"), u64(close1e6), u64(close1e6), u16(reasonCode), Buffer.alloc(32, 0x0d)]),
    });
    await sendAndConfirmTransaction(conn, new Transaction().add(finalizeIx), [gov], { commitment: "confirmed" });
    finalized = true;
  }

  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(settleMarketIx(op.publicKey, row.pubkey, record)), [op], { commitment: "confirmed" });
  return { sig, finalized };
}
