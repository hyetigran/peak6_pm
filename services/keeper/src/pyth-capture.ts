/**
 * Capture-at-close policy for the Pyth transport (#26, ADR-0034 §Capture window).
 *
 * Pyth equity feeds publish during RTH only, so the value that represents the
 * Official Close is the update published AT close_ts — not "whatever is latest"
 * when settlement runs (~close+20m). The strict Meridian build enforces this as
 * a Settlement Quality Predicate condition: the delivery's observed_ts (Pyth
 * publish time) must lie in [close_ts - 60s, close_ts + 900s]. This module is
 * the keeper side of the same rule: pick an update that satisfies it, and size
 * the adapter's `max_age_secs` so that update is still accepted at settlement.
 *
 * Hermes semantics matter: `/v2/updates/price/{t}` returns the FIRST update
 * at-or-AFTER t. On a day whose last RTH print is 15:59:5x, asking for exactly
 * close_ts returns the NEXT session's first tick — so we probe a descending
 * ladder of query times and keep the first in-window result (fail closed if
 * none). `latest` exists only for the local/weekend demo.
 */
export type CaptureMode = "at-close" | "latest";

/** Mirrors programs/meridian constants OBSERVED_{BEFORE,AFTER}_CLOSE_MAX_SECS. */
export const OBSERVED_BEFORE_CLOSE_MAX_SECS = 60;
export const OBSERVED_AFTER_CLOSE_MAX_SECS = 900;
/** Slack over (now - close_ts) for the adapter's max_age: clock skew + in-window pre-close tick. */
export const CAPTURE_SLACK_SECS = 300;
/** Demo-only max age for `latest` (weekend-stale equity feeds). */
export const DEFAULT_LATEST_MAX_AGE_SECS = 604_800n;

export function parseCaptureMode(raw: string | undefined): CaptureMode {
  const mode = raw ?? "at-close";
  if (mode === "at-close" || mode === "latest") return mode;
  throw new Error(`KEEPER_PYTH_CAPTURE must be "at-close" or "latest" (got ${String(raw)})`);
}

export const isWithinCloseWindow = (publishTime: number, closeTs: number): boolean =>
  publishTime >= closeTs - OBSERVED_BEFORE_CLOSE_MAX_SECS && publishTime <= closeTs + OBSERVED_AFTER_CLOSE_MAX_SECS;

/** Descending Hermes query times: the close itself, then a few seconds back, never past the window. */
export const captureQueryTimes = (closeTs: number): number[] =>
  [0, 1, 5, 15, OBSERVED_BEFORE_CLOSE_MAX_SECS].map((d) => closeTs - d);

export interface HermesUpdate<U = unknown> { publishTime: number; update: U }

/** Probe the ladder; return the first update whose publish_time is in the close window. */
export async function selectCloseUpdate<U>(
  closeTs: number,
  fetchAt: (t: number) => Promise<HermesUpdate<U>>,
): Promise<HermesUpdate<U>> {
  const seen: string[] = [];
  for (const t of captureQueryTimes(closeTs)) {
    try {
      const r = await fetchAt(t);
      if (isWithinCloseWindow(r.publishTime, closeTs)) return r;
      seen.push(`@${t}->${r.publishTime}`);
    // Keep enough of the probe error to name the cause (an auth rejection reads
    // "... 401 unauthorized" — truncating to 40 chars hid exactly that).
    } catch (e) { seen.push(`@${t}->${(e as Error).message.slice(0, 90)}`); }
  }
  throw new Error(`no Pyth update within the close window [${closeTs - OBSERVED_BEFORE_CLOSE_MAX_SECS}, ${closeTs + OBSERVED_AFTER_CLOSE_MAX_SECS}]: ${seen.join(" ")}`);
}

export interface CaptureWindow {
  /** Hermes publish-time query; null = latest. */
  publishTime: number | null;
  /** Adapter `max_age_secs` for this crank. */
  maxAgeSecs: bigint;
}

export function captureWindow(opts: { closeTs: number; now: number; mode?: CaptureMode; latestMaxAgeSecs?: bigint }): CaptureWindow {
  const mode = parseCaptureMode(opts.mode);
  if (mode === "at-close") {
    const age = Math.max(0, opts.now - opts.closeTs) + CAPTURE_SLACK_SECS;
    return { publishTime: opts.closeTs, maxAgeSecs: BigInt(age) };
  }
  return { publishTime: null, maxAgeSecs: opts.latestMaxAgeSecs ?? DEFAULT_LATEST_MAX_AGE_SECS };
}
