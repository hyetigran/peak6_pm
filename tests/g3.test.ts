/**
 * G3 — Exact time/pause gates + OpenBook expiry semantics (PRD v0.7.1 §15,
 * harness-provable subset; mint/add-strike/abandonment bullets need M1 state).
 *
 * Boundary proofs are program-clock-exact: the gate logs its Clock reading
 * before any check, each attempt is sent with skipPreflight, and assertions
 * judge by that logged timestamp — the very value the checks (and the
 * OpenBook CPI in the same bank) observed. RPC blockTime is never used (it
 * is an estimate that drifts ±1s from the bank clock). The ticket's
 * "validator clock warp" method is unavailable mid-run; this is exact.
 *
 *   1. order pre-open rejected (gate clock < trade_open_ts proven)
 *   2. order while Paused rejected on BOTH wrappers; resting order survives
 *      pause; cancel + consume_events + settle work WHILE paused (ADR-0010)
 *   3. close boundary: success ⟺ clock < close_ts
 *   4. OpenBook natural expiry (time_expiry = T): success ⟺ clock ≤ T,
 *      MarketHasExpired ⟺ clock > T; recovery works after expiry
 *   5. set_market_expired: close_market_admin-only, one-way (time_expiry=-1,
 *      re-expire rejected); prune requires expired; recovery intact
 *   6. the Meridian configuration itself: time_expiry = close_ts - 1 with
 *      gate close = close_ts rejects orders at exactly close_ts
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createAssociatedTokenAccount, createMint, getAccount, mintTo } from "@solana/spl-token";
import * as ob from "./lib/openbook.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
let conn: Connection;
const payer = Keypair.generate(); // harness admin
const maker = Keypair.generate();
let baseMint: PublicKey, quoteMint: PublicKey, makerQuoteAta: PublicKey, makerBaseAta: PublicKey;
let ooIndex = 0; // maker's OpenOrders created_counter mirror

const BASE_LOT = 1_000_000n, QUOTE_LOT = 1n, PRICE = 500_000n;

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
async function expectFail(p: Promise<unknown>, needle: string, label: string) {
  try { await p; } catch (e: any) {
    const text = `${e.message}\n${(e.transactionLogs ?? e.logs ?? []).join("\n")}`;
    assert.ok(text.includes(needle), `${label}: failed but without "${needle}":\n${text}`);
    return;
  }
  assert.fail(`${label}: expected failure, but transaction succeeded`);
}
/** skipPreflight send judged by its own blockTime — exact boundary evidence. */
async function sendRaw(ixs: TransactionInstruction[], signers: Keypair[]) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: signers[0].publicKey }).add(...ixs);
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  const info = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const logs = info!.meta?.logMessages ?? [];
  // The harness logs the exact Clock reading its checks used — judge by
  // that, never by RPC blockTime (an estimate that can drift +-1s).
  const m = logs.join("\n").match(/gate_now=(-?\d+)/);
  return { gateNow: m ? BigInt(m[1]) : null, err: info!.meta?.err ?? null, logs };
}
const chainNow = async () => {
  const d = (await conn.getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111")))!.data;
  return d.readBigInt64LE(32); // unix_timestamp
};

interface Mkt { market: Keypair; bids: PublicKey; asks: PublicKey; eventHeap: PublicKey; baseVault: PublicKey; quoteVault: PublicKey; oo: PublicKey; }
async function newMarket(timeExpiry: bigint, name: string): Promise<Mkt> {
  const market = Keypair.generate(), bids = Keypair.generate(), asks = Keypair.generate(), heap = Keypair.generate();
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
    name, quoteLotSize: QUOTE_LOT, baseLotSize: BASE_LOT, makerFee: 0n, takerFee: 0n,
    timeExpiry, openOrdersAdmin: ob.venueAuthorityPda(), closeMarketAdmin: ob.venueAuthorityPda(),
  })], [payer, market]);
  ooIndex += 1;
  const ixs: TransactionInstruction[] = [];
  if (ooIndex === 1) ixs.push(ob.createOoIndexerIx(payer.publicKey, maker.publicKey));
  ixs.push(ob.createOoAccountIx(payer.publicKey, maker.publicKey, ooIndex, market.publicKey));
  await send(ixs, [payer, maker]);
  const auth = ob.marketAuthorityPda(market.publicKey);
  return {
    market, bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey,
    baseVault: ob.ataFor(baseMint, auth), quoteVault: ob.ataFor(quoteMint, auth),
    oo: ob.ooAccountPda(maker.publicKey, ooIndex),
  };
}
const bidArgs = (id: bigint): ob.PlaceOrderArgs => ({
  side: ob.Side.Bid, priceLots: PRICE, maxBaseLots: 1n, maxQuoteLotsIncludingFees: PRICE,
  clientOrderId: id, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
  selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16,
});
const placeIx = (m: Mkt, id: bigint) => ob.harnessPlaceLimitOrderIx({
  user: maker.publicKey, ooAccount: m.oo, userTokenAccount: makerQuoteAta,
  market: m.market.publicKey, bids: m.bids, asks: m.asks, eventHeap: m.eventHeap,
  marketVault: m.quoteVault, args: bidArgs(id),
});
const recoveryIxs = (m: Mkt) => [
  ob.cancelAllOrdersIx(maker.publicKey, m.oo, m.market.publicKey, m.bids, m.asks),
  ob.settleFundsIx({
    owner: maker.publicKey, ooAccount: m.oo, market: m.market.publicKey,
    marketBaseVault: m.baseVault, marketQuoteVault: m.quoteVault,
    userBaseAccount: makerBaseAta, userQuoteAccount: makerQuoteAta,
  }),
];

/** Probe a time boundary: place+cancel per attempt until both sides observed. */
async function probeBoundary(m: Mkt) {
  const results: { now: bigint; ok: boolean; logs: string }[] = [];
  for (let id = 1n; id <= 60n; id++) {
    // cancel in the same tx: a success must not leave a resting order, or the
    // 24-slot OpenOrders capacity (open_orders_account.rs:12) fills mid-loop
    const r = await sendRaw([placeIx(m, id), ob.cancelAllOrdersIx(maker.publicKey, m.oo, m.market.publicKey, m.bids, m.asks)], [maker]);
    assert.ok(r.gateNow !== null, "gate logged its clock");
    results.push({ now: r.gateNow!, ok: r.err === null, logs: r.logs.join("\n") });
    if (results.filter(x => !x.ok).length >= 2 && results.some(x => x.ok)) break;
  }
  assert.ok(results.some(x => x.ok) && results.some(x => !x.ok), "observed both sides of the boundary");
  return results;
}

before(async () => {
  conn = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try { await conn.getLatestBlockhash(); break; }
    catch { if (i > 30) throw new Error("no validator at " + RPC + " — use scripts/run-suite.sh"); await new Promise(r => setTimeout(r, 1000)); }
  }
  for (const kp of [payer, maker]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 50_000_000_000);
    await conn.confirmTransaction(sig, "confirmed");
  }
  baseMint = await createMint(conn, payer, payer.publicKey, null, 6);
  quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  makerQuoteAta = await createAssociatedTokenAccount(conn, payer, quoteMint, maker.publicKey);
  makerBaseAta = await createAssociatedTokenAccount(conn, payer, baseMint, maker.publicKey);
  await mintTo(conn, payer, quoteMint, makerQuoteAta, payer, 1_000_000_000n);
  await send([ob.harnessInitializeIx(payer.publicKey)], [payer]);
});

test("G3.1 order pre-open rejected, program-clock-exact", async () => {
  const m = await newMarket(0n, "G3-preopen");
  const open = (await chainNow()) + 3600n;
  await send([ob.harnessCreateVenueGateIx(payer.publicKey, m.market.publicKey, open, open + 3600n, payer.publicKey)], [payer]);
  const r = await sendRaw([placeIx(m, 1n)], [maker]);
  assert.notEqual(r.err, null, "pre-open order must fail");
  assert.ok(r.logs.join("\n").includes("OrderBeforeOpen"), "fails with OrderBeforeOpen");
  assert.ok(r.gateNow !== null && r.gateNow < open, `gate clock ${r.gateNow} precedes trade_open ${open}`);
});

test("G3.2 pause rejects orders, preserves resting orders, keeps recovery open (ADR-0010)", async () => {
  const m = await newMarket(0n, "G3-pause");
  const now = await chainNow();
  await send([ob.harnessCreateVenueGateIx(payer.publicKey, m.market.publicKey, now - 60n, now + 3600n, payer.publicKey)], [payer]);

  const quoteBefore = (await getAccount(conn, makerQuoteAta)).amount;
  await send([placeIx(m, 1n)], [maker]); // resting bid: 0.50 locked
  assert.equal((await getAccount(conn, m.quoteVault)).amount, PRICE * QUOTE_LOT, "bid collateral locked");

  await send([ob.harnessSetPausedIx(payer.publicKey, m.market.publicKey, true)], [payer]);
  await expectFail(send([placeIx(m, 2n)], [maker]), "VenuePaused", "maker order while paused");
  await expectFail(send([ob.harnessPlaceTakeOrderIx({
    user: maker.publicKey, market: m.market.publicKey, bids: m.bids, asks: m.asks,
    eventHeap: m.eventHeap, marketBaseVault: m.baseVault, marketQuoteVault: m.quoteVault,
    userBaseAccount: makerBaseAta, userQuoteAccount: makerQuoteAta, makerOoAccounts: [],
    args: { side: ob.Side.Ask, priceLots: PRICE, maxBaseLots: 1n, maxQuoteLotsIncludingFees: PRICE,
      orderType: ob.PlaceOrderType.ImmediateOrCancel, limit: 16 },
  })], [maker]), "VenuePaused", "take order while paused");
  // resting order untouched by pause
  assert.equal((await getAccount(conn, m.quoteVault)).amount, PRICE * QUOTE_LOT, "resting order survives pause");
  // recovery works WHILE paused: consume_events (permissionless crank) + cancel + settle
  await send([ob.consumeEventsIx(m.market.publicKey, m.eventHeap, 8n)], [maker]);
  await send(recoveryIxs(m), [maker]);
  assert.equal((await getAccount(conn, makerQuoteAta)).amount, quoteBefore, "funds recovered while paused");

  await send([ob.harnessSetPausedIx(payer.publicKey, m.market.publicKey, false)], [payer]);
  await send([placeIx(m, 3n)], [maker]); // unpause resumes
});

test("G3.3 close boundary: success iff program clock < close_ts", async () => {
  const m = await newMarket(0n, "G3-close");
  const close = (await chainNow()) + 12n;
  await send([ob.harnessCreateVenueGateIx(payer.publicKey, m.market.publicKey, close - 3600n, close, payer.publicKey)], [payer]);
  const results = await probeBoundary(m);
  for (const r of results) {
    if (r.ok) assert.ok(r.now < close, `success at clock ${r.now} must precede close ${close}`);
    else {
      assert.ok(r.now >= close, `failure at clock ${r.now} must be at/after close ${close}`);
      assert.ok(r.logs.includes("TradingClosed"), "failure is TradingClosed");
    }
  }
});

test("G3.4 OpenBook expiry boundary: success iff program clock <= time_expiry; recovery after", async () => {
  const T = (await chainNow()) + 14n;
  const m = await newMarket(T, "G3-expiry");
  await send([ob.harnessCreateVenueGateIx(payer.publicKey, m.market.publicKey, T - 3600n, T + 3600n, payer.publicKey)], [payer]);
  const quoteBefore = (await getAccount(conn, makerQuoteAta)).amount;
  const results = await probeBoundary(m);
  for (const r of results) {
    // pinned predicate is strict: expired iff time_expiry < now  (market.rs:165-167)
    if (r.ok) assert.ok(r.now <= T, `success at clock ${r.now} must be at/before T ${T}`);
    else {
      assert.ok(r.now > T, `failure at clock ${r.now} must be after T ${T}; logs:\n${r.logs}`);
      assert.ok(r.logs.includes("MarketHasExpired"), "failure is MarketHasExpired");
    }
  }
  await send(recoveryIxs(m), [maker]); // cancel + settle after natural expiry
  assert.equal((await getAccount(conn, makerQuoteAta)).amount, quoteBefore, "funds recovered after expiry");
});

test("G3.5 set_market_expired: admin-only one-way fuse; recovery intact (ADR-0018)", async () => {
  const m = await newMarket(0n, "G3-fuse");
  const now = await chainNow();
  await send([ob.harnessCreateVenueGateIx(payer.publicKey, m.market.publicKey, now - 60n, now + 3600n, payer.publicKey)], [payer]);
  const quoteBefore = (await getAccount(conn, makerQuoteAta)).amount;
  await send([placeIx(m, 1n)], [maker]); // resting order through the fuse

  // direct call with a non-admin signer fails at OpenBook
  await expectFail(send([ob.directSetMarketExpiredIx(maker.publicKey, m.market.publicKey)], [maker]),
    "InvalidCloseMarketAdmin", "direct set_market_expired, wrong admin");
  // harness path is admin-gated
  await expectFail(send([ob.harnessExpireMarketIx(maker.publicKey, m.market.publicKey)], [maker]),
    "NotAdmin", "expire_market by non-admin");

  // prune requires the Venue Market to BE expired (instructions/prune_orders.rs)
  await expectFail(send([ob.harnessPruneOrdersIx(payer.publicKey, {
    ooAccount: m.oo, market: m.market.publicKey, bids: m.bids, asks: m.asks, limit: 8,
  })], [payer]), "MarketHasNotExpired", "prune before expiry");

  await send([ob.harnessExpireMarketIx(payer.publicKey, m.market.publicKey)], [payer]);
  const data = (await conn.getAccountInfo(m.market.publicKey))!.data;
  assert.equal(ob.readTimeExpiry(data), -1n, "time_expiry set to -1 at the pin");

  await expectFail(send([placeIx(m, 2n)], [maker]), "MarketHasExpired", "order after fuse");
  await expectFail(send([ob.harnessExpireMarketIx(payer.publicKey, m.market.publicKey)], [payer]),
    "MarketHasExpired", "fuse is one-way: re-expire rejected at the pin");

  // after the fuse, close_market_admin prune cancels the user's resting order
  await send([ob.harnessPruneOrdersIx(payer.publicKey, {
    ooAccount: m.oo, market: m.market.publicKey, bids: m.bids, asks: m.asks, limit: 8,
  })], [payer]);
  await send([ob.settleFundsIx({
    owner: maker.publicKey, ooAccount: m.oo, market: m.market.publicKey,
    marketBaseVault: m.baseVault, marketQuoteVault: m.quoteVault,
    userBaseAccount: makerBaseAta, userQuoteAccount: makerQuoteAta,
  })], [maker]);
  assert.equal((await getAccount(conn, makerQuoteAta)).amount, quoteBefore, "funds recovered after fuse via prune + settle");
});

test("G3.6 Meridian config: time_expiry = close_ts - 1 rejects at exactly close_ts", async () => {
  const close = (await chainNow()) + 14n;
  const m = await newMarket(close - 1n, "G3-meridian"); // the Meridian rule itself
  await send([ob.harnessCreateVenueGateIx(payer.publicKey, m.market.publicKey, close - 3600n, close, payer.publicKey)], [payer]);
  const results = await probeBoundary(m);
  for (const r of results) {
    // defense in depth: gate rejects at clock >= close_ts; even without it,
    // OpenBook's strict predicate (time_expiry = close_ts - 1 < clock) rejects
    if (r.ok) assert.ok(r.now < close, `success at clock ${r.now} must precede close ${close}`);
    else {
      assert.ok(r.now >= close, `failure at clock ${r.now} must be at/after close ${close}`);
      assert.ok(r.logs.includes("TradingClosed") || r.logs.includes("MarketHasExpired"),
        "rejected by the gate or the venue expiry");
    }
  }
});
