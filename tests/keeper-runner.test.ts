/**
 * Scheduler runner (#19): drives due jobs through injected handlers, honours the
 * run-ledger (idempotent no-op on duplicate/retried fires), backs off a job that
 * reports "not ready" (e.g. Official Close not yet published), and drains the
 * in-flight job on abort. Pure — injected clock/sleep/handlers, no validator.
 * Run: pnpm exec tsx --test tests/keeper-runner.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScheduler } from "../services/keeper/src/runner.js";
import { newLedger, jobId, type ScheduledJob } from "../services/keeper/src/schedule.js";

const job = (over: Partial<ScheduledJob> = {}): ScheduledJob =>
  ({ kind: "settlement", day: 20260825, tickerId: 7, fireAtMs: 0, ...over });

/** A fake clock: now advances by the sleep amount, so backoff windows elapse deterministically. */
function fakeClock(startMs = 0) {
  let now = startMs;
  return { now: () => now, sleep: async (ms: number) => { now += Math.max(1, ms); }, set: (t: number) => { now = t; } };
}

test("runs a due job exactly once, marks it completed, and stops when all are done", async () => {
  const clock = fakeClock(10_000);
  const ledger = newLedger();
  let runs = 0;
  await runScheduler({
    listJobs: async () => [job({ fireAtMs: 0 })],
    handlers: { settlement: async () => { runs++; return { status: "done" }; }, "market-open": async () => ({ status: "done" }) },
    ledger, now: clock.now, sleep: clock.sleep, tickMs: 1000, stopWhenIdle: true,
  });
  assert.equal(runs, 1);
  assert.ok(ledger.completed[jobId(job())] != null);
});

test("a duplicate fire of a completed job is a no-op (ledger idempotency)", async () => {
  const clock = fakeClock(10_000);
  const ledger = newLedger();
  let runs = 0;
  const listJobs = async () => [job({ fireAtMs: 0 }), job({ fireAtMs: 0 })]; // same job id twice per poll
  await runScheduler({
    listJobs,
    handlers: { settlement: async () => { runs++; return { status: "done" }; }, "market-open": async () => ({ status: "done" }) },
    ledger, now: clock.now, sleep: clock.sleep, tickMs: 1000, stopWhenIdle: true,
  });
  assert.equal(runs, 1, "the same job id runs once no matter how many times it is listed");
});

test("a 'retry' outcome backs the job off, then it succeeds on a later tick", async () => {
  const clock = fakeClock(10_000);
  const ledger = newLedger();
  let attempts = 0;
  await runScheduler({
    listJobs: async () => [job({ fireAtMs: 0 })],
    handlers: {
      settlement: async () => { attempts++; return attempts < 3 ? { status: "retry", reason: "close not published" } : { status: "done" }; },
      "market-open": async () => ({ status: "done" }),
    },
    ledger, now: clock.now, sleep: clock.sleep, tickMs: 1000, stopWhenIdle: true, maxTicks: 100,
  });
  assert.equal(attempts, 3, "retried until the close was available, then finalized");
  assert.ok(ledger.completed[jobId(job())] != null);
});

test("a throwing handler is caught, recorded as a retry, and does not kill the runner", async () => {
  const clock = fakeClock(10_000);
  const ledger = newLedger();
  let attempts = 0;
  await runScheduler({
    listJobs: async () => [job({ fireAtMs: 0 })],
    handlers: {
      settlement: async () => { attempts++; if (attempts === 1) throw new Error("rpc blip"); return { status: "done" }; },
      "market-open": async () => ({ status: "done" }),
    },
    ledger, now: clock.now, sleep: clock.sleep, tickMs: 1000, stopWhenIdle: true, maxTicks: 100,
  });
  assert.equal(attempts, 2);
  assert.ok(ledger.completed[jobId(job())] != null);
});

test("abort drains the in-flight job, then stops (no new job started)", async () => {
  const clock = fakeClock(10_000);
  const ledger = newLedger();
  const ac = new AbortController();
  let started = 0, finished = 0;
  const run = runScheduler({
    listJobs: async () => [job({ fireAtMs: 0 }), job({ tickerId: 3, fireAtMs: 0 })],
    handlers: {
      settlement: async () => { started++; ac.abort(); await clock.sleep(5); finished++; return { status: "done" }; },
      "market-open": async () => ({ status: "done" }),
    },
    ledger, now: clock.now, sleep: clock.sleep, tickMs: 1000, signal: ac.signal,
  });
  await run;
  assert.equal(started, 1, "aborted after the first job started; the second never began");
  assert.equal(finished, 1, "the in-flight job finished before the runner stopped");
});

test("persist callback is invoked after each ledger change so the ledger survives a crash", async () => {
  const clock = fakeClock(10_000);
  const ledger = newLedger();
  let persists = 0;
  await runScheduler({
    listJobs: async () => [job({ fireAtMs: 0 })],
    handlers: { settlement: async () => ({ status: "done" }), "market-open": async () => ({ status: "done" }) },
    ledger, now: clock.now, sleep: clock.sleep, tickMs: 1000, stopWhenIdle: true, persist: () => { persists++; },
  });
  assert.ok(persists >= 1, "the completed job was persisted");
});

test("onRetry reports every retry with its reason and a rising attempt count", async () => {
  const clock = fakeClock(10_000);
  const ledger = newLedger();
  const seen: { reason: string; attempt: number; kind: string }[] = [];
  let attempts = 0;
  await runScheduler({
    listJobs: async () => [job({ fireAtMs: 0 })],
    handlers: {
      settlement: async () => { attempts++; return attempts < 3 ? { status: "retry", reason: "hermes 401" } : { status: "done" }; },
      "market-open": async () => ({ status: "done" }),
    },
    ledger, now: clock.now, sleep: clock.sleep, tickMs: 1000, stopWhenIdle: true, maxTicks: 100,
    onRetry: (j, reason, attempt) => seen.push({ reason, attempt, kind: j.kind }),
  });
  assert.deepEqual(seen.map((s) => s.attempt), [1, 2], "one report per retry, counting up");
  assert.ok(seen.every((s) => s.reason === "hermes 401" && s.kind === "settlement"));
});

test("a throwing handler still reports the throw message through onRetry", async () => {
  const clock = fakeClock(10_000);
  const ledger = newLedger();
  const seen: string[] = [];
  let attempts = 0;
  await runScheduler({
    listJobs: async () => [job({ fireAtMs: 0 })],
    handlers: {
      settlement: async () => { attempts++; if (attempts === 1) throw new Error("hermes unauthorized"); return { status: "done" }; },
      "market-open": async () => ({ status: "done" }),
    },
    ledger, now: clock.now, sleep: clock.sleep, tickMs: 1000, stopWhenIdle: true, maxTicks: 100,
    onRetry: (_j, reason) => seen.push(reason),
  });
  assert.deepEqual(seen, ["hermes unauthorized"], "a thrown dependency failure is surfaced, not swallowed");
});
