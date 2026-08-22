/**
 * EventHeap cranking (#20, ADR-0031, ARCH §8.3–8.4).
 *
 * V1 settles maker fills inline-first (ID-007), so heaps are empty in the common
 * path and a per-second poll is almost all wasted work. Instead the prod keeper
 * SUBSCRIBES to each active heap (`onAccountChange`) and cranks bounded
 * `consume_events` only when the heap actually grows; a minutes-scale reconcile
 * poll backstops a missed subscription event; and the §8.4 depth SLO bands are
 * evaluated over the subscription (escalate priority fees / alert), not a
 * busy-poll. Residual drain folds into the settlement preflight (see scheduler).
 *
 * This module is the substrate-agnostic core: the pure decisions + a watcher
 * that takes an injected `subscribe` (real: conn.onAccountChange) so the
 * inline-first and saturation cases unit-test without a validator.
 */
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { EVENT_HEAP_COUNT_OFFSET, consumeEventsIx } from "./ix.js";

/** Pinned OpenBook EventHeap capacity — fills panic at exactly 600 (G6). */
export const EVENT_HEAP_CAPACITY = 600;
/** consume_events processes at most 8 events per instruction (G6). */
export const CONSUME_BATCH = 8n;

export type SloBand = "ok" | "warn" | "escalate" | "critical";
/** §8.4 windows carry different healthy depth targets. */
export type SloWindow = "pre-close" | "final-5m";

export const heapCountFromData = (data: Buffer): number => data.readUInt16LE(EVENT_HEAP_COUNT_OFFSET);
export const depthPct = (count: number, capacity = EVENT_HEAP_CAPACITY): number => (count / capacity) * 100;
export const shouldCrank = (count: number): boolean => count > 0;

/** §8.4 healthy depth target by window (below this is "ok"). */
const HEALTHY_TARGET_PCT: Record<SloWindow, number> = { "pre-close": 25, "final-5m": 10 };
const ESCALATE_PCT = 50; // priority-fee escalation
const CRITICAL_PCT = 75; // critical alert / UI warning

export interface SloAssessment { count: number; depthPct: number; band: SloBand; window: SloWindow }

export function assessSlo(count: number, window: SloWindow): SloAssessment {
  const pct = depthPct(count);
  let band: SloBand = "ok";
  if (pct >= CRITICAL_PCT) band = "critical";
  else if (pct >= ESCALATE_PCT) band = "escalate";
  else if (pct >= HEALTHY_TARGET_PCT[window]) band = "warn"; // §8.4 healthy is strictly < target
  return { count, depthPct: pct, band, window };
}

/** Escalation raises priority fees (§8.4): warn keeps base, escalate 4×, critical 10×. */
export function priorityFeeForBand(band: SloBand, base: number): number {
  const mult = band === "critical" ? 10 : band === "escalate" ? 4 : 1;
  return base * mult;
}

// --- reconcile backstop ---

export interface HeapAccount { market: string; heap: string; count: number }

/** Given the current heap counts (from a batched read), which markets still need
 *  cranking — i.e. a subscription event was dropped and the heap is non-empty. */
export const reconcileTargets = (heaps: HeapAccount[]): HeapAccount[] => heaps.filter((h) => shouldCrank(h.count));

// --- subscription watcher (injected `subscribe` so it unit-tests) ---

export interface WatchedHeap { market: string; heap: string }
export interface WatchHeapOpts {
  /** Real: (pubkey, cb) => conn.onAccountChange(new PublicKey(pubkey), a => cb(a.data)); returns an unsubscribe. */
  subscribe: (heapPubkey: string, onData: (data: Buffer) => void) => () => void;
  heap: WatchedHeap;
  /** Called when the heap grows (crank it), with the just-computed SLO band. */
  onGrow: (heap: WatchedHeap, count: number, band: SloBand) => void;
  /** Called with the SLO assessment on every update (surface warn / escalate / alert). */
  onSlo: (assessment: SloAssessment, heap: WatchedHeap) => void;
  /** Which §8.4 window applies now (default pre-close). */
  window?: () => SloWindow;
}

/** Subscribe to ONE heap; crank only on growth. Returns an idempotent
 *  unsubscribe (safe to call from both an abort handler and end-of-run).
 *  NOTE: §8.4's oldest-event-age target is not evaluated here — a count-only
 *  account read cannot see per-event timestamps; decoding them needs the pinned
 *  OpenBook EventHeap node layout (tracked, #20). Depth is the actionable
 *  escalation dimension and is fully covered. */
export function watchHeap(opts: WatchHeapOpts): () => void {
  const window = opts.window ?? (() => "pre-close" as SloWindow);
  let last = 0;
  let stopped = false;
  const unsub = opts.subscribe(opts.heap.heap, (data) => {
    const count = heapCountFromData(data);
    const prev = last;
    last = count;
    const assessment = assessSlo(count, window());
    opts.onSlo(assessment, opts.heap);
    if (count > prev && count > 0) opts.onGrow(opts.heap, count, assessment.band); // growth only — a drain to 0 is not a crank
  });
  return () => { if (stopped) return; stopped = true; unsub(); };
}

// --- shared drain (used by the subscription crank AND the settlement preflight) ---

/** Drain a heap with bounded consume_events until empty (or maxRounds). The
 *  heap must be empty before settle_market, so the settlement job calls this
 *  first (ARCH §8.4 residual drain folds into the preflight). */
export async function drainHeap(opts: {
  conn: Connection;
  send: (ixs: TransactionInstruction[]) => Promise<unknown>;
  openbookMarket: PublicKey;
  heap: PublicKey;
  owners: () => Promise<PublicKey[]>;
  maxRounds?: number;
}): Promise<number> {
  let cranked = 0;
  const maxRounds = opts.maxRounds ?? 64; // 64 * 8 = 512 events, below the 600 cap
  let owners: PublicKey[] | null = null; // resolved once, lazily (empty heap = no fetch)
  for (let round = 0; round < maxRounds; round++) {
    const info = await opts.conn.getAccountInfo(opts.heap);
    const count = info ? heapCountFromData(info.data) : 0;
    if (count === 0) break;
    owners ??= await opts.owners();
    await opts.send([consumeEventsIx(opts.openbookMarket, opts.heap, CONSUME_BATCH, owners)]);
    cranked += Math.min(count, Number(CONSUME_BATCH));
  }
  return cranked;
}

/** Reconcile backstop core (testable): read current heap counts, then crank
 *  every heap the subscription left non-empty (a dropped event). Injected
 *  readCounts + crank so it unit-tests without a validator. */
export async function runReconcile(opts: {
  readCounts: () => Promise<HeapAccount[]>;
  crank: (target: HeapAccount) => Promise<void>;
}): Promise<HeapAccount[]> {
  const targets = reconcileTargets(await opts.readCounts());
  for (const t of targets) await opts.crank(t);
  return targets;
}
