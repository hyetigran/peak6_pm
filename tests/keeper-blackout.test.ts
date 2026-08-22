/**
 * Corporate Action Blackout (#21, ADR-0022). V1 creates no Outcome Market for a
 * ticker on a Trading Day with a share-changing action (split, stock dividend,
 * spin-off, merger, rights, reorg, security-identity change). Ordinary cash
 * dividends stay eligible. TWO sources are checked before issuance. Pure — the
 * sources are injected. Run: pnpm exec tsx --test tests/keeper-blackout.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBlackoutAction, checkBlackout, fixtureSource, type CorporateAction, type CorporateActionSource,
} from "../services/keeper/src/blackout.js";

const src = (name: string, actions: CorporateAction[]): CorporateActionSource => ({
  name, actionsFor: async () => actions,
});
const split: CorporateAction = { type: "split", tickerId: 1, day: 20260825 };
const cashDiv: CorporateAction = { type: "cash_dividend", tickerId: 1, day: 20260825 };

test("share-changing actions disqualify; cash dividends do not (ADR-0022)", () => {
  for (const t of ["split", "stock_dividend", "spin_off", "merger", "rights", "reorg", "security_identity_change"] as const)
    assert.equal(isBlackoutAction(t), true, t);
  assert.equal(isBlackoutAction("cash_dividend"), false);
});

test("clean day across both sources -> not blacked out", async () => {
  const r = await checkBlackout(1, 20260825, [src("A", []), src("B", [cashDiv])]);
  assert.equal(r.blackout, false);
});

test("a disqualifying action from EITHER source blacks out the day", async () => {
  const a = await checkBlackout(1, 20260825, [src("A", [split]), src("B", [])]);
  assert.equal(a.blackout, true);
  assert.match(a.reason!, /split/);
  const b = await checkBlackout(1, 20260825, [src("A", []), src("B", [split])]);
  assert.equal(b.blackout, true);
});

test("fewer than two sources fails CLOSED (ADR-0022 requires two)", async () => {
  await assert.rejects(checkBlackout(1, 20260825, [src("A", [])]), /two.*source/i);
  await assert.rejects(checkBlackout(1, 20260825, []), /two.*source/i);
});

test("a source that throws fails closed (can't prove the day is clean)", async () => {
  const bad: CorporateActionSource = { name: "flaky", actionsFor: async () => { throw new Error("feed down"); } };
  await assert.rejects(checkBlackout(1, 20260825, [src("A", []), bad]), /feed down|source/i);
});

test("only actions for the SAME ticker+day count", async () => {
  const other: CorporateAction = { type: "split", tickerId: 2, day: 20260825 };
  const otherDay: CorporateAction = { type: "split", tickerId: 1, day: 20260826 };
  const r = await checkBlackout(1, 20260825, [src("A", [other, otherDay]), src("B", [])]);
  assert.equal(r.blackout, false);
});

test("fixtureSource reads a checked-in corporate-action list", async () => {
  const s = fixtureSource("test", [split]);
  assert.deepEqual(await s.actionsFor(1, 20260825), [split]);
  assert.deepEqual(await s.actionsFor(2, 20260825), []);
});

test("two INDEPENDENT sources that disagree fail closed (blackout if EITHER sees a share-change)", async () => {
  // Primary feed missed the split; secondary caught it. Union-toward-blackout is
  // the ADR-0022 fail-closed behaviour — we do not require agreement to block.
  const r = await checkBlackout(1, 20260825, [fixtureSource("primary", []), fixtureSource("secondary", [split])]);
  assert.equal(r.blackout, true);
  assert.match(r.reason!, /split/);
});
