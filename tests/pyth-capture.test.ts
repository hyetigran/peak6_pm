/**
 * Capture-at-close (#26): the keeper must ask Hermes for the Pyth update AT the
 * Official Close (Pyth equity feeds are RTH-only; "latest" at close+20m is the
 * same last tick on a good day and a stale/wrong one otherwise), and size the
 * adapter's max_age so that close-time update is still accepted at settlement.
 * Pure seam, no RPC.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { captureWindow, CAPTURE_SLACK_SECS } from "../services/keeper/src/pyth-capture.js";

const CLOSE = 1_700_000_000;

test("at-close: queries Hermes at close_ts and allows the update to age until now (+slack)", () => {
  const w = captureWindow({ closeTs: CLOSE, now: CLOSE + 1200, mode: "at-close" });
  assert.equal(w.publishTime, CLOSE);
  assert.equal(w.maxAgeSecs, 1200n + BigInt(CAPTURE_SLACK_SECS));
});

test("at-close: never produces a negative age when called before the close", () => {
  const w = captureWindow({ closeTs: CLOSE, now: CLOSE - 30, mode: "at-close" });
  assert.equal(w.publishTime, CLOSE);
  assert.equal(w.maxAgeSecs, BigInt(CAPTURE_SLACK_SECS));
});

test("at-close is the default mode", () => {
  assert.equal(captureWindow({ closeTs: CLOSE, now: CLOSE + 1 }).publishTime, CLOSE);
});

test("latest: no timestamp query, explicit (demo) max age", () => {
  const w = captureWindow({ closeTs: CLOSE, now: CLOSE + 1200, mode: "latest", latestMaxAgeSecs: 604_800n });
  assert.equal(w.publishTime, null);
  assert.equal(w.maxAgeSecs, 604_800n);
});

test("rejects an unknown mode", () => {
  assert.throws(() => captureWindow({ closeTs: CLOSE, now: CLOSE, mode: "whenever" as any }), /KEEPER_PYTH_CAPTURE/);
});

// --- Hermes at-timestamp semantics (review fix): /v2/updates/price/{t} returns
// the FIRST update at-or-AFTER t. Querying exactly close_ts on a day whose last
// RTH print is 15:59:5x would return the NEXT session's first tick, which the
// on-chain window then rejects forever. So the keeper probes a descending ladder
// of query times and keeps the first result whose publish_time is in-window.
import { captureQueryTimes, isWithinCloseWindow, selectCloseUpdate, parseCaptureMode,
  OBSERVED_BEFORE_CLOSE_MAX_SECS, OBSERVED_AFTER_CLOSE_MAX_SECS } from "../services/keeper/src/pyth-capture.js";

test("window mirrors the program constants (close-60s .. close+900s)", () => {
  assert.equal(OBSERVED_BEFORE_CLOSE_MAX_SECS, 60);
  assert.equal(OBSERVED_AFTER_CLOSE_MAX_SECS, 900);
  assert.ok(isWithinCloseWindow(CLOSE, CLOSE));
  assert.ok(isWithinCloseWindow(CLOSE - 60, CLOSE));
  assert.ok(isWithinCloseWindow(CLOSE + 900, CLOSE));
  assert.ok(!isWithinCloseWindow(CLOSE - 61, CLOSE));
  assert.ok(!isWithinCloseWindow(CLOSE + 901, CLOSE));
});

test("query ladder starts at the close and walks back within the window", () => {
  const t = captureQueryTimes(CLOSE);
  assert.equal(t[0], CLOSE);
  assert.deepEqual([...t].sort((a, b) => b - a), t, "descending");
  assert.ok(t.every((x) => x >= CLOSE - OBSERVED_BEFORE_CLOSE_MAX_SECS));
});

test("selectCloseUpdate: takes the close tick when Hermes has one at the close", async () => {
  const fetchAt = async (t: number) => ({ publishTime: t, update: `u@${t}` });
  const r = await selectCloseUpdate(CLOSE, fetchAt);
  assert.equal(r.publishTime, CLOSE);
  assert.equal(r.update, `u@${CLOSE}`);
});

test("selectCloseUpdate: last print before the bell -> first-after(close) is next session; falls back to an in-window earlier tick", async () => {
  const lastRth = CLOSE - 3; // 15:59:57
  const nextSession = CLOSE + 17.5 * 3600;
  const asked: number[] = [];
  const fetchAt = async (t: number) => { asked.push(t); const p = t <= lastRth ? lastRth : nextSession; return { publishTime: p, update: `u@${p}` }; };
  const r = await selectCloseUpdate(CLOSE, fetchAt);
  assert.equal(r.publishTime, lastRth);
  assert.ok(asked.length >= 2, "probed more than once");
});

test("selectCloseUpdate: fails closed when no in-window update exists (holiday / feed down)", async () => {
  const fetchAt = async () => ({ publishTime: CLOSE + 86_400, update: "tomorrow" });
  await assert.rejects(selectCloseUpdate(CLOSE, fetchAt), /no Pyth update within the close window/);
});

test("selectCloseUpdate: a Hermes 404 on one probe does not abort the ladder", async () => {
  const fetchAt = async (t: number) => { if (t === CLOSE) throw new Error("404"); return { publishTime: CLOSE - 1, update: "ok" }; };
  assert.equal((await selectCloseUpdate(CLOSE, fetchAt)).publishTime, CLOSE - 1);
});

test("parseCaptureMode: default at-close, accepts latest, rejects junk", () => {
  assert.equal(parseCaptureMode(undefined), "at-close");
  assert.equal(parseCaptureMode("latest"), "latest");
  assert.throws(() => parseCaptureMode("whenever"), /KEEPER_PYTH_CAPTURE/);
});
