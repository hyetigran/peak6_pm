/**
 * Venue closure / rent recycling (ADR-0027, localnet-featured build):
 * create -> venue -> mint -> maker rests a bid -> close_ts -> finalize ->
 * settle -> prune_venue_orders -> owner settle_funds -> close_venue.
 *
 * Proves: close is refused while the market trades, while user deposits
 * remain, and to any destination but the snapshotted refund address; prune
 * is permissionless and expires the venue one-way; close returns the
 * OpenBook market/bids/asks/heap rent to the operator and is one-shot.
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccount, createMint, getAccount, mintTo } from "@solana/spl-token";
import * as m from "@meridian/sdk/meridian";
import * as ob from "@meridian/sdk/openbook";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
let conn: Connection;
const gov = Keypair.generate(), operator = Keypair.generate(), maker = Keypair.generate(), stranger = Keypair.generate();
const obMarket = Keypair.generate(), bids = Keypair.generate(), asks = Keypair.generate(), heap = Keypair.generate();
let quoteMint: PublicKey, market: PublicKey, yesMint: PublicKey, noMint: PublicKey, vault: PublicKey, feed: PublicKey;
let makerQuote: PublicKey, makerYes: PublicKey, makerNo: PublicKey, makerOo: PublicKey;
let baseVault: PublicKey, obQuoteVault: PublicKey;
const OPENBOOK_PROGRAMDATA = new PublicKey("DktN5HJ9uHKVRZ7FXGap4PEGVnEdc2VNBCXTt1AqJQYB");
const AAPL = 1, DAY = 20260824, STRIKE = 230_000_000n;
const LOT = 1_000_000n;
let CLOSE = 0n;

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  return sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
}
async function expectFail(p: Promise<unknown>, needle: string, what: string) {
  try { await p; } catch (e: any) {
    const text = `${e.message ?? ""}\n${(e.logs ?? e.transactionLogs ?? []).join("\n")}`;
    assert.ok(text.includes(needle), `${what}: expected "${needle}" in:\n${text.slice(0, 600)}`);
    return;
  }
  assert.fail(`${what}: expected failure "${needle}" but succeeded`);
}
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
async function chainNow(): Promise<bigint> {
  const d = (await conn.getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111")))!.data;
  return d.readBigInt64LE(32);
}
function finalizeNormalIx(cranker: PublicKey, slot: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: m.MERIDIAN_PID,
    keys: [
      { pubkey: cranker, isSigner: true, isWritable: true },
      { pubkey: m.configPda(), isSigner: false, isWritable: false },
      { pubkey: m.settlementRecordPda(AAPL, DAY), isSigner: false, isWritable: true },
      { pubkey: feed, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([m.disc("finalize_settlement_normal"), u64(0n), Buffer.from([1]),
      i64(BigInt(Math.floor(Date.now() / 1000))), u64(slot), Buffer.from([3]), Buffer.alloc(32, 9)]),
  });
}
function settleMarketIx(cranker: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: m.MERIDIAN_PID,
    keys: [
      { pubkey: cranker, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: m.settlementRecordPda(AAPL, DAY), isSigner: false, isWritable: false },
    ],
    data: m.disc("settle_market"),
  });
}
const closeIx = (dest: PublicKey) => m.closeVenueIx({
  market, obMarket: obMarket.publicKey, bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey, solDestination: dest,
});
const pruneIx = () => m.pruneVenueOrdersIx({
  market, obMarket: obMarket.publicKey, ooAccount: makerOo, bids: bids.publicKey, asks: asks.publicKey,
});

before(async () => {
  conn = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try { await conn.getLatestBlockhash(); break; }
    catch { if (i > 30) throw new Error("no validator"); await new Promise(r => setTimeout(r, 1000)); }
  }
  for (const kp of [gov, operator, maker, stranger]) {
    await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 20_000_000_000), "confirmed");
  }
  quoteMint = await createMint(conn, gov, gov.publicKey, null, 6);
  feed = ob.mockFeedPda(AAPL);
  await send([m.initializeConfigIx({
    governance: gov.publicKey, quoteMint, openbookProgramData: OPENBOOK_PROGRAMDATA,
    operator: operator.publicKey, pauseAuthority: gov.publicKey, overrideAuthority: gov.publicKey,
    supportedTickerMask: 0xfe, openbookDeploymentSlot: 282042596n,
    openbookExecutableSha256: Buffer.alloc(32, 0xaa), openbookUpgradeAuthority: PublicKey.default,
    minSamples: 3, maxStaleSlots: 1_000_000n, maxPriceBandBps: 50,
  })], [gov]);
  await send([m.registerTransportIx({ governance: gov.publicKey, versionId: 1, tickerId: AAPL, feed, oracleProgram: ob.HARNESS_PID })], [gov]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  CLOSE = now + 45n; // localnet build: short session, normal delay 0
  await send([m.createOutcomeMarketIx({
    operator: operator.publicKey, quoteMint, tickerId: AAPL, tradingDay: DAY, strike: STRIKE,
    versionId: 1, priorClose: 225_000_000n, mintOpenTs: now - 100n, tradeOpenTs: now - 50n, closeTs: CLOSE,
    metadataManifest: Buffer.alloc(32, 7), normalDelaySecs: 0, overrideDelaySecs: 0,
  })], [operator]);
  market = m.outcomeMarketPda(AAPL, DAY, STRIKE);
  yesMint = m.yesMintPda(market); noMint = m.noMintPda(market); vault = m.ataFor(quoteMint, market);

  // venue (operator funds the books/heap; time_expiry 0 = never, like the seed)
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

  makerQuote = await createAssociatedTokenAccount(conn, gov, quoteMint, maker.publicKey);
  makerYes = await createAssociatedTokenAccount(conn, gov, yesMint, maker.publicKey);
  makerNo = await createAssociatedTokenAccount(conn, gov, noMint, maker.publicKey);
  await mintTo(conn, gov, quoteMint, makerQuote, gov, 100_000_000n);
  await send([ob.createOoIndexerIx(operator.publicKey, maker.publicKey), ob.createOoAccountIx(operator.publicKey, maker.publicKey, 1, obMarket.publicKey)], [operator, maker]);
  makerOo = ob.ooAccountPda(maker.publicKey, 1);

  await send([m.mintPairIx(maker.publicKey, market, 10n * LOT, {
    yesMint, noMint, collateralVault: vault, userQuote: makerQuote, userYes: makerYes, userNo: makerNo,
  })], [maker]);
  // a resting Buy-Yes bid at $0.40 x 1 — locks 0.40 USDC in the venue quote vault
  await send([m.placeLimitOrderIx({
    user: maker.publicKey, market, ooAccount: makerOo, userTokenAccount: makerQuote,
    obMarket: obMarket.publicKey, bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey,
    marketVault: obQuoteVault,
    args: { side: ob.Side.Bid, priceLots: 40n, maxBaseLots: 1n, maxQuoteLotsIncludingFees: 40n,
      clientOrderId: 1n, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
      selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
  })], [maker]);
  assert.equal((await getAccount(conn, obQuoteVault)).amount, 40n * 10_000n, "bid collateral locked");
});

test("V1 close_venue / prune refused while the market is Active", async () => {
  await expectFail(send([closeIx(operator.publicKey)], [stranger]), "WrongMarketState", "close before settlement");
  await expectFail(send([pruneIx()], [stranger]), "WrongMarketState", "prune before settlement");
  // the fuse was NOT blown by the refused calls: venue still accepts the trading window
  assert.equal(ob.readTimeExpiry((await conn.getAccountInfo(obMarket.publicKey))!.data), 0n, "time_expiry untouched");
});

test("V2 settle the market (finalize from the mock feed, derive Yes)", async () => {
  for (let i = 0; i < 90; i++) { if (await chainNow() >= CLOSE) break; await new Promise(r => setTimeout(r, 1000)); }
  assert.ok(await chainNow() >= CLOSE, "past close_ts");
  const slot = BigInt(await conn.getSlot("confirmed"));
  await send([ob.publishMockFeedIx(operator.publicKey, AAPL, 235_000_000n)], [operator]);
  await send([finalizeNormalIx(operator.publicKey, slot)], [operator]);
  await send([settleMarketIx(stranger.publicKey)], [stranger]);
  const d = (await conn.getAccountInfo(market))!.data;
  assert.equal(d[47], 3, "state == Settled");
});

test("V3 close refused while user deposits remain (resting order, then pruned-but-unsettled)", async () => {
  await expectFail(send([closeIx(operator.publicKey)], [stranger]), "VenueNotEmpty", "close with a resting bid");

  // permissionless prune: blows the one-way fuse and cancels the maker's bid
  await send([pruneIx()], [stranger]);
  assert.equal(ob.readTimeExpiry((await conn.getAccountInfo(obMarket.publicKey))!.data), -1n, "venue expired one-way");
  // idempotent: a second prune on an empty OpenOrders account is fine
  await send([pruneIx()], [stranger]);

  // cancelled order is credited to the maker's OpenOrders position — still a
  // venue deposit, so close is still refused (nothing may be stranded)
  await expectFail(send([closeIx(operator.publicKey)], [stranger]), "VenueNotEmpty", "close before settle_funds");

  // owner-signed recovery path, unchanged
  const q0 = (await getAccount(conn, makerQuote)).amount;
  await send([ob.settleFundsIx({
    owner: maker.publicKey, ooAccount: makerOo, market: obMarket.publicKey,
    marketBaseVault: baseVault, marketQuoteVault: obQuoteVault,
    userBaseAccount: makerYes, userQuoteAccount: makerQuote,
  })], [maker]);
  assert.equal((await getAccount(conn, makerQuote)).amount - q0, 40n * 10_000n, "maker recovered the 0.40 USDC");
});

test("V4 close_venue: rent goes only to the snapshotted refund address; accounts gone; one-shot", async () => {
  await expectFail(send([closeIx(stranger.publicKey)], [stranger]), "WrongRefundDestination", "close to a caller-supplied destination");

  const rent = (await Promise.all([obMarket.publicKey, bids.publicKey, asks.publicKey, heap.publicKey]
    .map((k) => conn.getAccountInfo(k)))).reduce((s, a) => s + (a?.lamports ?? 0), 0);
  assert.ok(rent > 1_800_000_000, `venue rent is ~1.9 SOL (got ${rent})`);
  const before = await conn.getBalance(operator.publicKey);
  await send([closeIx(operator.publicKey)], [stranger]); // permissionless; stranger pays the fee
  const after = await conn.getBalance(operator.publicKey);
  assert.equal(after - before, rent, "operator received exactly the market+bids+asks+heap rent");
  for (const k of [obMarket.publicKey, bids.publicKey, asks.publicKey, heap.publicKey]) {
    assert.equal(await conn.getAccountInfo(k), null, `${k.toBase58()} closed`);
  }
  const d = (await conn.getAccountInfo(market))!.data;
  assert.ok(m.readVenueClosedTs(d) > 0n, "venue_closed_ts stamped");
  assert.ok(m.readVenueRefundAddress(d).equals(operator.publicKey), "refund address snapshot is the operator");
  // pair collateral is untouched by venue closure (outcome redemption still works)
  assert.equal((await getAccount(conn, vault)).amount, 10n * LOT, "collateral vault untouched");

  await expectFail(send([closeIx(operator.publicKey)], [stranger]), "VenueAlreadyClosed", "second close");
  await expectFail(send([pruneIx()], [stranger]), "VenueAlreadyClosed", "prune after close");
});
