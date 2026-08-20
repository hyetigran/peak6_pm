/**
 * G10 — Lot/price/order semantics (PRD v0.7.1 §15), production lot scheme:
 * base_lot_size = 1,000,000 (one whole Yes Token == one base lot),
 * quote_lot_size = 10,000 (1 price lot == 1 cent), prices 1..99 == $0.01..$0.99.
 *
 *   1. golden price vectors: bid at P locks exactly P×10,000 quote atoms;
 *      a fill at P moves P×10,000 per whole token
 *   2. PostOnly crossing: SILENT no-op at the venue (book.rs:166-170) —
 *      wrapper converts it to a fail-closed OrderNotPosted revert;
 *      non-crossing PostOnly rests
 *   3. returned order ID: wrapper logs the venue-returned u128; that exact id
 *      cancels via cancel_order
 *   4. per-order expiry: TIF = u16 seconds (order.rs:47-61, ~18.2h clamp);
 *      expired maker is skipped by takes; past-expiry placement is a silent
 *      no-op at the venue — wrapper reverts OrderNotPosted
 *   5. SelfTradeBehavior pinned to AbortTransaction: wire offset golden +
 *      wrapper rejects any other value
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccount, createMint, getAccount, mintTo } from "@solana/spl-token";
import * as ob from "./lib/openbook.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
let conn: Connection;
const payer = Keypair.generate();
const maker = Keypair.generate();
const taker = Keypair.generate();
const market = Keypair.generate(), bids = Keypair.generate(), asks = Keypair.generate(), heap = Keypair.generate();
let baseMint: PublicKey, quoteMint: PublicKey;
let makerBaseAta: PublicKey, makerQuoteAta: PublicKey, takerBaseAta: PublicKey, takerQuoteAta: PublicKey;
let baseVault: PublicKey, quoteVault: PublicKey, makerOo: PublicKey, takerOo: PublicKey;

// PRODUCTION lot scheme (G10)
const BASE_LOT = 1_000_000n;   // one whole 6-decimal Yes Token
const QUOTE_LOT = 10_000n;     // one price lot == one cent

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
async function sendGetLogs(ixs: TransactionInstruction[], signers: Keypair[]) {
  const sig = await send(ixs, signers);
  const info = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return info!.meta?.logMessages ?? [];
}
async function expectFail(p: Promise<unknown>, needle: string, label: string) {
  try { await p; } catch (e: any) {
    const text = `${e.message}\n${(e.transactionLogs ?? e.logs ?? []).join("\n")}`;
    assert.ok(text.includes(needle), `${label}: failed but without "${needle}":\n${text}`);
    return;
  }
  assert.fail(`${label}: expected failure, but transaction succeeded`);
}
const limitArgs = (side: ob.Side, priceLots: bigint, id: bigint, expiry = 0n): ob.PlaceOrderArgs => ({
  side, priceLots, maxBaseLots: 1n, maxQuoteLotsIncludingFees: priceLots,
  clientOrderId: id, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: expiry,
  selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16,
});
const placeIx = (args: ob.PlaceOrderArgs) => ob.harnessPlaceLimitOrderIx({
  user: maker.publicKey, ooAccount: makerOo,
  userTokenAccount: args.side === ob.Side.Bid ? makerQuoteAta : makerBaseAta,
  market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
  eventHeap: heap.publicKey,
  marketVault: args.side === ob.Side.Bid ? quoteVault : baseVault, args,
});
const takeIx = (side: ob.Side, priceLots: bigint) => ob.harnessPlaceTakeOrderIx({
  user: taker.publicKey, market: market.publicKey, bids: bids.publicKey,
  asks: asks.publicKey, eventHeap: heap.publicKey,
  marketBaseVault: baseVault, marketQuoteVault: quoteVault,
  userBaseAccount: takerBaseAta, userQuoteAccount: takerQuoteAta,
  makerOoAccounts: [makerOo],
  args: { side, priceLots, maxBaseLots: 1n, maxQuoteLotsIncludingFees: priceLots,
    orderType: ob.PlaceOrderType.ImmediateOrCancel, limit: 16 },
});
async function makerCleanup() {
  await send([
    ob.cancelAllOrdersIx(maker.publicKey, makerOo, market.publicKey, bids.publicKey, asks.publicKey),
    ob.settleFundsIx({
      owner: maker.publicKey, ooAccount: makerOo, market: market.publicKey,
      marketBaseVault: baseVault, marketQuoteVault: quoteVault,
      userBaseAccount: makerBaseAta, userQuoteAccount: makerQuoteAta,
    }),
  ], [maker]);
}

before(async () => {
  conn = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try { await conn.getLatestBlockhash(); break; }
    catch { if (i > 30) throw new Error("no validator at " + RPC + " — use scripts/run-suite.sh"); await new Promise(r => setTimeout(r, 1000)); }
  }
  for (const kp of [payer, maker, taker]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 20_000_000_000);
    await conn.confirmTransaction(sig, "confirmed");
  }
  baseMint = await createMint(conn, payer, payer.publicKey, null, 6);
  quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  makerBaseAta = await createAssociatedTokenAccount(conn, payer, baseMint, maker.publicKey);
  makerQuoteAta = await createAssociatedTokenAccount(conn, payer, quoteMint, maker.publicKey);
  takerBaseAta = await createAssociatedTokenAccount(conn, payer, baseMint, taker.publicKey);
  takerQuoteAta = await createAssociatedTokenAccount(conn, payer, quoteMint, taker.publicKey);
  await mintTo(conn, payer, baseMint, makerBaseAta, payer, 100_000_000n);
  await mintTo(conn, payer, quoteMint, makerQuoteAta, payer, 100_000_000n);
  await mintTo(conn, payer, baseMint, takerBaseAta, payer, 100_000_000n);
  await mintTo(conn, payer, quoteMint, takerQuoteAta, payer, 100_000_000n);

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
    name: "G10-YES/USD", quoteLotSize: QUOTE_LOT, baseLotSize: BASE_LOT,
    makerFee: 0n, takerFee: 0n, timeExpiry: 0n,
    openOrdersAdmin: ob.venueAuthorityPda(), closeMarketAdmin: ob.venueAuthorityPda(),
  })], [payer, market]);
  const auth = ob.marketAuthorityPda(market.publicKey);
  baseVault = ob.ataFor(baseMint, auth);
  quoteVault = ob.ataFor(quoteMint, auth);

  await send([ob.harnessInitializeIx(payer.publicKey, quoteMint)], [payer]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  await send([ob.harnessCreateVenueGateIx(payer.publicKey, market.publicKey, now - 60n, now + 3600n, payer.publicKey)], [payer]);
  await send([
    ob.createOoIndexerIx(payer.publicKey, maker.publicKey),
    ob.createOoAccountIx(payer.publicKey, maker.publicKey, 1, market.publicKey),
  ], [payer, maker]);
  await send([
    ob.createOoIndexerIx(payer.publicKey, taker.publicKey),
    ob.createOoAccountIx(payer.publicKey, taker.publicKey, 1, market.publicKey),
  ], [payer, taker]);
  makerOo = ob.ooAccountPda(maker.publicKey, 1);
  takerOo = ob.ooAccountPda(taker.publicKey, 1);
});

test("G10.1 golden price vectors: P in {1,50,99} locks and fills exactly P cents per whole token", async () => {
  for (const P of [1n, 50n, 99n]) {
    const v0 = (await getAccount(conn, quoteVault)).amount;
    await send([placeIx(limitArgs(ob.Side.Bid, P, P))], [maker]);
    const v1 = (await getAccount(conn, quoteVault)).amount;
    assert.equal(v1 - v0, P * QUOTE_LOT, `bid at ${P} locks ${P} cents (P*10,000 atoms)`);
    // taker sells one whole token into the bid at exactly P cents
    const q0 = (await getAccount(conn, takerQuoteAta)).amount;
    const b0 = (await getAccount(conn, takerBaseAta)).amount;
    await send([takeIx(ob.Side.Ask, P)], [taker]);
    assert.equal((await getAccount(conn, takerQuoteAta)).amount - q0, P * QUOTE_LOT, `fill pays ${P} cents`);
    assert.equal(b0 - (await getAccount(conn, takerBaseAta)).amount, BASE_LOT, "one whole Yes Token == one base lot");
    await makerCleanup();
  }
});

test("G10.2 PostOnly crossing is a venue silent no-op; wrapper fails closed", async () => {
  await send([placeIx(limitArgs(ob.Side.Ask, 50n, 100n))], [maker]); // resting ask @ $0.50
  // strictly-crossing PostOnly bid from a DIFFERENT owner (rules out any
  // self-trade confound): venue silently drops it; wrapper fails closed
  await expectFail(send([ob.harnessPlaceLimitOrderIx({
    user: taker.publicKey, ooAccount: takerOo, userTokenAccount: takerQuoteAta,
    market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
    eventHeap: heap.publicKey, marketVault: quoteVault,
    args: limitArgs(ob.Side.Bid, 51n, 101n),
  })], [taker]), "OrderNotPosted", "crossing PostOnly must fail closed");
  // non-crossing bid rests fine
  const v0 = (await getAccount(conn, quoteVault)).amount;
  await send([placeIx(limitArgs(ob.Side.Bid, 49n, 102n))], [maker]);
  assert.equal((await getAccount(conn, quoteVault)).amount - v0, 49n * QUOTE_LOT, "non-crossing PostOnly rests");
  await makerCleanup();
});

test("G10.3 returned order ID is real: cancel_order by the logged id", async () => {
  const logs = await sendGetLogs([placeIx(limitArgs(ob.Side.Bid, 40n, 200n))], [maker]);
  const m = logs.join("\n").match(/order_id=(\d+)/);
  assert.ok(m, "wrapper logged the venue-returned order id");
  const orderId = BigInt(m![1]);
  // cancel exactly that order (owner-signed direct path)
  await send([ob.cancelOrderIx(maker.publicKey, makerOo, market.publicKey, bids.publicKey, asks.publicKey, orderId)], [maker]);
  await makerCleanup(); // settle the unlocked funds
});

test("G10.4 per-order expiry: expired maker skipped by takes; past-expiry placement fails closed", async () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  // TIF is u16 SECONDS at the pin (order.rs:47-61): expiry now+2 => tif ~2s
  await send([placeIx(limitArgs(ob.Side.Bid, 30n, 300n, now + 2n))], [maker]);
  await new Promise(r => setTimeout(r, 4000));
  // the resting order has expired: a take must find nothing and revert
  await expectFail(send([takeIx(ob.Side.Ask, 30n)], [taker]),
    "PartialFillReverted", "take against an expired order");
  // placement with expiry already in the past: venue silently ignores => wrapper reverts
  await expectFail(send([placeIx(limitArgs(ob.Side.Bid, 30n, 301n, now - 100n))], [maker]),
    "OrderNotPosted", "past-expiry placement");
  await makerCleanup();
});

test("G10.5 SelfTradeBehavior pinned to AbortTransaction (wire golden + wrapper pin)", async () => {
  // wire golden: PlaceOrderArgs = side1+price8+base8+quote8+cid8+type1+exp8+stb1+limit1 = 44 bytes
  const bytes = ob.encodePlaceOrderArgs(limitArgs(ob.Side.Bid, 50n, 400n));
  assert.equal(bytes.length, 44, "PlaceOrderArgs is 44 bytes");
  assert.equal(bytes[42], ob.SelfTradeBehavior.AbortTransaction, "STB at offset 42 == 2 (AbortTransaction)");
  // wrapper rejects BOTH non-Abort variants. On-chain STB *matching* is
  // unreachable through V1 wrappers by construction: PostOnly never crosses,
  // and place_take_order has no STB field at the pin (take-path self-cross
  // prevention is G5 work).
  await expectFail(send([placeIx({ ...limitArgs(ob.Side.Bid, 50n, 401n), selfTradeBehavior: ob.SelfTradeBehavior.DecrementTake })], [maker]),
    "SelfTradeMustAbort", "DecrementTake");
  await expectFail(send([placeIx({ ...limitArgs(ob.Side.Bid, 50n, 402n), selfTradeBehavior: ob.SelfTradeBehavior.CancelProvide })], [maker]),
    "SelfTradeMustAbort", "CancelProvide");
});

test("G10.6 boundary and overflow vectors", async () => {
  // price 0: rejected by the venue (no zero-price orders)
  await expectFail(send([placeIx(limitArgs(ob.Side.Bid, 0n, 500n))], [maker]),
    "Program log:", "price 0 must not post"); // any venue error; must not succeed silently
  // zero base lots: fails closed one way or another (venue reject or OrderNotPosted)
  await expectFail(send([placeIx({ ...limitArgs(ob.Side.Bid, 50n, 501n), maxBaseLots: 0n, maxQuoteLotsIncludingFees: 50n })], [maker]),
    "Program log:", "zero-lot order must not post");
  // absurd price: quote conversion overflows i64/u64 territory; must fail, never wrap
  await expectFail(send([placeIx({ ...limitArgs(ob.Side.Bid, (1n << 62n), 502n), maxQuoteLotsIncludingFees: (1n << 62n) })], [maker]),
    "Program log:", "overflowing price must not post");
  // price 100 ($1.00): venue-legal; Meridian's 1..99 range is client policy —
  // documented, and the order is cancelled right away
  const logs = await sendGetLogs([placeIx(limitArgs(ob.Side.Bid, 100n, 503n))], [maker]);
  assert.ok(logs.join("\n").includes("order_id="), "price 100 posts at the venue (range is product policy)");
  await makerCleanup();
  // far-future expiry (beyond the u16 TIF clamp) still posts
  const now2 = BigInt(Math.floor(Date.now() / 1000));
  const logs2 = await sendGetLogs([placeIx(limitArgs(ob.Side.Bid, 40n, 504n, now2 + 100_000n))], [maker]);
  assert.ok(logs2.join("\n").includes("order_id="), "expiry beyond 65,535s posts (TIF clamped at the pin)");
  await makerCleanup();
});

test("G10.7 per-order expiry boundary, program-clock-exact", async () => {
  // bundle [place(expiry=T), take] per attempt: while now < T the order posts
  // (TIF = T - now > 0) and fills; at now >= T the venue silently ignores the
  // placement and the wrapper reverts OrderNotPosted. gate_now logs give the
  // exact program clock per attempt.
  const T = BigInt(Math.floor(Date.now() / 1000)) + 10n;
  const results: { now: bigint; ok: boolean; logs: string }[] = [];
  for (let id = 600n; id <= 660n; id++) {
    const ixs = [
      placeIx(limitArgs(ob.Side.Bid, 30n, id, T)),
      takeIx(ob.Side.Ask, 30n),
    ];
    const tx = new Transaction().add(...ixs);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = maker.publicKey;
    tx.sign(maker, taker);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    const info = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const logs = (info!.meta?.logMessages ?? []).join("\n");
    const g = logs.match(/gate_now=(-?\d+)/);
    if (!g) continue; // pre-gate failure (shouldn't happen)
    results.push({ now: BigInt(g[1]), ok: info!.meta?.err == null, logs });
    if (results.filter(x => !x.ok).length >= 2 && results.some(x => x.ok)) break;
  }
  assert.ok(results.some(x => x.ok) && results.some(x => !x.ok), "observed both sides of the boundary");
  for (const r of results) {
    if (r.ok) assert.ok(r.now < T, `posted+filled at clock ${r.now} must precede expiry ${T}`);
    else {
      assert.ok(r.now >= T, `failure at clock ${r.now} must be at/after expiry ${T}`);
      assert.ok(r.logs.includes("OrderNotPosted"), "failure is the fail-closed unposted check");
    }
  }
});
