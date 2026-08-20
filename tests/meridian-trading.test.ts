/**
 * Meridian trading lifecycle (localnet): create market -> create venue ->
 * activate -> mint pair -> rest a PostOnly bid -> a taker fills it full ->
 * direct pair redemption. Proves the real program's four-path trading on the
 * OpenBook venue with the OutcomeMarket PDA as the sole authority.
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccount, createAssociatedTokenAccountIdempotent, createMint, getAccount, mintTo } from "@solana/spl-token";
import * as m from "./lib/meridian.js";
import * as ob from "./lib/openbook.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
let conn: Connection;
const gov = Keypair.generate(), operator = Keypair.generate();
const maker = Keypair.generate(), taker = Keypair.generate();
let quoteMint: PublicKey, market: PublicKey, yesMint: PublicKey, noMint: PublicKey, vault: PublicKey;
const obMarket = Keypair.generate(), bids = Keypair.generate(), asks = Keypair.generate(), heap = Keypair.generate();
let baseVault: PublicKey, obQuoteVault: PublicKey;
let makerQuote: PublicKey, makerYes: PublicKey, makerNo: PublicKey, makerOo: PublicKey;
let takerQuote: PublicKey, takerYes: PublicKey, takerNo: PublicKey, takerOo: PublicKey;
const OPENBOOK_PROGRAMDATA = new PublicKey("DktN5HJ9uHKVRZ7FXGap4PEGVnEdc2VNBCXTt1AqJQYB");
const AAPL = 1, DAY = 20260821, STRIKE = 230_000_000n;
const LOT = 1_000_000n; // one whole token (base lot)

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  return sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
}

before(async () => {
  conn = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try { await conn.getLatestBlockhash(); break; }
    catch { if (i > 30) throw new Error("no validator"); await new Promise(r => setTimeout(r, 1000)); }
  }
  for (const kp of [gov, operator, maker, taker]) {
    await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 30_000_000_000), "confirmed");
  }
  quoteMint = await createMint(conn, gov, gov.publicKey, null, 6);
  // config + transport + market
  await send([m.initializeConfigIx({
    governance: gov.publicKey, quoteMint, openbookProgramData: OPENBOOK_PROGRAMDATA,
    operator: operator.publicKey, pauseAuthority: gov.publicKey, overrideAuthority: gov.publicKey,
    supportedTickerMask: 0xfe, openbookDeploymentSlot: 282042596n,
    openbookExecutableSha256: Buffer.alloc(32, 0xaa), openbookUpgradeAuthority: PublicKey.default,
    minSamples: 3, maxStaleSlots: 150n, maxPriceBandBps: 50,
  })], [gov]);
  await send([m.registerTransportIx({ governance: gov.publicKey, versionId: 1, tickerId: AAPL, feed: Keypair.generate().publicKey })], [gov]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const mintOpen = now - 60n, tradeOpen = mintOpen + 1800n, close = tradeOpen + 12600n;
  // NOTE: trade window opens 30m after mint; warp by scheduling trade_open in the past
  const to = now - 30n, mo = to - 1800n, cl = to + 12600n;
  await send([m.createOutcomeMarketIx({
    operator: operator.publicKey, quoteMint, tickerId: AAPL, tradingDay: DAY, strike: STRIKE,
    versionId: 1, priorClose: 225_000_000n, mintOpenTs: mo, tradeOpenTs: to, closeTs: cl,
    metadataManifest: Buffer.alloc(32, 7), normalDelaySecs: 1200, overrideDelaySecs: 3600,
  })], [operator]);
  void mintOpen; void tradeOpen; void close; void now;
  market = m.outcomeMarketPda(AAPL, DAY, STRIKE);
  yesMint = m.yesMintPda(market); noMint = m.noMintPda(market);
  vault = m.ataFor(quoteMint, market);

  // create venue
  const bookRent = await conn.getMinimumBalanceForRentExemption(ob.BOOKSIDE_SPACE);
  const heapRent = await conn.getMinimumBalanceForRentExemption(ob.EVENT_HEAP_SPACE);
  await send([
    ob.bookAccountIx(operator.publicKey, bids, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(operator.publicKey, asks, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(operator.publicKey, heap, ob.EVENT_HEAP_SPACE, heapRent),
  ], [operator, bids, asks, heap]);
  await send([m.createVenueMarketIx({
    operator: operator.publicKey, market, obMarket: obMarket.publicKey,
    bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey,
    yesMint, quoteMint, name: "AAPL-230-YES/USD", timeExpiry: 0n,
  })], [operator, obMarket]);
  const auth = m.marketAuthorityPda(obMarket.publicKey);
  baseVault = ob.ataFor(yesMint, auth); obQuoteVault = ob.ataFor(quoteMint, auth);

  // user token accounts + funding
  for (const [u, set] of [[maker, (q:PublicKey,y:PublicKey,n:PublicKey)=>{makerQuote=q;makerYes=y;makerNo=n;}],
                          [taker, (q:PublicKey,y:PublicKey,n:PublicKey)=>{takerQuote=q;takerYes=y;takerNo=n;}]] as const) {
    const q = await createAssociatedTokenAccount(conn, gov, quoteMint, u.publicKey);
    const y = await createAssociatedTokenAccount(conn, gov, yesMint, u.publicKey);
    const n = await createAssociatedTokenAccount(conn, gov, noMint, u.publicKey);
    await mintTo(conn, gov, quoteMint, q, gov, 100_000_000n);
    set(q, y, n);
  }
  // OpenOrders for both
  for (const u of [maker, taker]) {
    await send([ob.createOoIndexerIx(operator.publicKey, u.publicKey), ob.createOoAccountIx(operator.publicKey, u.publicKey, 1, obMarket.publicKey)], [operator, u]);
  }
  makerOo = ob.ooAccountPda(maker.publicKey, 1); takerOo = ob.ooAccountPda(taker.publicKey, 1);
});

test("T1 market is Active with venue attached", async () => {
  const d = (await conn.getAccountInfo(market))!.data;
  // OutcomeMarket.state is at 8(disc)+1(schema)+1(bump)+1(ticker)+4(day)+8(strike)+8+8+8 = 47
  assert.equal(d[8 + 1 + 1 + 1 + 4 + 8 + 8 + 8 + 8], 2, "state == Active");
});

test("T2 mint_pair: q USDC -> q Yes + q No, vault holds collateral", async () => {
  await send([m.mintPairIx(maker.publicKey, market, 10n * LOT, {
    yesMint, noMint, collateralVault: vault, userQuote: makerQuote, userYes: makerYes, userNo: makerNo,
  })], [maker]);
  await send([m.mintPairIx(taker.publicKey, market, 10n * LOT, {
    yesMint, noMint, collateralVault: vault, userQuote: takerQuote, userYes: takerYes, userNo: takerNo,
  })], [taker]);
  assert.equal((await getAccount(conn, vault)).amount, 20n * LOT, "vault holds 20 collateral");
  assert.equal((await getAccount(conn, makerYes)).amount, 10n * LOT);
});

test("T3 PostOnly bid rests; a taker fills it fully (full-fill-or-revert)", async () => {
  // maker rests a Buy-Yes bid at $0.40 for 1 whole token
  await send([m.placeLimitOrderIx({
    user: maker.publicKey, market, ooAccount: makerOo, userTokenAccount: makerQuote,
    obMarket: obMarket.publicKey, bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey,
    marketVault: obQuoteVault,
    args: { side: ob.Side.Bid, priceLots: 40n, maxBaseLots: 1n, maxQuoteLotsIncludingFees: 40n,
      clientOrderId: 1n, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
      selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
  })], [maker]);
  assert.equal((await getAccount(conn, obQuoteVault)).amount, 40n * 10_000n, "bid collateral locked (0.40)");

  // taker sells 1 whole Yes into the bid (Ask take) — must fully fill
  const q0 = (await getAccount(conn, takerQuote)).amount;
  await send([m.placeTakeOrderIx({
    user: taker.publicKey, market, obMarket: obMarket.publicKey, bids: bids.publicKey, asks: asks.publicKey,
    marketBaseVault: baseVault, marketQuoteVault: obQuoteVault, eventHeap: heap.publicKey,
    userBase: takerYes, userQuote: takerQuote, makerOoAccounts: [makerOo],
    args: { side: ob.Side.Ask, priceLots: 40n, maxBaseLots: 1n, maxQuoteLotsIncludingFees: 40n,
      orderType: ob.PlaceOrderType.ImmediateOrCancel, limit: 16 },
  })], [taker]);
  assert.equal((await getAccount(conn, takerQuote)).amount - q0, 40n * 10_000n, "taker received 0.40, zero fees");
  assert.equal((await getAccount(conn, takerYes)).amount, 9n * LOT, "taker sold 1 Yes");
});

test("T4 direct Pair Redemption returns collateral", async () => {
  const q0 = (await getAccount(conn, takerQuote)).amount;
  await send([m.redeemPairDirectIx(taker.publicKey, market, 5n * LOT, {
    yesMint, noMint, collateralVault: vault, userQuote: takerQuote, userYes: takerYes, userNo: takerNo,
  })], [taker]);
  assert.equal((await getAccount(conn, takerQuote)).amount - q0, 5n * LOT, "5 pairs redeemed for 5 USDC");
});

test("T5 Sell No via redeem_no_via_market: burn No, vault buys Yes, exact invariant", async () => {
  // maker rests a Yes ASK at $0.40 (someone selling Yes) for the vault to buy
  await send([m.placeLimitOrderIx({
    user: maker.publicKey, market, ooAccount: makerOo, userTokenAccount: makerYes,
    obMarket: obMarket.publicKey, bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey,
    marketVault: baseVault,
    args: { side: ob.Side.Ask, priceLots: 40n, maxBaseLots: 2n, maxQuoteLotsIncludingFees: 80n,
      clientOrderId: 5n, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
      selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
  })], [maker]);
  // taker holds No (minted 10 pairs in T2, spent none of the No). Sell 2 No.
  // client pre-creates the program Yes-trade ATA (owner = market PDA)
  await createAssociatedTokenAccountIdempotent(conn, operator, yesMint, market, undefined, undefined, undefined, true);
  const q0 = (await getAccount(conn, takerQuote)).amount;
  const no0 = (await getAccount(conn, takerNo)).amount;
  const vault0 = (await getAccount(conn, vault)).amount;
  await send([m.redeemNoViaMarketIx(taker.publicKey, {
    market, yesMint, noMint, collateralVault: vault, userQuote: takerQuote, userNo: takerNo,
    obMarket: obMarket.publicKey, bids: bids.publicKey, asks: asks.publicKey,
    marketBaseVault: baseVault, marketQuoteVault: obQuoteVault, eventHeap: heap.publicKey,
    makerOos: [makerOo], qLots: 2n, priceLots: 40n,
  })], [taker]);
  assert.equal(no0 - (await getAccount(conn, takerNo)).amount, 2n * LOT, "2 No burned (user-signed)");
  // proceeds = q*(1 - price) = 2 * (1 - 0.40) = 1.20
  assert.equal((await getAccount(conn, takerQuote)).amount - q0, 2n * LOT - 2n * 40n * 10_000n, "proceeds = q(1-P)");
  assert.equal(vault0 - (await getAccount(conn, vault)).amount, 2n * LOT, "vault delta exactly -q (invariant)");
});
