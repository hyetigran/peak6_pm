/**
 * Meridian keeper — the automation loop the architecture assigns to the
 * operator: crank OpenBook EventHeaps and finalize+settle Outcome Markets at
 * close. On localnet the "oracle" is a mock spot feed maintained here (a small
 * random walk from a base price); on devnet the Pyth adapter delivers the close (KEEPER_ORACLE=pyth). The
 * record CONTRACT the program enforces is identical either way.
 *
 * Runs from the repo root (uses root node_modules) via tsx. Signs with the
 * operator keypair in .demo-config.json (written by seed-demo.ts).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import { runUntilStopped, withRetry } from "./loop.js";

const HARNESS_PID = new PublicKey("3MmdMxRUF4NWPNdwoQcLhoqfmiKReoaSQR9GwSeQEpRr");
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const INDEXER = process.env.KEEPER_INDEXER ?? "http://127.0.0.1:8787";
const CONFIG = process.env.DEMO_CONFIG ?? ".demo-config.json";
const STATUS = process.env.KEEPER_STATUS ?? ".keeper-status.json";
const TICK = Number(process.env.KEEPER_TICK ?? "5") * 1000;
// Priority fee (microLamports/CU) prepended to every keeper tx — negligible on
// localnet, tune up via env on a congested cluster.
// SettlementRecord.official_close_1e6 (borsh; see state/settlement_record.rs)
const RECORD_OFFICIAL_CLOSE = 261;
const PRIORITY_FEE_MICROLAMPORTS = Number(process.env.KEEPER_PRIORITY_FEE_MICROLAMPORTS ?? "1000");

const MERIDIAN_PID = new PublicKey("HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD");
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

// --- mock spot feed (localnet stand-in for the Pyth adapter) ---
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

  // Every send sets a priority fee and retries transient failures with backoff;
  // retrying is safe because the actions are idempotent on-chain (settle/finalize
  // re-check state, consume is bounded).
  const send = (ixs: TransactionInstruction[]) =>
    withRetry(
      () => sendAndConfirmTransaction(
        conn,
        new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICROLAMPORTS }), ...ixs),
        [op], { commitment: "confirmed" },
      ),
      { retries: 2, baseMs: 400, onRetry: (a, e) => console.warn(`[keeper] send retry ${a}: ${(e as Error).message.slice(0, 60)}`) },
    );

  // How the per-ticker delivery account gets a fresh Official Close before
  // finalize. `harness` (localnet) writes the mock feed; `pyth` (devnet) pulls
  // Hermes -> posts a PriceUpdateV2 -> cranks the adapter that OWNS the delivery
  // account Meridian reads. Pyth deps are dynamically imported so localnet
  // doesn't load them. Capture policy (#26): KEEPER_PYTH_CAPTURE=at-close
  // (default; Hermes update AT close_ts, max_age sized to settlement time) or
  // `latest` (demo only — KEEPER_PYTH_MAX_AGE_SECS is large for the weekend-
  // stale demo; the strict build rejects a reading outside the close window).
  const ORACLE_MODE = process.env.KEEPER_ORACLE ?? "harness";
  const PYTH_CAPTURE = (process.env.KEEPER_PYTH_CAPTURE ?? "at-close") as import("./pyth-capture.js").CaptureMode;
  const PYTH_MAX_AGE = BigInt(process.env.KEEPER_PYTH_MAX_AGE_SECS ?? "604800");
  // `refresh` returns the close actually delivered on-chain (what finalize will
  // read) — in pyth mode that is the real Pyth price, NOT the advisory close1e6.
  const oracle: { refresh: (tickerId: number, close1e6: bigint, feed: PublicKey, closeTs: number) => Promise<bigint> } =
    await (async () => {
      if (ORACLE_MODE !== "pyth") {
        return { refresh: async (tickerId: number, close1e6: bigint, feed: PublicKey) => { await send([publishMockFeedIx(op.publicKey, feed, tickerId, close1e6)]); return close1e6; } };
      }
      const { PythSolanaReceiver } = await import("@pythnetwork/pyth-solana-receiver");
      const { HermesClient } = await import("@pythnetwork/hermes-client");
      const { buildPythCrankTxs } = await import("./pyth-crank.js");
      const { captureWindow } = await import("./pyth-capture.js");
      captureWindow({ closeTs: 0, now: 0, mode: PYTH_CAPTURE }); // fail fast on a bad KEEPER_PYTH_CAPTURE
      const wallet: any = { publicKey: op.publicKey, payer: op, signTransaction: async (t: any) => { t.sign([op]); return t; }, signAllTransactions: async (t: any[]) => { t.forEach((x) => x.sign([op])); return t; } };
      const receiver = new PythSolanaReceiver({ connection: conn, wallet });
      const hermes = new HermesClient("https://hermes.pyth.network");
      console.log(`[keeper] oracle = pyth (Hermes pull -> post -> adapter crank; capture=${PYTH_CAPTURE})`);
      return { refresh: async (tickerId: number, _close1e6: bigint, feed: PublicKey, closeTs: number) => {
        const w = captureWindow({ closeTs, now: Math.floor(Date.now() / 1000), mode: PYTH_CAPTURE, latestMaxAgeSecs: PYTH_MAX_AGE });
        const txs = await buildPythCrankTxs({ receiver, hermes, cranker: op.publicKey, tickerId, maxAgeSecs: w.maxAgeSecs, publishTime: w.publishTime });
        for (const { tx, signers } of txs) { tx.sign([op, ...signers]); await conn.confirmTransaction(await conn.sendTransaction(tx), "confirmed"); }
        const info = await conn.getAccountInfo(feed);
        if (!info) throw new Error("pyth: delivery account not written");
        return info.data.readBigUInt64LE(8); // official_close_1e6 the adapter delivered
      } };
    })();

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
            await send([consumeEventsIx(new PublicKey(m.openbook_market), new PublicKey(m.event_heap), 8n, owners)]);
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
          let delivered = close1e6;
          if (!recInfo || recInfo.data[8] === 0) { // Pending -> publish feed, then finalize once per ticker/day
            const feed = new PublicKey(feedB58);
            const slot = BigInt(await conn.getSlot("confirmed"));
            // Refresh the delivery account (mock feed on localnet, real Pyth on
            // devnet), then finalize — Meridian READS the close from that feed.
            delivered = await oracle.refresh(m.ticker_id, close1e6, feed, Number(m.close_ts));
            await send([finalizeNormalIx(op.publicKey, record, feed, close1e6, slot, BigInt(now))]);
          } else {
            delivered = recInfo.data.readBigUInt64LE(RECORD_OFFICIAL_CLOSE); // already finalized this ticker/day
          }
          await send([settleMarketIx(op.publicKey, new PublicKey(m.pubkey), record)]);
          settledTotal++;
          actions.push(`settled ${m.ticker} $${Number(m.strike_1e6) / 1e6} @ close $${(Number(delivered) / 1e6).toFixed(2)}`);
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

  // Self-scheduling, non-overlapping loop (never re-enter a tick that is still
  // running) with graceful shutdown so an in-flight tick finishes before exit.
  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { console.log(`[keeper] ${sig} — finishing the current tick, then exiting`); ac.abort(); });
  }
  await runUntilStopped(loop, TICK, ac.signal);
  try { fs.writeFileSync(STATUS, JSON.stringify({ running: false, ts: Math.floor(Date.now() / 1000), operator: op.publicKey.toBase58(), ticks, settled_total: settledTotal, events_cranked: eventsCranked })); } catch {}
  console.log("[keeper] stopped");
}
main().catch((e) => { console.error("[keeper] fatal:", e); process.exit(1); });
