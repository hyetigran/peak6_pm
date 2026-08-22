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
