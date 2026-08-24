/**
 * Pure scheduler core for the production keeper (#19, ADR-0031/ADR-0035).
 *
 * The demo keeper is a per-second `setInterval` poll (a localnet affordance).
 * In prod the daily lifecycle (PRD §5) fixes the times, so automation is two
 * time-triggered jobs per trading day:
 *   - settlement  — fires at close_ts + normal_settlement_delay_secs
 *   - market-open — fires at resolution + 5m (ADR-0032), chained off settlement
 *
 * This module is the substrate-agnostic core (no RPC, no clock, no I/O): it
 * plans fire times from indexer market data, selects what is due, computes
 * backoff, and holds the run-ledger that makes duplicate/retried fires no-ops.
 * On-chain idempotency (ADR-0031/0023) is the real guarantee; this ledger is
 * the belt that also avoids wasted duplicate transactions (PRODUCTION_INFRA §3).
 */

export type JobKind = "settlement" | "market-open";

export interface JobKey { kind: JobKind; day: number; tickerId: number }
export interface ScheduledJob extends JobKey { fireAtMs: number }

/** Chained market-open offset after resolution (ADR-0032: next session at resolution+5m). */
export const MARKET_OPEN_AFTER_RESOLUTION_SECS = 300;

/** Backoff for a retrying job (feed-not-yet-published, transient submit failure). */
const BACKOFF_BASE_MS = 30_000; // 30s
const BACKOFF_CAP_MS = 15 * 60_000; // 15m — a settlement waiting on the Official Close should not spin

export const jobId = (k: JobKey): string => `${k.kind}:${k.day}:${k.tickerId}`;

/** Minimal shape the scheduler needs from an indexer market row. */
export interface MarketRow {
  ticker_id: number;
  trading_day: number;
  close_ts: number;
  normal_settlement_delay_secs: number;
  settled_ts?: number | null;
  // Indexer fields the EventHeap crank path (#20) uses; absent on the pure
  // scheduling path, present on the /markets projection.
  pubkey?: string;
  ticker?: string;
  event_heap?: string;
  openbook_market?: string;
  bids?: string;
  asks?: string;
  // Pre-open re-validation gate (#21) fields.
  state_name?: string;
  activity_started?: number | boolean;
  mint_open_ts?: number;
  yes_mint?: string;
  no_mint?: string;
}

export const settlementFireAtMs = (m: MarketRow): number =>
  (m.close_ts + m.normal_settlement_delay_secs) * 1000;

export const marketOpenFireAtMs = (resolutionMs: number): number =>
  resolutionMs + MARKET_OPEN_AFTER_RESOLUTION_SECS * 1000;

/** One settlement job per unsettled (ticker, day); the SettlementRecord is shared,
 *  so a per-market job would collide — the fire time is the earliest close in the group. */
export function planJobs(markets: MarketRow[]): ScheduledJob[] {
  const byKey = new Map<string, ScheduledJob>();
  for (const m of markets) {
    if (m.settled_ts) continue;
    const key: JobKey = { kind: "settlement", day: m.trading_day, tickerId: m.ticker_id };
    const id = jobId(key);
    const fireAtMs = settlementFireAtMs(m);
    const existing = byKey.get(id);
    if (!existing || fireAtMs < existing.fireAtMs) byKey.set(id, { ...key, fireAtMs });
  }
  return [...byKey.values()];
}

/** Exponential backoff (base * 2^(attempt-1)), capped. attempt is 1-based. */
export function backoffMs(attempt: number): number {
  const raw = BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(BACKOFF_CAP_MS, raw);
}

// --- run-ledger (durable when persisted; pure here) ---

export interface Ledger {
  completed: Record<string, number>; // jobId -> completed-at ms (audit trail)
  attempts: Record<string, { count: number; nextAtMs: number }>;
}

export const newLedger = (): Ledger => ({ completed: {}, attempts: {} });

export const isCompleted = (l: Ledger, k: JobKey): boolean => l.completed[jobId(k)] != null;

export function markCompleted(l: Ledger, k: JobKey, atMs = 0): void {
  const id = jobId(k);
  l.completed[id] = l.completed[id] ?? atMs;
  delete l.attempts[id];
}

/** Record a retry: bump the attempt count and set the next-eligible time from now. */
export function recordRetry(l: Ledger, k: JobKey, nowMs: number): void {
  const id = jobId(k);
  const count = (l.attempts[id]?.count ?? 0) + 1;
  l.attempts[id] = { count, nextAtMs: nowMs + backoffMs(count) };
}

/** Market-open jobs (ADR-0032, resolution+5m) chained off each COMPLETED
 *  settlement in the ledger — this is how market-open reaches the schedule
 *  ("off the settlement job's completion", PRODUCTION_INFRA §2). A market-open
 *  already completed is not re-emitted. */
export function marketOpenJobsFromLedger(l: Ledger): ScheduledJob[] {
  const jobs: ScheduledJob[] = [];
  for (const [id, completedAtMs] of Object.entries(l.completed)) {
    const [kind, day, tickerId] = id.split(":");
    if (kind !== "settlement") continue;
    const key: JobKey = { kind: "market-open", day: Number(day), tickerId: Number(tickerId) };
    if (isCompleted(l, key)) continue;
    jobs.push({ ...key, fireAtMs: marketOpenFireAtMs(completedAtMs) });
  }
  return jobs;
}

/** Jobs whose fire time has arrived, not completed, and not currently backing off. */
export function dueJobs(jobs: ScheduledJob[], nowMs: number, l: Ledger): ScheduledJob[] {
  return jobs.filter((j) => {
    if (j.fireAtMs > nowMs) return false;
    if (isCompleted(l, j)) return false;
    const a = l.attempts[jobId(j)];
    if (a && a.nextAtMs > nowMs) return false;
    return true;
  });
}
