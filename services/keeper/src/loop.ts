/**
 * Keeper loop utilities (#19). Dependency-light (only globals) so they unit-test
 * without a validator.
 *
 * The demo keeper polls (a localnet affordance, ADR-0031); production settlement
 * and market-open are scheduled jobs. Either way the loop must NOT overlap:
 * `setInterval(asyncFn, ...)` fires the next tick before the async body
 * finishes, re-entering shared state and re-sending settle/consume txs (audit).
 * `runUntilStopped` schedules the next tick only AFTER the body resolves.
 */

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run `body` repeatedly, never overlapping, waiting `delayMs` between runs,
 *  until `signal` aborts. Resolves once stopped. The body owns its own errors;
 *  a throw is swallowed so one bad tick can't kill the loop. */
export function runUntilStopped(body: () => Promise<void>, delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => { if (timer) clearTimeout(timer); resolve(); };
    signal.addEventListener("abort", stop, { once: true });

    const tick = async () => {
      if (signal.aborted) return;
      try { await body(); } catch { /* body logs its own errors */ }
      if (signal.aborted) return; // don't schedule past an abort that landed mid-body
      timer = setTimeout(tick, delayMs); // next tick only after this one completes -> no overlap
    };
    void tick();
  });
}

/** Await `fn`, retrying on throw with exponential backoff (`baseMs * 2**attempt`).
 *  Returns the first success; throws the last error after `retries` retries. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseMs: number; onRetry?: (attempt: number, err: unknown) => void },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < opts.retries) {
        opts.onRetry?.(attempt + 1, e);
        await sleep(opts.baseMs * 2 ** attempt);
      }
    }
  }
  throw lastErr;
}
