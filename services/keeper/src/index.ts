/**
 * Meridian keeper — the automation loop the architecture assigns to the
 * operator: crank OpenBook EventHeaps and finalize+settle Outcome Markets at
 * close. On localnet the "oracle" is a mock spot feed maintained here (a small
 * random walk from a base price); on devnet this would read Switchboard. The
 * record CONTRACT the program enforces is identical either way.
 *
 * Runs from the repo root (uses root node_modules) via tsx. Signs with the
 * operator keypair in .demo-config.json (written by seed-demo.ts).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";

const HARNESS_PID = new PublicKey("3MmdMxRUF4NWPNdwoQcLhoqfmiKReoaSQR9GwSeQEpRr");
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const INDEXER = process.env.KEEPER_INDEXER ?? "http://127.0.0.1:8787";
const CONFIG = process.env.DEMO_CONFIG ?? ".demo-config.json";
const STATUS = process.env.KEEPER_STATUS ?? ".keeper-status.json";
const TICK = Number(process.env.KEEPER_TICK ?? "5") * 1000;

const MERIDIAN_PID = new PublicKey("FF6mu5FFb1q1Qz88x1HnhkePdF8Q1dXWnTfUUSkzUT3t");
const OPENBOOK_PID = new PublicKey("opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb");
const SYS = "11111111111111111111111111111111";
const EVENT_HEAP_COUNT_OFFSET = 12; // EventHeap header: count u16 @12
const NONE = { pubkey: OPENBOOK_PID, isSigner: false, isWritable: false };

const disc = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };

const configPda = () => PublicKey.findProgramAddressSync([Buffer.from("config")], MERIDIAN_PID)[0];
const settlementRecordPda = (ticker: number, day: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("settlement_record"), Buffer.from([ticker]), u32(day)], MERIDIAN_PID)[0];

// --- mock spot feed (localnet stand-in for Switchboard) ---
const SPOT_BASE: Record<string, number> = { AAPL: 231, AMZN: 241, GOOGL: 204, META: 682, MSFT: 512, NVDA: 178, TSLA: 349 };
const spot: Record<string, number> = {};
function tickSpot(sym: string): number {
  const cur = spot[sym] ?? SPOT_BASE[sym] ?? 100;
  spot[sym] = cur * (1 + (Math.random() - 0.5) * 0.004); // ±0.2% random walk
  return spot[sym];
}

function finalizeNormalIx(op: PublicKey, record: PublicKey, feed: PublicKey, close1e6: bigint, slot: bigint, now: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: MERIDIAN_PID,
    keys: [
      { pubkey: op, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: record, isSigner: false, isWritable: true },
      { pubkey: feed, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("finalize_settlement_normal"), u64(close1e6), Buffer.from([1]),
      i64(now), u64(slot), Buffer.from([3]), Buffer.alloc(32, 9)]),
  });
}
/** Publish the Official Close to the harness mock feed; Meridian reads it back. */
function publishMockFeedIx(payer: PublicKey, feed: PublicKey, tickerId: number, price1e6: bigint): TransactionInstruction {
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
function settleMarketIx(op: PublicKey, market: PublicKey, record: PublicKey): TransactionInstruction {
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
function consumeEventsIx(market: PublicKey, heap: PublicKey, limit: bigint, owners: PublicKey[]): TransactionInstruction {
  const data = Buffer.alloc(17);
  disc("consume_events").copy(data); data.writeBigUInt64LE(limit, 8); data[16] = 0;
  return new TransactionInstruction({
    programId: OPENBOOK_PID,
    keys: [NONE, { pubkey: market, isSigner: false, isWritable: true }, { pubkey: heap, isSigner: false, isWritable: true },
      ...owners.map((k) => ({ pubkey: k, isSigner: false, isWritable: true }))],
    data,
  });
}

async function getJson(path: string): Promise<any> {
  const r = await fetch(`${INDEXER}${path}`);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  const op = Keypair.fromSecretKey(Uint8Array.from(cfg.operator));
  const transports: Record<string, string> = cfg.transports ?? {};
  let ticks = 0, settledTotal = 0, eventsCranked = 0;
  const recent: string[] = []; // rolling activity log across ticks
  console.log(`[keeper] operator ${op.publicKey.toBase58()} · indexer ${INDEXER} · tick ${TICK / 1000}s`);

  const loop = async () => {
    ticks++;
    const actions: string[] = [];
    const status: any = { running: true, ts: Math.floor(Date.now() / 1000), operator: op.publicKey.toBase58(), ticks };
    try {
      const markets: any[] = (await getJson("/markets")).markets;
      const now = Math.floor(Date.now() / 1000);
      for (const sym of new Set(markets.map((m) => m.ticker))) tickSpot(sym as string);

      // 1) EventHeap keeper — drain filled events so maker positions settle.
      for (const m of markets) {
        if (!m.event_heap || m.event_heap === SYS) continue;
        const info = await conn.getAccountInfo(new PublicKey(m.event_heap));
        const count = info ? info.data.readUInt16LE(EVENT_HEAP_COUNT_OFFSET) : 0;
        if (count > 0) {
          try {
            const book = await getJson(`/book/${m.pubkey}`);
            const owners = [...new Set<string>([...(book.ask_owners ?? []), ...(book.bid_owners ?? [])])].map((o) => new PublicKey(o));
            await sendAndConfirmTransaction(conn, new Transaction().add(consumeEventsIx(new PublicKey(m.openbook_market), new PublicKey(m.event_heap), 8n, owners)), [op], { commitment: "confirmed" });
            eventsCranked += count;
            actions.push(`consumed ~${count} events on ${m.ticker} $${Number(m.strike_1e6) / 1e6}`);
          } catch (e) { actions.push(`consume ${m.ticker} failed: ${(e as Error).message.slice(0, 60)}`); }
        }
      }

      // 2) Settlement orchestration — finalize the shared record + settle at close.
      for (const m of markets) {
        if (m.settled_ts || now < m.close_ts || m.state_name === "Abandoned") continue;
        const feedB58 = transports[String(m.ticker_id)];
        if (!feedB58) { actions.push(`no transport feed for ${m.ticker}`); continue; }
        try {
          const record = settlementRecordPda(m.ticker_id, m.trading_day);
          const recInfo = await conn.getAccountInfo(record);
          const close1e6 = BigInt(Math.round((spot[m.ticker] ?? SPOT_BASE[m.ticker] ?? Number(m.strike_1e6) / 1e6) * 1e6));
          if (!recInfo || recInfo.data[8] === 0) { // Pending -> publish feed, then finalize once per ticker/day
            const feed = new PublicKey(feedB58);
            const slot = BigInt(await conn.getSlot("confirmed"));
            await sendAndConfirmTransaction(conn, new Transaction().add(publishMockFeedIx(op.publicKey, feed, m.ticker_id, close1e6)), [op], { commitment: "confirmed" });
            await sendAndConfirmTransaction(conn, new Transaction().add(finalizeNormalIx(op.publicKey, record, feed, close1e6, slot, BigInt(now))), [op], { commitment: "confirmed" });
          }
          await sendAndConfirmTransaction(conn, new Transaction().add(settleMarketIx(op.publicKey, new PublicKey(m.pubkey), record)), [op], { commitment: "confirmed" });
          settledTotal++;
          actions.push(`settled ${m.ticker} $${Number(m.strike_1e6) / 1e6} @ close $${(Number(close1e6) / 1e6).toFixed(2)}`);
        } catch (e) { actions.push(`settle ${m.ticker} failed: ${(e as Error).message.slice(0, 80)}`); }
      }

      if (actions.length) { recent.push(...actions); while (recent.length > 6) recent.shift(); }
      status.markets = markets.length;
      status.settled_total = settledTotal;
      status.events_cranked = eventsCranked;
      status.wallet_sol = +(await conn.getBalance(op.publicKey) / 1e9).toFixed(3);
      status.actions = recent.slice();
      if (actions.length) console.log(`[keeper] tick ${ticks}: ${actions.join(" | ")}`);
    } catch (e) {
      status.error = (e as Error).message;
      console.error(`[keeper] tick ${ticks} error:`, status.error);
    }
    try { fs.writeFileSync(STATUS, JSON.stringify(status)); } catch {}
  };

  await loop();
  setInterval(loop, TICK);
}
main().catch((e) => { console.error("[keeper] fatal:", e); process.exit(1); });
