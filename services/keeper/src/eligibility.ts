/**
 * Eligibility gate (#21) — the one decision the scheduled market-open job and
 * the pre-open re-validation gate both use, composing:
 *   - NYSE Trading-Day eligibility (ADR-0014, calendar.ts), and
 *   - the two-source Corporate Action Blackout (ADR-0022, blackout.ts).
 *
 * Used at two points under ADR-0032's resolution+5m creation time:
 *   1. AT CREATION — the market-open job refuses to create for an ineligible or
 *      blacked-out target session.
 *   2. PRE-OPEN — shortly before a market's mint window opens, re-check; a market
 *      whose target session stopped qualifying is `abandon_market`ed while it is
 *      still Created and empty, so no collateral is ever at risk.
 * The check fails CLOSED: a market that cannot be evaluated is surfaced for an
 * alert, never silently created or silently abandoned.
 */
import { isNyseTradingDay, type NyseCalendar } from "./calendar.js";
import { checkBlackout, type CorporateActionSource } from "./blackout.js";

export interface EligibilityResult { eligible: boolean; reason?: string }

export async function evaluateEligibility(opts: {
  tickerId: number;
  day: number;
  calendar: NyseCalendar;
  sources: CorporateActionSource[];
}): Promise<EligibilityResult> {
  if (!isNyseTradingDay(opts.day, opts.calendar)) {
    return { eligible: false, reason: `not a NYSE Trading Day (${opts.day})` };
  }
  const b = await checkBlackout(opts.tickerId, opts.day, opts.sources);
  if (b.blackout) return { eligible: false, reason: b.reason };
  return { eligible: true };
}

/** A market as the pre-open gate needs to see it (from the indexer projection). */
export interface GateMarket {
  pubkey: string;
  tickerId: number;
  day: number;
  stateName: string;
  activityStarted: boolean;
  hasVenue: boolean;
  mintOpenTs: number;
}

export interface RevalidationPlan {
  abandon: Array<{ pubkey: string; tickerId: number; day: number; reason: string }>;
  errors: Array<{ pubkey: string; error: string }>;
}

/** Which already-created markets to abandon because their target session stopped
 *  qualifying. Only Created, pre-mint-window, no-activity, no-venue markets are
 *  eligible to abandon (matches `abandon_market`'s on-chain guards) — abandoning
 *  before the mint window means zero collateral at risk. A market that cannot be
 *  evaluated is reported in `errors` (fail closed: alert, don't abandon). */
export async function revalidationPlan(opts: {
  markets: GateMarket[];
  now: number; // unix secs
  calendar: NyseCalendar;
  sourcesFor: (tickerId: number, day: number) => CorporateActionSource[];
}): Promise<RevalidationPlan> {
  const abandon: RevalidationPlan["abandon"] = [];
  const errors: RevalidationPlan["errors"] = [];
  for (const m of opts.markets) {
    // Only touch a market that is still safely abandonable and not yet open for minting.
    if (m.stateName !== "Created" || m.activityStarted || m.hasVenue || m.mintOpenTs <= opts.now) continue;
    try {
      const r = await evaluateEligibility({ tickerId: m.tickerId, day: m.day, calendar: opts.calendar, sources: opts.sourcesFor(m.tickerId, m.day) });
      if (!r.eligible) abandon.push({ pubkey: m.pubkey, tickerId: m.tickerId, day: m.day, reason: r.reason ?? "ineligible" });
    } catch (e) {
      errors.push({ pubkey: m.pubkey, error: (e as Error).message });
    }
  }
  return { abandon, errors };
}
