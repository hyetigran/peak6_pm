/**
 * G6 — EventHeap / inline maker policy (PRD v0.7.1 §15).
 *
 * Pin facts under test:
 *   - FILL_EVENT_REMAINING_LIMIT = 15 (book.rs:19) is theoretical only: the
 *     venue's 32KB SBF heap OOMs first — the MEASURED practical inline-fill
 *     capacity is asserted below, and requestHeapFrame cannot raise it
 *   - MAX_NUM_EVENTS = 600 (heap.rs:9): the heap is filled EMPIRICALLY and
 *     the 601st fill panics (push_back asserts !is_full, heap.rs:77)
 *   - consume_events: MAX_EVENTS_CONSUME = 8/ix; missing owner OO => skip;
 *     chained consume instructions measured in one tx (keeper throughput)
 *   - the consume-PREPEND composite (consume + take in one tx) is exercised
 * Measurements land in docs/adr/g6-measurements.json and are ASSERTED here.
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey,
  SystemProgram, Transaction, TransactionInstruction, TransactionMessage,
  VersionedTransaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction, createMintToInstruction, createMint,
  getAssociatedTokenAddressSync, createAssociatedTokenAccount, mintTo, getAccount,
} from "@solana/spl-token";
import * as ob from "./lib/openbook.js";
import { createAlt, sendV0 as sendV0raw } from "./lib/v0.js";
import fs from "node:fs";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
let conn: Connection;
const payer = Keypair.generate();
const taker = Keypair.generate();
const MAKERS = 16;
const makers: Keypair[] = Array.from({ length: MAKERS }, () => Keypair.generate());
const market = Keypair.generate(), bids = Keypair.generate(), asks = Keypair.generate(), heap = Keypair.generate();
let baseMint: PublicKey, quoteMint: PublicKey;
let baseVault: PublicKey, quoteVault: PublicKey;
let takerBase: PublicKey, takerQuote: PublicKey;
const makerBase: PublicKey[] = [], makerQuote: PublicKey[] = [], makerOo: PublicKey[] = [], makerOo2: PublicKey[] = [];

const BASE_LOT = 1_000_000n, QUOTE_LOT = 10_000n;

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
let altAddress: PublicKey;
async function sendV0(ixs: TransactionInstruction[], signers: Keypair[]) {
  return (await sendV0raw(conn, altAddress, ixs, signers)).sig;
}
const heapCount = async () => (await conn.getAccountInfo(heap.publicKey))!.data.readUInt16LE(ob.EVENT_HEAP_COUNT_OFFSET);
async function cuOf(sig: string) {
  const info = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return info!.meta!.computeUnitsConsumed!;
}
const restIx = (i: number, price: bigint, id: bigint, oo?: PublicKey) => ob.harnessPlaceLimitOrderIx({
  user: makers[i].publicKey, ooAccount: oo ?? makerOo[i], userTokenAccount: makerBase[i],
  market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
  eventHeap: heap.publicKey, marketVault: baseVault,
  args: { side: ob.Side.Ask, priceLots: price, maxBaseLots: 1n, maxQuoteLotsIncludingFees: price,
    clientOrderId: id, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
    selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
});
const takeIx = (lots: bigint, worst: bigint, oos: PublicKey[]) => ob.harnessPlaceTakeOrderIx({
  user: taker.publicKey, market: market.publicKey, bids: bids.publicKey,
  asks: asks.publicKey, eventHeap: heap.publicKey,
  marketBaseVault: baseVault, marketQuoteVault: quoteVault,
  userBaseAccount: takerBase, userQuoteAccount: takerQuote,
  makerOoAccounts: oos,
  args: { side: ob.Side.Bid, priceLots: worst, maxBaseLots: lots,
    maxQuoteLotsIncludingFees: worst * lots, orderType: ob.PlaceOrderType.ImmediateOrCancel, limit: 32 },
});

before(async () => {
  conn = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try { await conn.getLatestBlockhash(); break; }
    catch { if (i > 30) throw new Error("no validator — use scripts/run-suite.sh"); await new Promise(r => setTimeout(r, 1000)); }
  }
  for (const kp of [payer, taker]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 50_000_000_000);
    await conn.confirmTransaction(sig, "confirmed");
  }
  // fund makers from payer (faster than 16 airdrops)
  for (let i = 0; i < MAKERS; i += 8) {
    await send(makers.slice(i, i + 8).map(m =>
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: m.publicKey, lamports: 2_000_000_000 })), [payer]);
  }
  baseMint = await createMint(conn, payer, payer.publicKey, null, 6);
  quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  takerBase = await createAssociatedTokenAccount(conn, payer, baseMint, taker.publicKey);
  takerQuote = await createAssociatedTokenAccount(conn, payer, quoteMint, taker.publicKey);
  await mintTo(conn, payer, quoteMint, takerQuote, payer, 1_000_000_000n);
  // maker ATAs + base funding, batched
  for (let i = 0; i < MAKERS; i += 4) {
    const ixs: TransactionInstruction[] = [];
    for (const m of makers.slice(i, i + 4)) {
      const b = getAssociatedTokenAddressSync(baseMint, m.publicKey);
      const q = getAssociatedTokenAddressSync(quoteMint, m.publicKey);
      makerBase.push(b); makerQuote.push(q);
      ixs.push(
        createAssociatedTokenAccountInstruction(payer.publicKey, b, m.publicKey, baseMint),
        createAssociatedTokenAccountInstruction(payer.publicKey, q, m.publicKey, quoteMint),
        createMintToInstruction(baseMint, b, payer.publicKey, 100_000_000n),
      );
    }
    await send(ixs, [payer]);
  }
  await send([ob.harnessInitializeIx(payer.publicKey)], [payer]);
  const bookRent = await conn.getMinimumBalanceForRentExemption(ob.BOOKSIDE_SPACE);
  const heapRent = await conn.getMinimumBalanceForRentExemption(ob.EVENT_HEAP_SPACE);
  await send([
    ob.bookAccountIx(payer.publicKey, bids, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(payer.publicKey, asks, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(payer.publicKey, heap, ob.EVENT_HEAP_SPACE, heapRent),
  ], [payer, bids, asks, heap]);
  await send([ob.createMarketIx({
    market: market.publicKey, payer: payer.publicKey, baseMint, quoteMint,
    bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey,
    name: "G6-YES/USD", quoteLotSize: QUOTE_LOT, baseLotSize: BASE_LOT,
    makerFee: 0n, takerFee: 0n, timeExpiry: 0n,
    openOrdersAdmin: ob.venueAuthorityPda(), closeMarketAdmin: ob.venueAuthorityPda(),
  })], [payer, market]);
  const auth = ob.marketAuthorityPda(market.publicKey);
  baseVault = ob.ataFor(baseMint, auth); quoteVault = ob.ataFor(quoteMint, auth);
  const now = BigInt(Math.floor(Date.now() / 1000));
  await send([ob.harnessCreateVenueGateIx(payer.publicKey, market.publicKey, now - 60n, now + 3600n, payer.publicKey)], [payer]);
  for (let i = 0; i < MAKERS; i++) {
    await send([
      ob.createOoIndexerIx(payer.publicKey, makers[i].publicKey),
      ob.createOoAccountIx(payer.publicKey, makers[i].publicKey, 1, market.publicKey),
    ], [payer, makers[i]]);
    makerOo.push(ob.ooAccountPda(makers[i].publicKey, 1));
    // a second OO per maker: heaped fills LOCK OO slots until consumed, so
    // saturating the 600-event heap needs >24 in-flight fills per maker
    await send([ob.createOoAccountIx(payer.publicKey, makers[i].publicKey, 2, market.publicKey)], [payer, makers[i]]);
    makerOo2.push(ob.ooAccountPda(makers[i].publicKey, 2));
  }
  // ALT with every static account of the big take (G7's frozen-ALT mechanics)
  altAddress = await createAlt(conn, payer, [market.publicKey, bids.publicKey, asks.publicKey,
    heap.publicKey, baseVault, quoteVault, ob.OPENBOOK_PID, ob.TOKEN_PID, SystemProgram.programId,
    ob.harnessConfigPda(), ob.venueGatePda(market.publicKey), ob.venueAuthorityPda(),
    ...makerOo, ...makerOo2]);
});

async function restAll(n: number, round: bigint) {
  for (let i = 0; i < n; i++) await send([restIx(i, BigInt(40 + i), round)], [makers[i]]);
}
async function cleanupMakers(n: number) {
  for (let i = 0; i < n; i++) {
    await send([
      ob.cancelAllOrdersIx(makers[i].publicKey, makerOo[i], market.publicKey, bids.publicKey, asks.publicKey),
      ob.settleFundsIx({
        owner: makers[i].publicKey, ooAccount: makerOo[i], market: market.publicKey,
        marketBaseVault: baseVault, marketQuoteVault: quoteVault,
        userBaseAccount: makerBase[i], userQuoteAccount: makerQuote[i],
      })], [makers[i]]);
  }
}
const HEAP_FRAME = [
  ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 }),
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
];

test("G6.1 KEY FINDING: the venue's SBF heap bounds inline fills below the 15-account policy", async () => {
  await restAll(16, 1n);
  assert.equal(await heapCount(), 0, "clean heap before the take");
  // without a heap frame: OOM inside the PINNED VENUE PROGRAM
  let text = "";
  try { await sendV0([takeIx(16n, BigInt(40 + MAKERS - 1), makerOo)], [taker]); }
  catch (e: any) { text = `${e.message}\n${(e.transactionLogs ?? e.logs ?? []).join("\n")}`; }
  assert.ok(text.includes("memory allocation failed"), "16 inline fills OOM the venue at the pin");
  // requestHeapFrame(256KB) does NOT rescue the CPI'd program on this
  // validator: the inner invocation still gets the default heap
  text = "";
  try { await sendV0([...HEAP_FRAME, takeIx(16n, BigInt(40 + MAKERS - 1), makerOo)], [taker]); }
  catch (e: any) { text = `${e.message}\n${(e.transactionLogs ?? e.logs ?? []).join("\n")}`; }
  assert.ok(text.includes("memory allocation failed"),
    "heap frame does not extend the CPI'd venue program's heap — the bound is hard");
  await cleanupMakers(16);
});

const evidence: Record<string, unknown> = {};

test("G6.1b measured practical inline capacity: contiguous probe, exact bound", async () => {
  let maxOk = 0;
  for (const n of [4, 8, 9, 10, 11, 12, 13, 14, 15]) {
    await restAll(n, 10n + BigInt(n));
    let t0 = Date.now(), ok = false;
    try {
      await sendV0([takeIx(BigInt(n), BigInt(40 + n - 1), makerOo.slice(0, n))], [taker]);
      ok = true; maxOk = n;
      if (n === 10) evidence.inline_take_latency_ms = Date.now() - t0;
    } catch { /* the OOM bound */ }
    if (ok && await heapCount() > 0) {
      await send([ob.consumeEventsIx(market.publicKey, heap.publicKey, 8n, makerOo.slice(0, n))], [payer]);
      assert.equal(await heapCount(), 0, "post-probe consume drained");
    }
    await cleanupMakers(n);
    if (!ok) break;
  }
  evidence.practical_inline_fill_capacity = maxOk;
  console.error(`G6 MEASURED practical inline-fill capacity: ${maxOk} (contiguous probe; policy said 15)`);
  assert.equal(maxOk, ob.PRACTICAL_INLINE_FILLS,
    "the published capacity constant matches the measured bound exactly");
});

test("G6.2 consume_events batch CU: marginal cost per event and keeper budget", async () => {
  // settle any maker proceeds; rest 8 fresh asks and take with NO maker OOs
  // supplied so all 8 fills heap (heap frame for the take's own allocations)
  await restAll(8, 2n);
  const tMatch = Date.now();
  await send([takeIx(8n, 47n, [])], [taker]);
  evidence.match_plus_heap_latency_ms = Date.now() - tMatch; // owner-less: pure match + heap push
  assert.equal(await heapCount(), 8, "all 8 fills heaped without remaining accounts");
  // an owner-less consume SKIPS everything (events need their OO accounts)
  await send([ob.consumeEventsIx(market.publicKey, heap.publicKey, 8n, [])], [payer]);
  assert.equal(await heapCount(), 8, "consume without owner OOs consumes nothing (skip semantics)");
  const sig1 = await send([ob.consumeEventsIx(market.publicKey, heap.publicKey, 1n, makerOo.slice(0, 8))], [payer]);
  const cu1 = await cuOf(sig1);
  assert.equal(await heapCount(), 7);
  const sig7 = await send([ob.consumeEventsIx(market.publicKey, heap.publicKey, 7n, makerOo.slice(0, 8))], [payer]);
  const cu7 = await cuOf(sig7);
  assert.equal(await heapCount(), 0, "batch consume with owner OOs drains the heap");
  evidence.heap_event_latency_ms_note = "event lifetime = keeper poll interval + one consume tx; consume tx latency measured below";
  const marginal = Math.ceil((cu7 - cu1) / 6);
  evidence.consume_cu_1_event = cu1;
  evidence.consume_cu_7_events = cu7;
  evidence.consume_cu_marginal_per_event = marginal;
  assert.ok(marginal < 30_000, "consuming an event costs a small, bounded CU amount");

  // the consume-PREPEND composite (the actual builder policy): consume + take
  // in ONE transaction
  await restAll(8, 3n);
  await send([takeIx(8n, 47n, [])], [taker]); // heap 8 events
  assert.equal(await heapCount(), 8);
  await restAll(4, 4n);
  const t0 = Date.now();
  await sendV0([
    ob.consumeEventsIx(market.publicKey, heap.publicKey, 8n, makerOo.slice(0, 8)),
    takeIx(4n, 43n, makerOo.slice(0, 4)),
  ], [taker]);
  evidence.prepend_composite_latency_ms = Date.now() - t0;
  assert.equal(await heapCount(), 0, "prepended consume drained the backlog AND the take filled inline");
  await cleanupMakers(8);
});

test("G6.3 EMPIRICAL saturation: heap filled to 600; the next fill panics; chained consume drains", async () => {
  assert.equal(await heapCount(), 0);
  // fill: each maker rests 12 asks in one tx; owner-less 16-lot takes heap
  // 16 events each, until one slot short of capacity
  const restManyIx = (i: number, count: number, round: bigint, oo: PublicKey) => {
    const ixs: TransactionInstruction[] = [];
    for (let k = 0; k < count; k++) ixs.push(restIx(i, BigInt(40 + i), round * 100n + BigInt(k), oo));
    return ixs;
  };
  // heaped fills lock OO slots until consumed (OpenOrdersFull observed at
  // 24 in-flight per OO) — a saturation fact of its own: a stalled keeper
  // freezes maker capacity long before the heap fills. Two OO accounts per
  // maker (768 slots) with EXPLICIT slot budgeting reach true heap capacity.
  const ooUsed = new Map<string, number>();
  const pickOo = (i: number, n: number): PublicKey => {
    for (const oo of [makerOo[i], makerOo2[i]]) {
      const used = ooUsed.get(oo.toBase58()) ?? 0;
      if (used + n <= 24) { ooUsed.set(oo.toBase58(), used + n); return oo; }
    }
    throw new Error(`maker ${i} out of OO slots`);
  };
  let round = 50n;
  // exact rounds: rest 12 per maker (192), take all 192 (book empty after),
  // so slots are held ONLY by heaped fills — no drift
  const fillRound = async (perMaker: number, mks: number) => {
    for (let i = 0; i < mks; i++) {
      await sendV0(restManyIx(i, perMaker, round, pickOo(i, perMaker)), [makers[i]]);
    }
    const total = perMaker * mks;
    for (let t = 0; t < Math.ceil(total / 16); t++) {
      const lots = BigInt(Math.min(16, total - t * 16));
      await send([takeIx(lots, 55n, [])], [taker]);
    }
    round += 1n;
  };
  await fillRound(12, 16); // 192
  await fillRound(12, 16); // 384
  await fillRound(12, 16); // 576
  await fillRound(1, 16);  // 592
  await fillRound(1, 8);   // 600
  assert.equal(await heapCount(), ob.MAX_NUM_EVENTS, "heap EXACTLY full (600)");
  await sendV0(restManyIx(8, 1, round, pickOo(8, 1)), [makers[8]]);
  let text = "";
  try { await send([takeIx(1n, 55n, [])], [taker]); }
  catch (e: any) { text = `${e.message}\n${(e.transactionLogs ?? e.logs ?? []).join("\n")}`; }
  assert.ok(text.includes("SBF program panicked") || text.includes("panicked"),
    "a fill against the FULL heap panics (heap.rs:77) — saturation is fail-closed, empirically");
  // measured chained-consume throughput: N consume ixs in ONE tx
  const CHAIN = 12;
  const t0 = Date.now();
  const sig = await sendV0(
    Array.from({ length: CHAIN }, () => ob.consumeEventsIx(market.publicKey, heap.publicKey, 8n, makerOo)),
    [payer]);
  const drained = ob.MAX_NUM_EVENTS - (await heapCount());
  const cu = await cuOf(sig);
  evidence.chained_consume = { instructions: CHAIN, events_drained: drained, cu, latency_ms: Date.now() - t0 };
  assert.equal(drained, CHAIN * ob.MAX_EVENTS_CONSUME, "each chained ix consumed its full batch of 8");
  const perTxCapacity = Math.floor(1_400_000 / (cu / CHAIN)) * ob.MAX_EVENTS_CONSUME;
  evidence.measured_events_per_max_cu_tx = perTxCapacity;
  console.error(`G6 chained consume MEASURED: ${CHAIN} ixs, ${drained} events, ${cu} CU in one tx; ` +
    `=> ~${perTxCapacity} events per 1.4M-CU tx; full 600-heap drain in ` +
    `${Math.ceil(600 / drained)} such txs`);
  assert.ok(drained >= 40, "one tx drains a meaningful batch (measured, not extrapolated)");
  // drain the remainder and finish clean
  while (await heapCount() > 0) {
    await sendV0([ob.consumeEventsIx(market.publicKey, heap.publicKey, 8n, [...makerOo, ...makerOo2])], [payer]);
  }
  await cleanupMakers(16);
  evidence.event_heap_capacity_empirical = ob.MAX_NUM_EVENTS;
  fs.writeFileSync("docs/adr/g6-measurements.json", JSON.stringify(evidence, null, 2) + "\n");
});
