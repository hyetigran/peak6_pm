/**
 * EventHeap cranking core (#20): subscription-driven, not a per-second poll.
 * Pure decisions + a fake-subscription watcher + the reconcile backstop — no
 * validator. Run: pnpm exec tsx --test tests/keeper-crank.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_HEAP_CAPACITY, heapCountFromData, depthPct, shouldCrank, assessSlo, priorityFeeForBand,
  reconcileTargets, runReconcile, watchHeap, type HeapAccount,
} from "../services/keeper/src/crank.js";

// Build an EventHeap account blob with a given count (u16 @ offset 12).
const heapData = (count: number): Buffer => { const b = Buffer.alloc(64); b.writeUInt16LE(count, 12); return b; };

test("capacity is the pinned OpenBook heap size (full at 600)", () => {
  assert.equal(EVENT_HEAP_CAPACITY, 600);
});

test("heapCountFromData reads the u16 count at offset 12; depthPct is count/capacity", () => {
  assert.equal(heapCountFromData(heapData(0)), 0);
  assert.equal(heapCountFromData(heapData(300)), 300);
  assert.equal(depthPct(300), 50);
  assert.equal(depthPct(0), 0);
});

test("shouldCrank only when the heap is non-empty (inline-first keeps it empty)", () => {
  assert.equal(shouldCrank(0), false);
  assert.equal(shouldCrank(1), true);
});

test("assessSlo §8.4 bands: ok < window target < warn < 50% escalate < 75% critical", () => {
  // pre-close window healthy target is <25% (150); final-5m is <10% (60).
  assert.equal(assessSlo(0, "pre-close").band, "ok");
  assert.equal(assessSlo(120, "pre-close").band, "ok");        // 20% < 25%
  assert.equal(assessSlo(150, "pre-close").band, "warn");      // exactly 25% is NOT healthy (§8.4 is < 25%)
  assert.equal(assessSlo(160, "pre-close").band, "warn");      // 26% > 25% target, < 50%
  assert.equal(assessSlo(70, "final-5m").band, "warn");        // 11.6% > 10% target
  assert.equal(assessSlo(300, "pre-close").band, "escalate");  // 50%
  assert.equal(assessSlo(450, "pre-close").band, "critical");  // 75%
  assert.equal(assessSlo(600, "pre-close").band, "critical");
});

test("priorityFeeForBand escalates monotonically; critical >= escalate >= base", () => {
  const base = priorityFeeForBand("ok", 1000);
  assert.equal(base, 1000);
  assert.ok(priorityFeeForBand("escalate", 1000) > base);
  assert.ok(priorityFeeForBand("critical", 1000) >= priorityFeeForBand("escalate", 1000));
});

test("reconcileTargets: the backstop cranks any heap the subscription left non-empty", () => {
  const heaps: HeapAccount[] = [
    { market: "A", heap: "hA", count: 0 },   // empty (inline-first) -> skip
    { market: "B", heap: "hB", count: 3 },   // a subscription event was dropped -> crank
    { market: "C", heap: "hC", count: 0 },
  ];
  assert.deepEqual(reconcileTargets(heaps).map((t) => t.market), ["B"]);
});

test("watchHeap: no crank while the heap stays empty (inline-first common case)", async () => {
  const cranked: string[] = [];
  let push!: (data: Buffer) => void;
  const subscribe = (_pk: string, cb: (data: Buffer) => void) => { push = cb; return () => {}; };
  watchHeap({ subscribe, heap: { market: "A", heap: "hA" }, onGrow: (m) => cranked.push(m.market), onSlo: () => {} });
  push(heapData(0)); // an update that leaves it empty
  push(heapData(0));
  assert.deepEqual(cranked, [], "an empty heap is never cranked");
});

test("watchHeap: a growing heap triggers exactly one crank per growth, passes the band, and assesses SLO", async () => {
  const cranked: string[] = [];
  const grewBands: string[] = [];
  const bands: string[] = [];
  let push!: (data: Buffer) => void;
  const subscribe = (_pk: string, cb: (data: Buffer) => void) => { push = cb; return () => {}; };
  watchHeap({
    subscribe, heap: { market: "A", heap: "hA" },
    onGrow: (m, _c, band) => { cranked.push(m.market); grewBands.push(band); },
    onSlo: (a) => bands.push(a.band), window: () => "pre-close",
  });
  push(heapData(2));   // grew 0 -> 2  => crank (ok band)
  push(heapData(2));   // unchanged   => no new crank
  push(heapData(0));   // drained     => no crank
  push(heapData(500)); // grew 0 -> 500 => crank + critical SLO
  assert.deepEqual(cranked, ["A", "A"]);
  assert.ok(bands.includes("critical"));
  assert.equal(grewBands[1], "critical", "onGrow receives the just-computed band");
});

test("watchHeap returns an IDEMPOTENT unsubscribe (safe to call twice)", () => {
  let unsubs = 0;
  const subscribe = (_pk: string, _cb: (d: Buffer) => void) => () => { unsubs++; };
  const stop = watchHeap({ subscribe, heap: { market: "A", heap: "hA" }, onGrow: () => {}, onSlo: () => {} });
  stop();
  stop(); // double-teardown (abort listener + end-of-run) must not re-unsubscribe
  assert.equal(unsubs, 1);
});

test("reconcile backstop cranks a heap whose subscription event was dropped", async () => {
  // Simulate: the subscription never fired for market B (dropped event), so the
  // watcher's crank set is empty, but B's heap is actually non-empty on-chain.
  const cranked: string[] = [];
  let push!: (data: Buffer) => void;
  const subscribe = (_pk: string, cb: (d: Buffer) => void) => { push = cb; return () => {}; };
  watchHeap({ subscribe, heap: { market: "B", heap: "hB" }, onGrow: (m) => cranked.push(`sub:${m.market}`), onSlo: () => {} });
  // no push() for B -> subscription "missed" it
  assert.deepEqual(cranked, [], "subscription dropped the event");

  // The minutes-scale reconcile reads the real counts and catches it.
  const onChainCounts: HeapAccount[] = [{ market: "B", heap: "hB", count: 5 }];
  for (const t of reconcileTargets(onChainCounts)) cranked.push(`reconcile:${t.market}`);
  assert.deepEqual(cranked, ["reconcile:B"], "reconcile backstop cranked the missed heap");
});

test("runReconcile: cranks exactly the heaps a dropped subscription event left non-empty", async () => {
  const cranked: string[] = [];
  const readCounts = async (): Promise<HeapAccount[]> => [
    { market: "A", heap: "hA", count: 0 },  // inline-first empty -> skip
    { market: "B", heap: "hB", count: 4 },  // dropped event -> crank
  ];
  const targets = await runReconcile({ readCounts, crank: async (t) => { cranked.push(t.market); } });
  assert.deepEqual(cranked, ["B"]);
  assert.deepEqual(targets.map((t) => t.market), ["B"]);
});

test("runReconcile: nothing to do when every heap is empty (no wasted cranks)", async () => {
  let cranks = 0;
  await runReconcile({ readCounts: async () => [{ market: "A", heap: "hA", count: 0 }], crank: async () => { cranks++; } });
  assert.equal(cranks, 0);
});
