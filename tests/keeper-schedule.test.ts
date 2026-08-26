/**
 * Pure scheduler core for the production keeper (#19). No validator, no RPC —
 * the fire-time planning, due-selection, backoff, and run-ledger idempotency
 * that turn the demo's per-second poll into two scheduled jobs/day.
 * Run: pnpm exec tsx --test tests/keeper-schedule.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  jobId, settlementFireAtMs, marketOpenFireAtMs, planJobs, dueJobs, backoffMs,
  MARKET_OPEN_AFTER_RESOLUTION_SECS, newLedger, markCompleted, recordRetry, isCompleted, marketOpenJobsFromLedger,
  marketOpenJobsFromMarkets, mergeJobs, type MarketRow, type ScheduledJob,
} from "../services/keeper/src/schedule.js";

const S = 1000;
// A market as the indexer serves it (subset the scheduler needs).
const mkt = (over: Partial<any> = {}): any => ({
  pubkey: "M1", ticker_id: 7, ticker: "TSLA", trading_day: 20260825,
  close_ts: 1_700_000_000, normal_settlement_delay_secs: 1200, settled_ts: 0, ...over,
});

test("jobId is stable and distinguishes kind/ticker/day", () => {
  assert.equal(jobId({ kind: "settlement", day: 20260825, tickerId: 7 }), "settlement:20260825:7");
  assert.notEqual(
    jobId({ kind: "settlement", day: 1, tickerId: 7 }),
    jobId({ kind: "market-open", day: 1, tickerId: 7 }),
  );
});

test("settlement fires at close_ts + normal_settlement_delay_secs (ms)", () => {
  assert.equal(settlementFireAtMs(mkt()), (1_700_000_000 + 1200) * S);
});

test("market-open fires at resolution + 5m (ADR-0032)", () => {
  const resolutionMs = 1_700_001_200 * S;
  assert.equal(marketOpenFireAtMs(resolutionMs), resolutionMs + MARKET_OPEN_AFTER_RESOLUTION_SECS * S);
  assert.equal(MARKET_OPEN_AFTER_RESOLUTION_SECS, 300);
});

test("planJobs: one settlement job per unsettled ticker/day; already-settled markets drop out", () => {
  const jobs = planJobs([
    mkt({ pubkey: "a", ticker_id: 7, close_ts: 100 }),
    mkt({ pubkey: "b", ticker_id: 7, close_ts: 100 }), // same ticker/day -> one job
    mkt({ pubkey: "c", ticker_id: 3, close_ts: 200 }),
    mkt({ pubkey: "d", ticker_id: 1, settled_ts: 999 }), // already settled -> no job
  ]);
  const ids = jobs.map((j) => jobId(j)).sort();
  assert.deepEqual(ids, ["settlement:20260825:3", "settlement:20260825:7"]);
  assert.equal(jobs.find((j) => j.tickerId === 7)!.fireAtMs, (100 + 1200) * S);
});

test("dueJobs: only fire-time-reached, not-completed, not-in-backoff jobs", () => {
  const jobs = planJobs([mkt({ ticker_id: 7, close_ts: 100 }), mkt({ ticker_id: 3, close_ts: 100 })]);
  const fireAt = (100 + 1200) * S;
  const ledger = newLedger();
  assert.equal(dueJobs(jobs, fireAt - 1, ledger).length, 0, "not yet due");
  assert.equal(dueJobs(jobs, fireAt, ledger).length, 2, "both due at fire time");

  markCompleted(ledger, jobs.find((j) => j.tickerId === 7)!);
  assert.deepEqual(dueJobs(jobs, fireAt, ledger).map((j) => j.tickerId), [3], "completed job is skipped");

  recordRetry(ledger, jobs.find((j) => j.tickerId === 3)!, fireAt); // backoff from now=fireAt
  assert.equal(dueJobs(jobs, fireAt, ledger).length, 0, "job in backoff is not due");
  assert.equal(dueJobs(jobs, fireAt + backoffMs(1), ledger).length, 1, "due again after backoff elapses");
});

test("backoffMs: exponential, capped", () => {
  assert.ok(backoffMs(1) < backoffMs(2) && backoffMs(2) < backoffMs(3));
  assert.equal(backoffMs(1), backoffMs(1), "deterministic");
  assert.ok(backoffMs(50) <= backoffMs(51), "monotone into the cap");
  assert.equal(backoffMs(100), backoffMs(1000), "capped");
});

test("ledger idempotency: a completed job stays completed across duplicate fires", () => {
  const ledger = newLedger();
  const j = planJobs([mkt()])[0];
  assert.equal(isCompleted(ledger, j), false);
  markCompleted(ledger, j);
  assert.equal(isCompleted(ledger, j), true);
  markCompleted(ledger, j); // duplicate -> still just completed
  assert.equal(isCompleted(ledger, j), true);
});

test("recordRetry increments the attempt count so backoff grows", () => {
  const ledger = newLedger();
  const j = planJobs([mkt()])[0];
  recordRetry(ledger, j, 0);
  const first = ledger.attempts[jobId(j)].nextAtMs;
  recordRetry(ledger, j, 0);
  const second = ledger.attempts[jobId(j)].nextAtMs;
  assert.ok(second > first, "second retry backs off further");
});

test("marketOpenJobsFromLedger: a completed settlement schedules a market-open at resolution+5m", () => {
  const ledger = newLedger();
  const settle = { kind: "settlement", day: 20260825, tickerId: 7 } as const;
  const resolutionMs = 1_700_002_000 * S;
  markCompleted(ledger, settle, resolutionMs);
  const mo = marketOpenJobsFromLedger(ledger);
  assert.equal(mo.length, 1);
  assert.equal(jobId(mo[0]), "market-open:20260825:7");
  assert.equal(mo[0].fireAtMs, resolutionMs + MARKET_OPEN_AFTER_RESOLUTION_SECS * S);
});

test("marketOpenJobsFromLedger: not re-emitted once the market-open itself completes", () => {
  const ledger = newLedger();
  markCompleted(ledger, { kind: "settlement", day: 1, tickerId: 3 }, 1000);
  assert.equal(marketOpenJobsFromLedger(ledger).length, 1);
  markCompleted(ledger, marketOpenJobsFromLedger(ledger)[0], 2000);
  assert.equal(marketOpenJobsFromLedger(ledger).length, 0, "completed market-open drops out");
});

test("marketOpenJobsFromLedger: nothing before any settlement completes", () => {
  assert.equal(marketOpenJobsFromLedger(newLedger()).length, 0);
});

test("market-open is emitted for a day settled OUT-OF-BAND (override path), not just ledger-chained", () => {
  const ledger = newLedger();
  // TSLA (7) settled by this keeper; AAPL (1) settled by the Override Authority,
  // so it never reached the ledger. Both days are fully settled on-chain.
  markCompleted(ledger, { kind: "settlement", day: 20260826, tickerId: 7 }, 1_000);
  const markets: MarketRow[] = [
    { ticker_id: 7, trading_day: 20260826, close_ts: 100, normal_settlement_delay_secs: 1200, settled_ts: 900 },
    { ticker_id: 1, trading_day: 20260826, close_ts: 100, normal_settlement_delay_secs: 1200, settled_ts: 950 },
    { ticker_id: 1, trading_day: 20260826, close_ts: 100, normal_settlement_delay_secs: 1200, settled_ts: 960 },
  ];
  const ids = marketOpenJobsFromMarkets(markets, ledger).map(jobId).sort();
  assert.deepEqual(ids, ["market-open:20260826:1", "market-open:20260826:7"],
    "the override-settled ticker gets a market-open job too");
  const aapl = marketOpenJobsFromMarkets(markets, ledger).find((j) => j.tickerId === 1)!;
  assert.equal(aapl.fireAtMs, 960 * 1000 + MARKET_OPEN_AFTER_RESOLUTION_SECS * 1000,
    "fires off the LAST settlement in the group");
});

test("a partially settled (ticker, day) yields no market-open job", () => {
  const markets: MarketRow[] = [
    { ticker_id: 1, trading_day: 20260826, close_ts: 100, normal_settlement_delay_secs: 1200, settled_ts: 950 },
    { ticker_id: 1, trading_day: 20260826, close_ts: 100, normal_settlement_delay_secs: 1200, settled_ts: null },
  ];
  assert.deepEqual(marketOpenJobsFromMarkets(markets, newLedger()), [], "waits until every market in the group is settled");
});

test("an already-completed market-open is not re-emitted from observed state", () => {
  const ledger = newLedger();
  markCompleted(ledger, { kind: "market-open", day: 20260826, tickerId: 1 }, 1_000);
  const markets: MarketRow[] = [
    { ticker_id: 1, trading_day: 20260826, close_ts: 100, normal_settlement_delay_secs: 1200, settled_ts: 950 },
  ];
  assert.deepEqual(marketOpenJobsFromMarkets(markets, ledger), [], "ledger still de-dupes");
});

test("mergeJobs unions by id and keeps the earliest fire time", () => {
  const a: ScheduledJob[] = [{ kind: "market-open", day: 20260826, tickerId: 1, fireAtMs: 5_000 }];
  const b: ScheduledJob[] = [
    { kind: "market-open", day: 20260826, tickerId: 1, fireAtMs: 2_000 },
    { kind: "settlement", day: 20260826, tickerId: 2, fireAtMs: 9_000 },
  ];
  const out = mergeJobs(a, b).sort((x, y) => jobId(x).localeCompare(jobId(y)));
  assert.equal(out.length, 2, "duplicate ids collapse");
  assert.equal(out[0].fireAtMs, 2_000, "earliest fire time wins");
});
