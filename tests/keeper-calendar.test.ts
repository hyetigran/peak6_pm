/**
 * NYSE Trading-Day eligibility (#21, ADR-0014). The checked-in NYSE fixture is
 * authoritative; the Alpaca Calendar API is cross-checked against it and must
 * agree (fail loud) so a convenient API can't silently redefine market hours.
 * Pure — no network. Run: pnpm exec tsx --test tests/keeper-calendar.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadNyseCalendar, isNyseTradingDay, isEarlyClose, crossCheckCalendar, nextNyseTradingDay,
} from "../services/keeper/src/calendar.js";

const cal = loadNyseCalendar();

test("a normal weekday is a Trading Day (demo day Aug 25 2026 = Tue)", () => {
  assert.equal(isNyseTradingDay(20260825, cal), true);
});

test("weekends are never Trading Days", () => {
  assert.equal(isNyseTradingDay(20260822, cal), false); // Sat
  assert.equal(isNyseTradingDay(20260823, cal), false); // Sun
});

test("fixed + floating NYSE holidays are not Trading Days (2026)", () => {
  assert.equal(isNyseTradingDay(20260101, cal), false); // New Year's Day
  assert.equal(isNyseTradingDay(20260119, cal), false); // MLK
  assert.equal(isNyseTradingDay(20260703, cal), false); // Independence Day (observed, Jul 4 is Sat)
  assert.equal(isNyseTradingDay(20261126, cal), false); // Thanksgiving
  assert.equal(isNyseTradingDay(20261225, cal), false); // Christmas
});

test("an early-close day is still a Trading Day, flagged as early", () => {
  assert.equal(isNyseTradingDay(20261127, cal), true);  // day after Thanksgiving
  assert.equal(isEarlyClose(20261127, cal), true);
  assert.equal(isEarlyClose(20260825, cal), false);
});

test("nextNyseTradingDay skips weekends and holidays", () => {
  assert.equal(nextNyseTradingDay(20260825, cal), 20260826); // Tue -> Wed
  assert.equal(nextNyseTradingDay(20260828, cal), 20260831); // Fri -> Mon (skip weekend)
  assert.equal(nextNyseTradingDay(20261224, cal), 20261228); // Thu (early close) -> skip Fri Christmas + weekend -> Mon
  assert.equal(nextNyseTradingDay(20261231, cal), 20270104); // year boundary -> skip Jan 1 holiday + weekend
});

test("crossCheckCalendar: agreement passes; a disagreement fails loud (ADR-0014)", () => {
  // Alpaca agrees the day is open -> ok.
  assert.doesNotThrow(() => crossCheckCalendar(20260825, true, cal));
  // Alpaca says a known NYSE holiday is open -> the API is redefining hours -> throw.
  assert.throws(() => crossCheckCalendar(20260101, true, cal), /disagree/i);
  // Alpaca says a normal Trading Day is closed -> throw.
  assert.throws(() => crossCheckCalendar(20260825, false, cal), /disagree/i);
});

test("an out-of-fixture year fails closed rather than guessing", () => {
  assert.throws(() => isNyseTradingDay(20990101, cal), /no NYSE calendar/i);
});
