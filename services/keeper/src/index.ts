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
import fs from "node:fs";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { runUntilStopped } from "./loop.js";
import { makeGetJson } from "./indexer.js";
import { loadKeeperConfig } from "./config.js";
import { buildOracleRefresh } from "./oracle.js";
import {
  EVENT_HEAP_COUNT_OFFSET, RECORD_OFFICIAL_CLOSE, SYS, settlementRecordPda,
  finalizeNormalIx, settleMarketIx, consumeEventsIx, makeSend,
} from "./ix.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const INDEXER = process.env.KEEPER_INDEXER ?? "http://127.0.0.1:8787";
const STATUS = process.env.KEEPER_STATUS ?? ".keeper-status.json";
const TICK = Number(process.env.KEEPER_TICK ?? "5") * 1000;
const PRIORITY_FEE_MICROLAMPORTS = Number(process.env.KEEPER_PRIORITY_FEE_MICROLAMPORTS ?? "1000");

// --- mock spot feed (localnet stand-in for the Pyth adapter) ---
const SPOT_BASE: Record<string, number> = { AAPL: 231, AMZN: 241, GOOGL: 204, META: 682, MSFT: 512, NVDA: 178, TSLA: 349 };
const spot: Record<string, number> = {};
function tickSpot(sym: string): number {
  const cur = spot[sym] ?? SPOT_BASE[sym] ?? 100;
  spot[sym] = cur * (1 + (Math.random() - 0.5) * 0.004); // ±0.2% random walk
  return spot[sym];
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const cfg = loadKeeperConfig(); // DEMO_CONFIG_JSON (cloud secret) or DEMO_CONFIG file
  const op = Keypair.fromSecretKey(Uint8Array.from(cfg.operator));
  const transports: Record<string, string> = cfg.transports ?? {};
  let ticks = 0, settledTotal = 0, eventsCranked = 0;
  const recent: string[] = []; // rolling activity log across ticks
  console.log(`[keeper] operator ${op.publicKey.toBase58()} · indexer ${INDEXER} · tick ${TICK / 1000}s`);

  // Priority-fee + retry submit (idempotent on-chain, so retry is safe).
  const send = makeSend(conn, op, PRIORITY_FEE_MICROLAMPORTS, (m) => console.warn(`[keeper] ${m}`));
  const getJson = makeGetJson(INDEXER);

  // Fresh Official Close into the delivery account before finalize — harness
  // mock (localnet) or the Pyth adapter (KEEPER_ORACLE=pyth, devnet). Shared
  // with the prod scheduler; returns the close actually delivered on-chain.
  const refresh = await buildOracleRefresh({ conn, op, send, mode: process.env.KEEPER_ORACLE, log: (m) => console.log(`[keeper] ${m}`) });

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
            delivered = await refresh(m.ticker_id, feed, Number(m.close_ts), close1e6);
            // close/slot/observed args are advisory — the program reads all of them from the feed.
            await send([finalizeNormalIx(op.publicKey, record, feed, close1e6, slot, 0n)]);
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
