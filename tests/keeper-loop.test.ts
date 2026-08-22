/**
 * Unit tests for the keeper's loop utilities (#19). Pure — no validator.
 * Run: pnpm exec tsx --test tests/keeper-loop.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runUntilStopped, withRetry, sleep } from "../services/keeper/src/loop.js";

test("withRetry: returns on first success without retrying", async () => {
  let calls = 0;
  const r = await withRetry(async () => { calls++; return "ok"; }, { retries: 3, baseMs: 0 });
  assert.equal(r, "ok");
  assert.equal(calls, 1);
});

test("withRetry: retries transient failures then succeeds", async () => {
  let calls = 0;
  const r = await withRetry(async () => { calls++; if (calls < 3) throw new Error("transient"); return 42; }, { retries: 5, baseMs: 0 });
  assert.equal(r, 42);
  assert.equal(calls, 3);
});

test("withRetry: throws the last error after exhausting retries", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error("nope"); }, { retries: 2, baseMs: 0 }),
    /nope/,
  );
  assert.equal(calls, 3); // 1 initial + 2 retries
});

test("runUntilStopped: never overlaps the body, even when it runs longer than the delay", async () => {
  const ac = new AbortController();
  let running = false, overlaps = 0, runs = 0;
  const body = async () => {
    if (running) overlaps++;
    running = true;
    await sleep(15); // body slower than the 1ms delay — setInterval would overlap here
    running = false;
    runs++;
  };
  const done = runUntilStopped(body, 1, ac.signal);
  await sleep(70);
  ac.abort();
  await done;
  assert.equal(overlaps, 0, "the body must never run concurrently with itself");
  assert.ok(runs >= 2, `expected multiple runs, got ${runs}`);
});

test("runUntilStopped: an already-aborted signal runs the body zero times", async () => {
  const ac = new AbortController();
  ac.abort();
  let runs = 0;
  await runUntilStopped(async () => { runs++; }, 1, ac.signal);
  assert.equal(runs, 0);
});

test("runUntilStopped: resolves promptly on abort", async () => {
  const ac = new AbortController();
  const done = runUntilStopped(async () => { await sleep(1); }, 5, ac.signal);
  setTimeout(() => ac.abort(), 20);
  await done; // resolves rather than hanging
  assert.ok(true);
});
