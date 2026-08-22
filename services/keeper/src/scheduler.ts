/**
 * Production keeper (#19, ADR-0031/ADR-0035) — scheduler-driven, NOT the demo's
 * per-second poll. Two time-triggered jobs per trading day, driven by the
 * substrate-agnostic runner over a durable run-ledger:
 *
 *   settlement  (close_ts + normal_settlement_delay_secs): drain any residual
 *     EventHeap, refresh the delivery account (harness mock on localnet / Pyth
 *     adapter on devnet), finalize_settlement_normal, settle_market per market.
 *     If the Official Close is not yet published it returns `retry` and the
 *     runner backs off — it does not spin.
 *   market-open (resolution + 5m, ADR-0032): the generate→create→attach slot.
 *     The eligibility / Corporate-Action-Blackout gate is #21 (blocked on this)
 *     and the strike engine is PRD §6; this wires the scheduled hook and leaves
 *     the gate as the documented seam so #21 plugs straight in.
 *
 * Substrate: cron (or any at-least-once trigger) invokes this process; a
 * single-flight lock file prevents overlap; the run-ledger JSON de-dupes across
 * restarts. At-least-once is enough because every on-chain action is idempotent
 * (ADR-0031/0023). See PRODUCTION_INFRA §2.
 *
 * Localnet still uses index.ts (the poll). This entrypoint is the prod topology.
 */
import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  EVENT_HEAP_COUNT_OFFSET, RECORD_STATE, RECORD_OFFICIAL_CLOSE, SYS,
  settlementRecordPda, finalizeNormalIx, settleMarketIx, consumeEventsIx, makeSend,
} from "./ix.js";
import { makeGetJson } from "./indexer.js";
import { buildOracleRefresh } from "./oracle.js";
import { runScheduler, type JobHandler, type JobOutcome } from "./runner.js";
import { newLedger, planJobs, marketOpenJobsFromLedger, type Ledger, type MarketRow, type ScheduledJob } from "./schedule.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const INDEXER = process.env.KEEPER_INDEXER ?? "http://127.0.0.1:8787";
const CONFIG = process.env.DEMO_CONFIG ?? ".demo-config.json";
const LEDGER = process.env.KEEPER_LEDGER ?? ".keeper-ledger.json";
const LOCK = process.env.KEEPER_LOCK ?? ".keeper.lock";
// Poll cadence between scheduler ticks. MINUTES in prod (the job fire times, not
// the tick, drive work) — the default is far coarser than the demo's 5s poll.
const TICK_MS = Number(process.env.KEEPER_SCHED_TICK_SECS ?? "60") * 1000;
const PRIORITY_FEE = Number(process.env.KEEPER_PRIORITY_FEE_MICROLAMPORTS ?? "1000");
const ORACLE_MODE = process.env.KEEPER_ORACLE ?? "harness";
// Base price the localnet-harness scheduler publishes as the mock close (it has
// no live spot; prod runs KEEPER_ORACLE=pyth and ignores this).
const HARNESS_CLOSE_BASE: Record<number, bigint> = { 1: 231n, 2: 241n, 3: 204n, 4: 682n, 5: 512n, 6: 178n, 7: 349n };

/** Single-flight: atomic create-if-absent (O_EXCL). A stale lock (>10m) is
 *  reclaimed once; correctness never depends on this (on-chain idempotency does)
 *  — it only avoids wasted duplicate transactions. A scheduler lease replaces it
 *  in cloud. Returns true iff THIS process now owns the lock. */
function acquireLock(): boolean {
  const content = `${Date.now()} ${process.pid}`;
  try {
    fs.writeFileSync(LOCK, content, { flag: "wx" }); // wx: fail if it exists
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const prev = fs.readFileSync(LOCK, "utf8");
  const ts = Number(prev.split(" ")[0]);
  if (Number.isFinite(ts) && Date.now() - ts < 10 * 60_000) {
    throw new Error(`another keeper holds ${LOCK} (${prev.trim()}); refusing to double-run`);
  }
  fs.writeFileSync(LOCK, content); // reclaim a stale lock
  return true;
}
/** Release only if we still own it (never delete another live keeper's lock). */
function releaseLock(): void {
  try {
    if (fs.readFileSync(LOCK, "utf8").endsWith(` ${process.pid}`)) fs.unlinkSync(LOCK);
  } catch { /* already gone */ }
}

const loadLedger = (): Ledger => {
  try { return { ...newLedger(), ...JSON.parse(fs.readFileSync(LEDGER, "utf8")) }; }
  catch { return newLedger(); }
};
const saveLedger = (l: Ledger) => { try { fs.writeFileSync(LEDGER, JSON.stringify(l)); } catch (e) { console.error(`[keeper] ledger persist failed: ${(e as Error).message}`); } };

async function main() {
  acquireLock();
  const conn = new Connection(RPC, "confirmed");
  const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  const op = Keypair.fromSecretKey(Uint8Array.from(cfg.operator));
  const transports: Record<string, string> = cfg.transports ?? {};
  const send = makeSend(conn, op, PRIORITY_FEE, (m) => console.warn(`[keeper] ${m}`));
  const getJson = makeGetJson(INDEXER);
  const ledger = loadLedger();
  console.log(`[keeper] scheduler up · operator ${op.publicKey.toBase58()} · tick ${TICK_MS / 1000}s · oracle ${ORACLE_MODE}`);

  // Refresh the per-ticker delivery account before finalize — shared with the
  // demo loop. Harness mock on localnet; the Pyth adapter on devnet.
  const refresh = await buildOracleRefresh({ conn, op, send, mode: ORACLE_MODE, log: (m) => console.log(`[keeper] ${m}`) });

  const settlement: JobHandler = async (job: ScheduledJob): Promise<JobOutcome> => {
    const markets: MarketRow[] = (await getJson("/markets")).markets
      .filter((m: any) => m.ticker_id === job.tickerId && m.trading_day === job.day && !m.settled_ts);
    if (markets.length === 0) return { status: "done" }; // already settled elsewhere
    const feedB58 = transports[String(job.tickerId)];
    if (!feedB58) { console.warn(`[keeper] no transport feed for ticker ${job.tickerId}`); return { status: "retry", reason: "no feed configured" }; }
    const feed = new PublicKey(feedB58);
    const record = settlementRecordPda(job.tickerId, job.day);

    // 1) Drain any residual EventHeap before settling (settle requires empty heaps).
    for (const m of markets as any[]) {
      if (!m.event_heap || m.event_heap === SYS) continue;
      const info = await conn.getAccountInfo(new PublicKey(m.event_heap));
      const count = info ? info.data.readUInt16LE(EVENT_HEAP_COUNT_OFFSET) : 0;
      if (count > 0) {
        const book = await getJson(`/book/${m.pubkey}`);
        const owners = [...new Set<string>([...(book.ask_owners ?? []), ...(book.bid_owners ?? [])])].map((o) => new PublicKey(o));
        await send([consumeEventsIx(new PublicKey(m.openbook_market), new PublicKey(m.event_heap), 8n, owners)]);
      }
    }

    // 2) Finalize the shared record once, gated on the Official Close being
    //    available — reschedule with backoff (not spin) if it is not.
    const recInfo = await conn.getAccountInfo(record);
    if (!recInfo || recInfo.data[RECORD_STATE] === 0) {
      let delivered: bigint;
      try {
        delivered = await refresh(job.tickerId, feed, Number((markets[0] as any).close_ts), HARNESS_CLOSE_BASE[job.tickerId] ?? 100n);
      } catch (e) {
        return { status: "retry", reason: `Official Close not yet available: ${(e as Error).message.slice(0, 80)}` };
      }
      if (delivered <= 0n) return { status: "retry", reason: "delivery close is zero (not yet published)" };
      const slot = BigInt(await conn.getSlot("confirmed"));
      await send([finalizeNormalIx(op.publicKey, record, feed, delivered, slot, 0n)]);
    }

    // 3) Settle each market against the finalized record (idempotent per market).
    for (const m of markets as any[]) await send([settleMarketIx(op.publicKey, new PublicKey(m.pubkey), record)]);
    const close = (await conn.getAccountInfo(record))!.data.readBigUInt64LE(RECORD_OFFICIAL_CLOSE);
    console.log(`[keeper] settled ticker ${job.tickerId} day ${job.day} @ close $${(Number(close) / 1e6).toFixed(2)} (${markets.length} markets)`);
    return { status: "done" };
  };

  // Market-open job — genuinely scheduled at resolution+5m (marketOpenJobsFromLedger,
  // off each completed settlement, ADR-0032). The eligibility/Corporate-Action-
  // Blackout gate (#21, blocked on this) and the PRD §6 strike engine plug in
  // here; until then the slot fires once and completes (nothing to create yet).
  const marketOpen: JobHandler = async (job) => {
    console.log(`[keeper] market-open slot fired for day ${job.day} ticker ${job.tickerId} — eligibility gate is #21, strike engine is PRD §6`);
    return { status: "done" };
  };

  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { console.log(`[keeper] ${sig} — draining in-flight job, then exiting`); ac.abort(); });
  }

  await runScheduler({
    listJobs: async () => {
      const markets = (await getJson("/markets")).markets as MarketRow[];
      // settlement jobs from unsettled markets; market-open jobs chained off
      // each completed settlement (resolution+5m) — both genuinely scheduled.
      return [...planJobs(markets), ...marketOpenJobsFromLedger(ledger)];
    },
    handlers: { settlement, "market-open": marketOpen },
    ledger, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    tickMs: TICK_MS, persist: saveLedger, signal: ac.signal,
  });

  releaseLock();
  console.log("[keeper] scheduler stopped");
}

// On a fatal error, release the lock ONLY if we own it — never delete the
// lock of the keeper that beat us to it (acquireLock throws before we own one).
main().catch((e) => { releaseLock(); console.error("[keeper] scheduler fatal:", e); process.exit(1); });
