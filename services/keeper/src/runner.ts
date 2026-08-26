/**
 * Scheduler runner for the production keeper (#19, ADR-0031/ADR-0035).
 *
 * Substrate-agnostic drive loop: on each tick it lists the current jobs (from
 * the indexer), asks the pure core which are due, and runs each due job through
 * its handler exactly once — recording the outcome in the durable run-ledger.
 * A handler returns:
 *   - done          → mark completed (never runs again this trading day)
 *   - retry(reason) → back off and re-attempt later (e.g. Official Close not yet
 *                     published) — this is the "reschedule with backoff, don't
 *                     spin" requirement. The reason goes to `onRetry` so a
 *                     stuck dependency is visible; unreported, a permanently
 *                     failing job is indistinguishable from an idle keeper.
 *   - skip          → nothing to do now, no ledger change
 * A throw is treated as a retry (transient RPC/submit failure) so one bad tick
 * can't kill the runner. Abort (SIGTERM) drains the in-flight handler, then stops.
 *
 * This is deliberately NOT a per-second poll: `tickMs` is minutes in prod (the
 * job fire times, not the tick, drive the work), and cranking is event-driven
 * (#20). At-least-once delivery is sufficient because every on-chain action is
 * idempotent (ADR-0031/0023) and the ledger de-dupes duplicate fires.
 */
import { dueJobs, isCompleted, jobId, markCompleted, recordRetry, type JobKind, type Ledger, type ScheduledJob } from "./schedule.js";

export type JobOutcome =
  | { status: "done" }
  | { status: "retry"; reason?: string }
  | { status: "skip" };

export type JobHandler = (job: ScheduledJob) => Promise<JobOutcome>;

export interface RunSchedulerOpts {
  /** Produce the current scheduled jobs (usually planJobs over the indexer's markets). */
  listJobs: () => Promise<ScheduledJob[]>;
  handlers: Record<JobKind, JobHandler>;
  ledger: Ledger;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Poll cadence between ticks (minutes in prod, ms here). */
  tickMs: number;
  /** Called after every ledger mutation so it can be flushed to durable storage. */
  persist?: (ledger: Ledger) => void;
  /** Called whenever a job reports (or throws) a retry, with the now-current
   *  consecutive attempt count from the ledger. Wire this to a log/alert sink:
   *  a retry is otherwise invisible, and a permanently-failing dependency (a
   *  dead oracle feed) looks exactly like a healthy idle keeper. */
  onRetry?: (job: ScheduledJob, reason: string, attempt: number) => void;
  /** SIGTERM/shutdown. Drains the in-flight job, then resolves. */
  signal?: AbortSignal;
  /** Test affordance: stop once there is no outstanding (due or backing-off) work. */
  stopWhenIdle?: boolean;
  /** Safety bound on total ticks (tests / a hard stop). */
  maxTicks?: number;
}

export async function runScheduler(opts: RunSchedulerOpts): Promise<void> {
  const { listJobs, handlers, ledger, now, sleep, tickMs, persist, signal, onRetry } = opts;
  const flush = () => persist?.(ledger);
  let ticks = 0;

  while (!signal?.aborted) {
    ticks++;
    let jobs: ScheduledJob[] = [];
    try { jobs = await listJobs(); } catch { /* transient: try again next tick */ }

    const due = dueJobs(jobs, now(), ledger);
    const ranThisTick = new Set<string>();
    for (const job of due) {
      if (signal?.aborted) break; // stop before starting a NEW job; the current one (if any) already finished
      // Guard against the same job id appearing twice in one due list (a
      // completed job earlier in THIS loop, or a duplicated listing).
      if (ranThisTick.has(jobId(job)) || isCompleted(ledger, job)) continue;
      ranThisTick.add(jobId(job));
      let outcome: JobOutcome;
      try {
        outcome = await handlers[job.kind](job);
      } catch (e) {
        outcome = { status: "retry", reason: (e as Error).message };
      }
      if (outcome.status === "done") markCompleted(ledger, job, now());
      else if (outcome.status === "retry") {
        recordRetry(ledger, job, now());
        onRetry?.(job, outcome.reason ?? "no reason given", ledger.attempts[jobId(job)]?.count ?? 1);
      }
      // skip: no ledger change
      if (outcome.status !== "skip") flush();
    }

    if (signal?.aborted) break;
    if (opts.maxTicks && ticks >= opts.maxTicks) break;

    // Idle stop (tests): nothing due AND nothing waiting on a backoff timer.
    const anyPending = jobs.some((j) => !ledger.completed[jobId(j)]);
    if (opts.stopWhenIdle && due.length === 0 && !anyPending) break;
    if (opts.stopWhenIdle && due.length === 0 && anyPending) {
      // advance to the soonest backoff so the fake clock doesn't spin forever
      const waits = jobs
        .map((j) => ledger.attempts[jobId(j)]?.nextAtMs)
        .filter((t): t is number => t != null && t > now());
      await sleep(waits.length ? Math.min(...waits) - now() : tickMs);
      continue;
    }
    await sleep(tickMs);
  }
}
