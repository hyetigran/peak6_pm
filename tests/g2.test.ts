/**
 * G2 — PDA universal order gate (PRD v0.7 §15).
 *
 * Proves, against the pinned OpenBook v1.7 bytes at the ADR-0029 program ID:
 *   1. direct maker order without the PDA admin fails;
 *   2. direct maker order naming the PDA without its signature fails;
 *   3. direct place_take_order without the PDA admin fails;
 *   4. Meridian-style CPI (maker + taker) succeeds and moves funds;
 *   5. discriminator golden tests for the hand-rolled adapter.
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccount, createMint, getAccount, mintTo } from "@solana/spl-token";
import * as ob from "./lib/openbook.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
let conn: Connection;
const payer = Keypair.generate();     // admin + fee payer
const maker = Keypair.generate();
const taker = Keypair.generate();
const market = Keypair.generate();
const bids = Keypair.generate();
const asks = Keypair.generate();
const eventHeap = Keypair.generate();
let baseMint: PublicKey, quoteMint: PublicKey;
let makerQuoteAta: PublicKey, takerBaseAta: PublicKey, takerQuoteAta: PublicKey;
let baseVault: PublicKey, quoteVault: PublicKey;

const BASE_LOT = 1_000_000n; // 1 whole 6dp token per base lot
const QUOTE_LOT = 1n;        // 1 quote atom per quote lot
const PRICE_LOTS = 500_000n; // 0.50 quote per whole base token

async function send(ixs: Parameters<Transaction["add"]>, signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}

/** Expect failure whose logs (or message) contain `needle`. */
async function expectFail(p: Promise<unknown>, needle: string, label: string) {
  try {
    await p;
  } catch (e: any) {
    const text = `${e.message}\n${(e.transactionLogs ?? e.logs ?? []).join("\n")}`;
    assert.ok(text.includes(needle), `${label}: failed but without "${needle}":\n${text}`);
    return;
  }
  assert.fail(`${label}: expected failure, but transaction succeeded`);
}

before(async () => {
  // scripts/run-g2.sh starts the validator; we only connect.
  conn = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try { await conn.getLatestBlockhash(); break; }
    catch { if (i > 30) throw new Error("no validator at " + RPC + " — use scripts/run-g2.sh"); await new Promise(r => setTimeout(r, 1000)); }
  }
  for (const kp of [payer, maker, taker]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 20_000_000_000);
    await conn.confirmTransaction(sig, "confirmed");
  }
  baseMint = await createMint(conn, payer, payer.publicKey, null, 6);
  quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  makerQuoteAta = await createAssociatedTokenAccount(conn, payer, quoteMint, maker.publicKey);
  takerBaseAta = await createAssociatedTokenAccount(conn, payer, baseMint, taker.publicKey);
  takerQuoteAta = await createAssociatedTokenAccount(conn, payer, quoteMint, taker.publicKey);
  await mintTo(conn, payer, quoteMint, makerQuoteAta, payer, 100_000_000n);
  await mintTo(conn, payer, quoteMint, takerQuoteAta, payer, 100_000_000n);

  const auth = ob.marketAuthorityPda(market.publicKey);
  baseVault = ob.ataFor(baseMint, auth);
  quoteVault = ob.ataFor(quoteMint, auth);

  // Pre-create zeroed book accounts (sizes: ts/client/src/client.ts:65-66 at pin)
  const bookRent = await conn.getMinimumBalanceForRentExemption(ob.BOOKSIDE_SPACE);
  const heapRent = await conn.getMinimumBalanceForRentExemption(ob.EVENT_HEAP_SPACE);
  await send([
    ob.bookAccountIx(payer.publicKey, bids, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(payer.publicKey, asks, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(payer.publicKey, eventHeap, ob.EVENT_HEAP_SPACE, heapRent),
  ], [payer, bids, asks, eventHeap]);

  // Market with venue_authority PDA as open_orders_admin, zero fees, sentinel fee admin
  await send([ob.createMarketIx({
    market: market.publicKey, payer: payer.publicKey, baseMint, quoteMint,
    bids: bids.publicKey, asks: asks.publicKey, eventHeap: eventHeap.publicKey,
    name: "G2-YES/USD", quoteLotSize: QUOTE_LOT, baseLotSize: BASE_LOT,
    makerFee: 0n, takerFee: 0n, timeExpiry: 0n,
    openOrdersAdmin: ob.venueAuthorityPda(), closeMarketAdmin: ob.venueAuthorityPda(),
  })], [payer, market]);

  // Harness config + wide-open venue gate + OpenOrders accounts for both users
  await send([ob.harnessInitializeIx(payer.publicKey, quoteMint)], [payer]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  await send([ob.harnessCreateVenueGateIx(payer.publicKey, market.publicKey, now - 60n, now + 3600n, payer.publicKey)], [payer]);
  for (const u of [maker, taker]) {
    await send([
      ob.createOoIndexerIx(payer.publicKey, u.publicKey),
      ob.createOoAccountIx(payer.publicKey, u.publicKey, 1, market.publicKey),
    ], [payer, u]);
  }
});


const bidArgs = (): ob.PlaceOrderArgs => ({
  side: ob.Side.Bid, priceLots: PRICE_LOTS, maxBaseLots: 1n,
  maxQuoteLotsIncludingFees: PRICE_LOTS, clientOrderId: 1n,
  orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
  selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16,
});

test("G2 discriminator golden tests (protect pin evidence: place_order/place_take_order encoding)", () => {
  assert.deepEqual([...ob.disc("place_order")], [51, 194, 155, 175, 109, 130, 96, 106]);
  assert.deepEqual([...ob.disc("place_take_order")], [3, 44, 71, 3, 26, 199, 203, 85]);
  assert.deepEqual([...ob.disc("create_market")], [103, 226, 97, 235, 200, 188, 251, 254]);
});

test("G2.1 direct maker order with admin=None fails (InvalidOpenOrdersAdmin)", async () => {
  await expectFail(send([ob.directPlaceOrderIx({
    signer: maker.publicKey, ooAccount: ob.ooAccountPda(maker.publicKey, 1),
    userTokenAccount: makerQuoteAta, market: market.publicKey,
    bids: bids.publicKey, asks: asks.publicKey, eventHeap: eventHeap.publicKey,
    marketVault: quoteVault,
    adminMeta: { pubkey: ob.OPENBOOK_PID, isSigner: false, isWritable: false },
    args: bidArgs(),
  })], [maker]), "InvalidOpenOrdersAdmin", "direct place_order, admin=None");
});

test("G2.2 direct maker order naming the PDA without its signature fails", async () => {
  await expectFail(send([ob.directPlaceOrderIx({
    signer: maker.publicKey, ooAccount: ob.ooAccountPda(maker.publicKey, 1),
    userTokenAccount: makerQuoteAta, market: market.publicKey,
    bids: bids.publicKey, asks: asks.publicKey, eventHeap: eventHeap.publicKey,
    marketVault: quoteVault,
    adminMeta: { pubkey: ob.venueAuthorityPda(), isSigner: false, isWritable: false },
    args: bidArgs(),
  })], [maker]), "AccountNotSigner", "direct place_order, PDA unsigned");
});

test("G2.3 direct place_take_order with admin=None fails (InvalidOpenOrdersAdmin)", async () => {
  await expectFail(send([ob.directPlaceTakeOrderIx({
    signer: taker.publicKey, market: market.publicKey,
    bids: bids.publicKey, asks: asks.publicKey, eventHeap: eventHeap.publicKey,
    marketBaseVault: baseVault, marketQuoteVault: quoteVault,
    userBaseAccount: takerBaseAta, userQuoteAccount: takerQuoteAta,
    adminMeta: { pubkey: ob.OPENBOOK_PID, isSigner: false, isWritable: false },
    args: {
      side: ob.Side.Bid, priceLots: PRICE_LOTS, maxBaseLots: 1n,
      maxQuoteLotsIncludingFees: PRICE_LOTS, orderType: ob.PlaceOrderType.ImmediateOrCancel, limit: 16,
    },
  })], [taker]), "InvalidOpenOrdersAdmin", "direct place_take_order, admin=None");
});

test("G2.4 harness CPI maker order (PostOnly bid) succeeds and locks funds", async () => {
  const before = (await getAccount(conn, quoteVault)).amount;
  await send([ob.harnessPlaceLimitOrderIx({
    user: maker.publicKey, ooAccount: ob.ooAccountPda(maker.publicKey, 1),
    userTokenAccount: makerQuoteAta, market: market.publicKey,
    bids: bids.publicKey, asks: asks.publicKey, eventHeap: eventHeap.publicKey,
    marketVault: quoteVault, args: bidArgs(),
  })], [maker]);
  const after = (await getAccount(conn, quoteVault)).amount;
  assert.equal(after - before, 500_000n, "bid collateral (1 lot @ 0.50) locked in quote vault");
});

test("G2.5 harness rejects non-PostOnly limit orders (V1 policy)", async () => {
  await expectFail(send([ob.harnessPlaceLimitOrderIx({
    user: maker.publicKey, ooAccount: ob.ooAccountPda(maker.publicKey, 1),
    userTokenAccount: makerQuoteAta, market: market.publicKey,
    bids: bids.publicKey, asks: asks.publicKey, eventHeap: eventHeap.publicKey,
    marketVault: quoteVault, args: { ...bidArgs(), clientOrderId: 2n, orderType: ob.PlaceOrderType.Limit },
  })], [maker]), "LimitOrdersMustBePostOnly", "harness limit order, non-PostOnly");
});

test("G2.6 harness CPI take order fills against the resting bid (inline maker settle)", async () => {
  // taker needs base to sell into the resting bid
  await mintTo(conn, payer, baseMint, takerBaseAta, payer, 10_000_000n);
  const quoteBefore = (await getAccount(conn, takerQuoteAta)).amount;
  await send([ob.harnessPlaceTakeOrderIx({
    user: taker.publicKey, market: market.publicKey,
    bids: bids.publicKey, asks: asks.publicKey, eventHeap: eventHeap.publicKey,
    marketBaseVault: baseVault, marketQuoteVault: quoteVault,
    userBaseAccount: takerBaseAta, userQuoteAccount: takerQuoteAta,
    makerOoAccounts: [ob.ooAccountPda(maker.publicKey, 1)],
    args: {
      side: ob.Side.Ask, priceLots: PRICE_LOTS, maxBaseLots: 1n,
      maxQuoteLotsIncludingFees: PRICE_LOTS, orderType: ob.PlaceOrderType.ImmediateOrCancel, limit: 16,
    },
  })], [taker]);
  const quoteAfter = (await getAccount(conn, takerQuoteAta)).amount;
  assert.equal(quoteAfter - quoteBefore, 500_000n, "taker received 0.50 quote for 1 base lot at zero fees");
});
