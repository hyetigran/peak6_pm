/**
 * Eligibility gate (#21): compose NYSE Trading-Day eligibility (ADR-0014) and
 * the two-source Corporate Action Blackout (ADR-0022) into the one decision the
 * market-open job and the pre-open re-validation gate both use. Plus the
 * re-validation PLAN: which already-created markets must be abandoned because
 * their target session stopped qualifying. Pure. Run with tsx --test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadNyseCalendar } from "../services/keeper/src/calendar.js";
import { fixtureSource, type CorporateAction } from "../services/keeper/src/blackout.js";
import { evaluateEligibility, revalidationPlan, type GateMarket } from "../services/keeper/src/eligibility.js";

const cal = loadNyseCalendar();
const clean = () => [fixtureSource("A", []), fixtureSource("B", [])];
const withCA = (a: CorporateAction) => [fixtureSource("A", [a]), fixtureSource("B", [])];

test("eligible on a normal Trading Day with no corporate action", async () => {
  const r = await evaluateEligibility({ tickerId: 1, day: 20260825, calendar: cal, sources: clean() });
  assert.equal(r.eligible, true);
});

test("ineligible on a NYSE holiday (ADR-0014) — reason names the calendar", async () => {
  const r = await evaluateEligibility({ tickerId: 1, day: 20260101, calendar: cal, sources: clean() });
  assert.equal(r.eligible, false);
  assert.match(r.reason!, /trading day|holiday|nyse/i);
});

test("ineligible when a share-changing action blacks out the day (ADR-0022)", async () => {
  const r = await evaluateEligibility({ tickerId: 1, day: 20260825, calendar: cal, sources: withCA({ type: "split", tickerId: 1, day: 20260825 }) });
  assert.equal(r.eligible, false);
  assert.match(r.reason!, /split|blackout/i);
});

test("revalidationPlan: abandons a Created, pre-mint, empty market whose day now has a corporate action (the weekend case)", async () => {
  // Created on Friday evening for Monday's session; over the weekend a split is
  // announced for Monday. Before Monday's mint window opens, the gate abandons it.
  const monday = 20260831; // Mon
  const markets: GateMarket[] = [
    { pubkey: "M", tickerId: 1, day: monday, stateName: "Created", activityStarted: false, hasVenue: false, mintOpenTs: 9_999_999_999 },
  ];
  const plan = await revalidationPlan({
    markets, now: 0, calendar: cal,
    sourcesFor: () => withCA({ type: "split", tickerId: 1, day: monday }),
  });
  assert.deepEqual(plan.abandon.map((m) => m.pubkey), ["M"]);
  assert.match(plan.abandon[0].reason, /split|blackout/i);
});

test("revalidationPlan: keeps a still-eligible market and never touches one past its mint window", async () => {
  const markets: GateMarket[] = [
    { pubkey: "ok", tickerId: 1, day: 20260825, stateName: "Created", activityStarted: false, hasVenue: false, mintOpenTs: 9_999_999_999 },
    { pubkey: "open", tickerId: 1, day: 20260101, stateName: "Created", activityStarted: false, hasVenue: false, mintOpenTs: 1 }, // mint already open — too late to abandon safely
    { pubkey: "active", tickerId: 1, day: 20260101, stateName: "Active", activityStarted: true, hasVenue: true, mintOpenTs: 9_999_999_999 }, // has activity — cannot abandon
  ];
  const plan = await revalidationPlan({ markets, now: 100, calendar: cal, sourcesFor: () => clean() });
  assert.deepEqual(plan.abandon.map((m) => m.pubkey), [], "eligible kept; past-mint and active excluded");
});

test("revalidationPlan surfaces markets it could not evaluate (fail closed, alert not abandon)", async () => {
  const markets: GateMarket[] = [
    { pubkey: "err", tickerId: 1, day: 20260831, stateName: "Created", activityStarted: false, hasVenue: false, mintOpenTs: 9_999_999_999 },
  ];
  const plan = await revalidationPlan({
    markets, now: 0, calendar: cal,
    sourcesFor: () => [fixtureSource("A", [])], // only ONE source -> checkBlackout throws
  });
  assert.deepEqual(plan.abandon, []);
  assert.deepEqual(plan.errors.map((e) => e.pubkey), ["err"]);
});
