/** Set up one market with a resting bid @40¢ and ask @60¢, print its pubkey. */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccount, createMint, mintTo } from "@solana/spl-token";
import fs from "node:fs";
import * as m from "../tests/lib/meridian.js";
import * as ob from "../tests/lib/openbook.js";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const OPD = new PublicKey("DktN5HJ9uHKVRZ7FXGap4PEGVnEdc2VNBCXTt1AqJQYB");
const AAPL = 1, DAY = 20260901, STRIKE = 230_000_000n, LOT = 1_000_000n;
const send = (ixs: TransactionInstruction[], s: Keypair[]) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), s, { commitment: "confirmed" });

async function main() {
  const gov = Keypair.generate(), op = Keypair.generate(), a = Keypair.generate(), b = Keypair.generate();
  for (const k of [gov, op, a, b]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 50e9), "confirmed");
  const quote = await createMint(conn, gov, gov.publicKey, null, 6);
  await send([m.initializeConfigIx({ governance: gov.publicKey, quoteMint: quote, openbookProgramData: OPD,
    operator: op.publicKey, pauseAuthority: gov.publicKey, overrideAuthority: gov.publicKey, supportedTickerMask: 0xfe,
    openbookDeploymentSlot: 282042596n, openbookExecutableSha256: Buffer.alloc(32, 0xaa), openbookUpgradeAuthority: PublicKey.default,
    minSamples: 3, maxStaleSlots: 1_000_000n, maxPriceBandBps: 50 })], [gov]);
  await send([m.registerTransportIx({ governance: gov.publicKey, versionId: 1, tickerId: AAPL, feed: Keypair.generate().publicKey })], [gov]);
  const now = BigInt(Math.floor(Date.now() / 1000)), to = now - 30n, mo = to - 1800n, cl = to + 6n * 3600n;
  await send([m.createOutcomeMarketIx({ operator: op.publicKey, quoteMint: quote, tickerId: AAPL, tradingDay: DAY, strike: STRIKE,
    versionId: 1, priorClose: 225_000_000n, mintOpenTs: mo, tradeOpenTs: to, closeTs: cl, metadataManifest: Buffer.alloc(32, 7),
    normalDelaySecs: 0, overrideDelaySecs: 0 })], [op]);
  const market = m.outcomeMarketPda(AAPL, DAY, STRIKE), yes = m.yesMintPda(market), no = m.noMintPda(market);
  const obM = Keypair.generate(), bids = Keypair.generate(), asks = Keypair.generate(), heap = Keypair.generate();
  const br = await conn.getMinimumBalanceForRentExemption(ob.BOOKSIDE_SPACE), hr = await conn.getMinimumBalanceForRentExemption(ob.EVENT_HEAP_SPACE);
  await send([ob.bookAccountIx(op.publicKey, bids, ob.BOOKSIDE_SPACE, br), ob.bookAccountIx(op.publicKey, asks, ob.BOOKSIDE_SPACE, br), ob.bookAccountIx(op.publicKey, heap, ob.EVENT_HEAP_SPACE, hr)], [op, bids, asks, heap]);
  await send([m.createVenueMarketIx({ operator: op.publicKey, market, obMarket: obM.publicKey, bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey, yesMint: yes, quoteMint: quote, name: "AAPL-230-YES/USD", timeExpiry: 0n })], [op, obM]);
  const auth = m.marketAuthorityPda(obM.publicKey), quoteVault = ob.ataFor(quote, auth);
  // two makers: A rests a bid@40 (needs USDC), B mints a pair and rests an ask@60 (needs Yes)
  const aq = await createAssociatedTokenAccount(conn, gov, quote, a.publicKey); await mintTo(conn, gov, quote, aq, gov, 100e6);
  const bq = await createAssociatedTokenAccount(conn, gov, quote, b.publicKey); await mintTo(conn, gov, quote, bq, gov, 100e6);
  const by = await createAssociatedTokenAccount(conn, gov, yes, b.publicKey); const bn = await createAssociatedTokenAccount(conn, gov, no, b.publicKey);
  for (const u of [a, b]) await send([ob.createOoIndexerIx(op.publicKey, u.publicKey), ob.createOoAccountIx(op.publicKey, u.publicKey, 1, obM.publicKey)], [op, u]);
  await send([m.mintPairIx(b.publicKey, market, 5n * LOT, { yesMint: yes, noMint: no, collateralVault: m.ataFor(quote, market), userQuote: bq, userYes: by, userNo: bn })], [b]);
  // A: Buy-Yes bid @40
  await send([m.placeLimitOrderIx({ user: a.publicKey, market, ooAccount: ob.ooAccountPda(a.publicKey, 1), userTokenAccount: aq,
    obMarket: obM.publicKey, bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey, marketVault: quoteVault,
    args: { side: ob.Side.Bid, priceLots: 40n, maxBaseLots: 2n, maxQuoteLotsIncludingFees: 80n, clientOrderId: 1n, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n, selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 } })], [a]);
  // B: Sell-Yes ask @60
  await send([m.placeLimitOrderIx({ user: b.publicKey, market, ooAccount: ob.ooAccountPda(b.publicKey, 1), userTokenAccount: by,
    obMarket: obM.publicKey, bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey, marketVault: ob.ataFor(yes, auth),
    args: { side: ob.Side.Ask, priceLots: 60n, maxBaseLots: 3n, maxQuoteLotsIncludingFees: 180n, clientOrderId: 2n, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n, selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 } })], [b]);
  fs.writeFileSync(".book-market.txt", market.toBase58());
  console.log("BOOK_MARKET", market.toBase58());
}
main().catch((e) => { console.error(e); process.exit(1); });
