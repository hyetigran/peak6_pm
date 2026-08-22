/**
 * Alert seam (#25; the receiver is #10). Routes an alert to the configured
 * webhook (ALERT_WEBHOOK_URL) as JSON, or logs when none is configured. An
 * alert is never silently lost — a webhook failure or non-2xx falls back to a
 * log. Shared: the identity-drift monitor uses it; the scheduler's §8.4 SLO and
 * pre-open gate alerts can route through it too.
 */
export type AlertLevel = "warn" | "critical";

export interface AlertEvent {
  level: AlertLevel;
  source: string;   // "identity" | "slo" | "gate" | ...
  title: string;
  detail: string;
  data?: Record<string, unknown>;
}

export type Alerter = (event: AlertEvent) => Promise<void>;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

export function makeAlerter(opts: {
  webhookUrl?: string;
  fetchImpl?: FetchLike;
  log?: (msg: string) => void;
}): Alerter {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const fetchImpl = (opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
  return async (event: AlertEvent) => {
    const line = `[alert][${event.level}] ${event.source}: ${event.title} — ${event.detail}`;
    if (!opts.webhookUrl) { log(line); return; }
    try {
      const res = await fetchImpl(opts.webhookUrl, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event),
      });
      if (!res.ok) log(`${line} (webhook ${opts.webhookUrl} -> ${res.status}, logged instead)`);
    } catch (e) {
      log(`${line} (webhook post failed: ${(e as Error).message}, logged instead)`);
    }
  };
}
