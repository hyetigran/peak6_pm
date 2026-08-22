/**
 * NYSE Trading-Day eligibility (#21, ADR-0014).
 *
 * NYSE's published schedule is authoritative for Trading Days, holidays, and
 * early closes. The checked-in fixture (fixtures/nyse-calendar.json) is that
 * schedule; the Alpaca Calendar API supplies the operational schedule at runtime
 * and is CROSS-CHECKED against the fixture — any disagreement fails loud so a
 * convenient API cannot silently redefine market hours. An out-of-fixture year
 * fails closed rather than guessing.
 *
 * Dates are the u32 `YYYYMMDD` Trading-Day identity used across the program.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface NyseCalendar {
  holidays: Record<string, number[]>;     // year -> [YYYYMMDD] full closures
  earlyCloses: Record<string, number[]>;  // year -> [YYYYMMDD] 1:00pm ET early closes
}

const FIXTURE = path.resolve(fileURLToPath(import.meta.url), "../../../../fixtures/nyse-calendar.json");

export function loadNyseCalendar(file = process.env.NYSE_CALENDAR ?? FIXTURE): NyseCalendar {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return { holidays: raw.holidays ?? {}, earlyCloses: raw.earlyCloses ?? {} };
}

const yearOf = (day: number): string => String(Math.floor(day / 10000));

/** Split a packed YYYYMMDD int into its calendar parts. */
const ymd = (day: number): [number, number, number] => [Math.floor(day / 10000), Math.floor(day / 100) % 100, day % 100];

/** Day-of-week for a YYYYMMDD date (0 = Sun … 6 = Sat), via a UTC calendar date. */
function weekday(day: number): number {
  const [y, m, d] = ymd(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** True iff `day` is a NYSE Trading Day (a weekday that is not a full-closure
 *  holiday). Throws for a year the fixture doesn't cover (fail closed). */
export function isNyseTradingDay(day: number, cal: NyseCalendar): boolean {
  const year = yearOf(day);
  if (!cal.holidays[year]) throw new Error(`no NYSE calendar for ${year} (add it to fixtures/nyse-calendar.json)`);
  const dow = weekday(day);
  if (dow === 0 || dow === 6) return false; // weekend
  return !cal.holidays[year].includes(day);
}

/** The next NYSE Trading Day strictly after `day` (skips weekends + holidays).
 *  ADR-0032's target session for a market-open job fired after `day` resolves. */
export function nextNyseTradingDay(day: number, cal: NyseCalendar): number {
  const [y, m, d] = ymd(day);
  const dt = new Date(Date.UTC(y, m - 1, d));
  for (let i = 0; i < 10; i++) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const next = dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
    if (isNyseTradingDay(next, cal)) return next;
  }
  throw new Error(`no NYSE Trading Day within 10 days of ${day}`);
}

/** True iff `day` is an early-close (1:00pm ET) Trading Day. */
export function isEarlyClose(day: number, cal: NyseCalendar): boolean {
  return (cal.earlyCloses[yearOf(day)] ?? []).includes(day);
}

/** ADR-0014 fail-loud cross-check: the operational (Alpaca) open/closed flag for
 *  `day` must match the checked-in NYSE fixture, else throw. */
export function crossCheckCalendar(day: number, alpacaSaysOpen: boolean, cal: NyseCalendar): void {
  const fixtureOpen = isNyseTradingDay(day, cal);
  if (fixtureOpen !== alpacaSaysOpen) {
    throw new Error(`NYSE calendar disagreement on ${day}: fixture ${fixtureOpen ? "open" : "closed"} vs Alpaca ${alpacaSaysOpen ? "open" : "closed"}`);
  }
}
