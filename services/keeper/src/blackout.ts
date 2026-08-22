/**
 * Corporate Action Blackout (#21, ADR-0022).
 *
 * V1 creates no Outcome Market for a ticker on a Trading Day carrying a
 * share-changing corporate action — split, stock dividend, spin-off, merger,
 * rights distribution, reorganization, or security-identity change. Ordinary
 * cash-dividend ex-dates stay eligible (their price movement counts). This
 * avoids revisionable adjusted-history math (ADR-0022).
 *
 * TWO corporate-action sources are checked before issuance; the check fails
 * CLOSED — fewer than two available sources, or a source that errors, blocks
 * issuance rather than assuming the day is clean.
 */

export type CorporateActionType =
  | "split" | "stock_dividend" | "spin_off" | "merger" | "rights" | "reorg" | "security_identity_change"
  | "cash_dividend"; // eligible — listed so a source can report it without disqualifying

export interface CorporateAction { type: CorporateActionType; tickerId: number; day: number }

export interface CorporateActionSource {
  name: string;
  actionsFor: (tickerId: number, day: number) => Promise<CorporateAction[]>;
}

/** The share-changing action types that disqualify a Trading Day (ADR-0022). */
export const DISQUALIFYING_ACTIONS: ReadonlySet<CorporateActionType> = new Set([
  "split", "stock_dividend", "spin_off", "merger", "rights", "reorg", "security_identity_change",
]);

export const isBlackoutAction = (type: CorporateActionType): boolean => DISQUALIFYING_ACTIONS.has(type);

export interface BlackoutResult { blackout: boolean; reason?: string; actions: CorporateAction[] }

/** Check both sources for a disqualifying action on (tickerId, day). Requires at
 *  least two sources (ADR-0022) and fails closed if any source errors. */
export async function checkBlackout(tickerId: number, day: number, sources: CorporateActionSource[]): Promise<BlackoutResult> {
  if (sources.length < 2) throw new Error(`corporate-action blackout requires two sources (ADR-0022); have ${sources.length}`);
  const found: CorporateAction[] = [];
  for (const s of sources) {
    let actions: CorporateAction[];
    try {
      actions = await s.actionsFor(tickerId, day);
    } catch (e) {
      throw new Error(`corporate-action source "${s.name}" failed (fail closed): ${(e as Error).message}`);
    }
    for (const a of actions) {
      if (a.tickerId === tickerId && a.day === day && isBlackoutAction(a.type)) found.push(a);
    }
  }
  if (found.length === 0) return { blackout: false, actions: [] };
  return { blackout: true, reason: `blackout: ${[...new Set(found.map((a) => a.type))].join(", ")}`, actions: found };
}

/** A source backed by a checked-in / configured corporate-action list (the
 *  demo/test default; live feeds are injected in prod). */
export function fixtureSource(name: string, actions: CorporateAction[]): CorporateActionSource {
  return { name, actionsFor: async (tickerId, day) => actions.filter((a) => a.tickerId === tickerId && a.day === day) };
}
