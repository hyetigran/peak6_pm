/**
 * G4 — Full-fill rollback (PRD v0.7.1 §15).
 *
 * Market Actions are full-fill-or-revert: the take wrapper's exact-delta
 * postcondition (user base account must change by exactly max_base_lots ×
 * base_lot_size) fails on any partial fill, reverting every OpenBook, token,
 * and Meridian change in the transaction.
 *
 *   1. exact-liquidity Buy (Bid take): fills fully, zero-fee arithmetic exact
 *   2. insufficient-liquidity Buy: OpenBook fills partially, postcondition
 *      reverts; taker AND maker/vault state proven unchanged
 *   3. exact-liquidity Sell (Ask take): fills fully, exact
 *   4. insufficient-liquidity Sell: reverts, state unchanged
 *   5. empty-book take: reverts (zero fill ≠ requested)
 *   6. Market lot-size offsets golden-tested against creation values
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createAssociatedTokenAccount, createMint, getAccount, mintTo } from "@solana/spl-token";
import * as ob from "@meridian/sdk/openbook";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
let conn: Connection;
const payer = Keypair.generate();
const maker = Keypair.generate();
const taker = Keypair.generate();
const market = Keypair.generate(), bids = Keypair.generate(), asks = Keypair.generate(), heap = Keypair.generate();
let baseMint: PublicKey, quoteMint: PublicKey;
let makerBaseAta: PublicKey, makerQuoteAta: PublicKey, takerBaseAta: PublicKey, takerQuoteAta: PublicKey;
let baseVault: PublicKey, quoteVault: PublicKey, makerOo: PublicKey, takerOo: PublicKey;

const BASE_LOT = 1_000_000n, QUOTE_LOT = 1n, PRICE = 500_000n;
const ONE_LOT_BASE = BASE_LOT;            // base atoms per lot
const ONE_LOT_QUOTE = PRICE * QUOTE_LOT;  // quote atoms per lot at PRICE

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

const restIx = (side: ob.Side, id: bigint) => ob.harnessPlaceLimitOrderIx({
  user: maker.publicKey, ooAccount: makerOo,
  userTokenAccount: side === ob.Side.Bid ? makerQuoteAta : makerBaseAta,
  market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
  eventHeap: heap.publicKey,
  marketVault: side === ob.Side.Bid ? quoteVault : baseVault,
  args: {
    side, priceLots: PRICE, maxBaseLots: 1n, maxQuoteLotsIncludingFees: PRICE,
    clientOrderId: id, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
    selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16,
  },
});
const takeIx = (side: ob.Side, lots: bigint) => ob.harnessPlaceTakeOrderIx({
  user: taker.publicKey, market: market.publicKey, bids: bids.publicKey,
  asks: asks.publicKey, eventHeap: heap.publicKey,
  marketBaseVault: baseVault, marketQuoteVault: quoteVault,
  userBaseAccount: takerBaseAta, userQuoteAccount: takerQuoteAta,
  makerOoAccounts: [makerOo],
  args: {
    side, priceLots: PRICE, maxBaseLots: lots,
    maxQuoteLotsIncludingFees: PRICE * lots,
    orderType: ob.PlaceOrderType.ImmediateOrCancel, limit: 16,
  },
});
/** Every token balance a failed Market Action must leave untouched. */
async function snapshot() {
  return {
    takerBase: (await getAccount(conn, takerBaseAta)).amount,
    takerQuote: (await getAccount(conn, takerQuoteAta)).amount,
    makerBase: (await getAccount(conn, makerBaseAta)).amount,
    makerQuote: (await getAccount(conn, makerQuoteAta)).amount,
    baseVault: (await getAccount(conn, baseVault)).amount,
    quoteVault: (await getAccount(conn, quoteVault)).amount,
  };
}
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
    name: "G4-YES/USD", quoteLotSize: QUOTE_LOT, baseLotSize: BASE_LOT,
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

test("G4.6 Market lot-size offsets golden-tested (offsets 448/456)", async () => {
  const data = (await conn.getAccountInfo(market.publicKey))!.data;
  assert.equal(data.readBigInt64LE(ob.MARKET_QUOTE_LOT_SIZE_OFFSET), QUOTE_LOT, "quote_lot_size at offset 448");
  assert.equal(data.readBigInt64LE(ob.MARKET_BASE_LOT_SIZE_OFFSET), BASE_LOT, "base_lot_size at offset 456");
});

test("G4.1 exact-liquidity Buy fills fully with exact zero-fee arithmetic", async () => {
  await send([restIx(ob.Side.Ask, 1n)], [maker]);
  const s0 = await snapshot();
  await send([takeIx(ob.Side.Bid, 1n)], [taker]);
  const s1 = await snapshot();
  assert.equal(s1.takerBase - s0.takerBase, ONE_LOT_BASE, "taker received exactly 1 lot of base");
  assert.equal(s0.takerQuote - s1.takerQuote, ONE_LOT_QUOTE, "taker paid exactly 0.50, zero fees");
  await makerCleanup();
});

test("G4.2 insufficient-liquidity Buy reverts; every balance unchanged", async () => {
  await send([restIx(ob.Side.Ask, 2n)], [maker]); // 1 lot resting, taker wants 2
  const s0 = await snapshot();
  await expectFail(send([takeIx(ob.Side.Bid, 2n)], [taker]),
    "PartialFillReverted", "partial Buy must revert");
  assert.deepEqual(await snapshot(), s0, "all balances unchanged after revert");
  // functional rollback proof: the resting order SURVIVED the failed take —
  // a 1-lot take against the very same order now fills fully
  await send([takeIx(ob.Side.Bid, 1n)], [taker]);
  const s1 = await snapshot();
  assert.equal(s1.takerBase - s0.takerBase, ONE_LOT_BASE, "surviving order filled after the revert");
  await makerCleanup();
});

test("G4.3 exact-liquidity Sell fills fully with exact zero-fee arithmetic", async () => {
  await send([restIx(ob.Side.Bid, 3n)], [maker]);
  const s0 = await snapshot();
  await send([takeIx(ob.Side.Ask, 1n)], [taker]);
  const s1 = await snapshot();
  assert.equal(s0.takerBase - s1.takerBase, ONE_LOT_BASE, "taker sold exactly 1 lot of base");
  assert.equal(s1.takerQuote - s0.takerQuote, ONE_LOT_QUOTE, "taker received exactly 0.50, zero fees");
  await makerCleanup();
});

test("G4.4 insufficient-liquidity Sell reverts; every balance unchanged", async () => {
  await send([restIx(ob.Side.Bid, 4n)], [maker]);
  const s0 = await snapshot();
  await expectFail(send([takeIx(ob.Side.Ask, 2n)], [taker]),
    "PartialFillReverted", "partial Sell must revert");
  assert.deepEqual(await snapshot(), s0, "all balances unchanged after revert");
  // functional rollback proof for the Ask perspective too
  await send([takeIx(ob.Side.Ask, 1n)], [taker]);
  const s1 = await snapshot();
  assert.equal(s1.takerQuote - s0.takerQuote, ONE_LOT_QUOTE, "surviving bid filled after the revert");
  await makerCleanup();
});

test("G4.5 empty-book take reverts (zero fill != requested)", async () => {
  const s0 = await snapshot();
  await expectFail(send([takeIx(ob.Side.Bid, 1n)], [taker]),
    "PartialFillReverted", "empty-book take must revert");
  assert.deepEqual(await snapshot(), s0, "no state change on empty-book revert");
});
