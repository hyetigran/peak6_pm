/** Market-open planning (ADR-0032) — pure. Run: pnpm exec tsx --test tests/keeper-market-open.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadNyseCalendar } from "../services/keeper/src/calendar.js";
import { strikesFor, sessionCloseTs, planOpen, decodeRecordForOpen, RECORD } from "../services/keeper/src/market-open.js";

const cal = loadNyseCalendar();

test("strike ladder: ±3/6/9% snapped to $10, deduped, ascending", () => {
  assert.deepEqual(strikesFor(309.42), [280, 290, 300, 320, 330, 340]);
  assert.deepEqual(strikesFor(178), [160, 170, 180, 190]); // cheap name collapses bands
});

test("session close: 16:00 ET during EDT (UTC-4) and EST (UTC-5); 13:00 ET on early close", () => {
  assert.equal(sessionCloseTs(20260825, cal), Date.UTC(2026, 7, 25, 20, 0) / 1000);   // Aug: EDT
  assert.equal(sessionCloseTs(20261215, cal), Date.UTC(2026, 11, 15, 21, 0) / 1000);  // Dec: EST
  assert.equal(sessionCloseTs(20261124, cal), Date.UTC(2026, 10, 24, 21, 0) / 1000);  // Tue before Thanksgiving: regular
  assert.equal(sessionCloseTs(20261127, cal), Date.UTC(2026, 10, 27, 18, 0) / 1000);  // day after Thanksgiving: 13:00 EST
});

test("planOpen refuses a void sentinel close and a target already inside the lead", () => {
  assert.throws(() => planOpen({ tickerId: 1, targetDay: 20260826, officialClose1e6: 1n, nowSec: 1787680000, cal }), /void sentinel/);
  const lateNow = Date.UTC(2026, 7, 26, 19, 45) / 1000; // 15:45 ET on target day
  assert.throws(() => planOpen({ tickerId: 1, targetDay: 20260826, officialClose1e6: 309_420_000n, nowSec: lateNow, cal }), /inside the/);
});

test("planOpen: mint now-30m-30s, trade now-30s, close 16:00 ET target, ladder off the close", () => {
  const now = Date.UTC(2026, 7, 25, 20, 35) / 1000; // 16:35 ET Aug 25 (resolution+5m)
  const p = planOpen({ tickerId: 7, targetDay: 20260826, officialClose1e6: 353_815_000n, nowSec: now, cal });
  assert.equal(p.name, "TSLA");
  assert.equal(p.tradeOpenTs, BigInt(now - 30));
  assert.equal(p.tradeOpenTs - p.mintOpenTs, 1800n);
  assert.equal(p.closeTs, BigInt(Date.UTC(2026, 7, 26, 20, 0) / 1000));
  assert.deepEqual(p.strikes, strikesFor(353.815));
});

test("record decode offsets", () => {
  const b = Buffer.alloc(400);
  b[RECORD.STATE] = 2; b.writeBigInt64LE(1787424303n, RECORD.CLOSE_TS); b.writeBigUInt64LE(1n, RECORD.OFFICIAL_CLOSE); b[RECORD.IS_FINAL] = 1;
  assert.deepEqual(decodeRecordForOpen(b), { state: 2, closeTs: 1787424303n, officialClose1e6: 1n, isFinal: true });
});
