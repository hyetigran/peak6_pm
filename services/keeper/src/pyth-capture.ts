/**
 * Capture-at-close policy for the Pyth transport (#26, ADR-0034).
 *
 * Pyth equity feeds publish during RTH only, so the value that represents the
 * Official Close is the update published AT close_ts — not "whatever is latest"
 * when settlement runs (~close+20m). The keeper therefore queries Hermes at
 * close_ts, and sizes the adapter's `max_age_secs` so that a close-time update
 * is still accepted by `get_price_no_older_than(now, max_age)` at settlement.
 * The strict Meridian build independently rejects a delivery whose observed_ts
 * is outside the close window (see finalize_settlement), so this is belt AND
 * braces: the keeper picks the right update, the program refuses a wrong one.
 *
 * `latest` exists only for the local/weekend demo (no update exists at a
 * synthetic close_ts); the localnet build relaxes the on-chain window.
 */
export type CaptureMode = "at-close" | "latest";

/** Slack over (now - close_ts): clock skew + Hermes returning the tick just before close. */
export const CAPTURE_SLACK_SECS = 300;

export interface CaptureWindow {
  /** Hermes publish-time query; null = latest. */
  publishTime: number | null;
  /** Adapter `max_age_secs` for this crank. */
  maxAgeSecs: bigint;
}

export function captureWindow(opts: {
  closeTs: number;
  now: number;
  mode?: CaptureMode;
  latestMaxAgeSecs?: bigint;
}): CaptureWindow {
  const mode = opts.mode ?? "at-close";
  if (mode === "at-close") {
    const age = Math.max(0, opts.now - opts.closeTs) + CAPTURE_SLACK_SECS;
    return { publishTime: opts.closeTs, maxAgeSecs: BigInt(age) };
  }
  if (mode === "latest") {
    return { publishTime: null, maxAgeSecs: opts.latestMaxAgeSecs ?? 604_800n };
  }
  throw new Error(`KEEPER_PYTH_CAPTURE must be "at-close" or "latest" (got ${String(mode)})`);
}
