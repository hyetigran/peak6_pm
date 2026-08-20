/**
 * G5 — Sell-No via `redeem_no_via_market` (the PRD's redeem_pair_via_market
 * family member for the No side; PRD v0.7.1 §15).
 *
 * The pair-collateral model binds a PairVault PDA (mint authority of both
 * outcome mints, owner of the quote collateral vault) to the Venue Market.
 * Sell No = burn the user's No, buy exactly q Yes with VAULT quote on the
 * venue, burn the pair, pay the user the released remainder.
 *
 *   1. mint_pair / redeem_pair_direct exact atom accounting
 *   2. Sell No at $0.40: exact proceeds, vault delta == liability delta == -q
 *   3. only the bound collateral vault can fund quote (wrong vault rejected)
 *   4. program Yes-trade ATA exact (wrong ATA rejected)
 *   5. 99-cent zero-fee corner
 *   6. insufficient liquidity reverts everything (vault, liability, tokens)
 *   7. knowing self-cross: builder detects and refuses; adversarial raced
 *      self-cross stays solvent and is classified Internal Unwind
 *   8. no lamport path can debit collateral (vault + PDA lamports constant)
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccount, createAssociatedTokenAccountIdempotent, createMint,
  getAccount, mintTo,
} from "@solana/spl-token";
import * as ob from "./lib/openbook.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
let conn: Connection;
const payer = Keypair.generate();
const maker = Keypair.generate();   // liquidity provider (rests Yes asks)
const seller = Keypair.generate();  // sells No via redemption
const market = Keypair.generate(), bids = Keypair.generate(), asks = Keypair.generate(), heap = Keypair.generate();
let yesMint: PublicKey, noMint: PublicKey, quoteMint: PublicKey;
let pairPda: PublicKey, collateralVault: PublicKey, tradeYesAta: PublicKey;
let baseVault: PublicKey, quoteVault: PublicKey;
let makerYes: PublicKey, makerNo: PublicKey, makerQuote: PublicKey, makerOo: PublicKey;
let sellerYes: PublicKey, sellerNo: PublicKey, sellerQuote: PublicKey, sellerOo: PublicKey;

const LOT = 1_000_000n;      // base atoms per lot (one whole token)
const CENT = 10_000n;        // quote atoms per price lot

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
const bal = async (a: PublicKey) => (await getAccount(conn, a)).amount;
const liability = async () => {
  const d = (await conn.getAccountInfo(pairPda))!.data;
  return d.readBigUInt64LE(8 + 32 * 4); // after 4 pubkeys
};
const pairOpts = (u: { quote: PublicKey; yes: PublicKey; no: PublicKey }) => ({
  yesMint, noMint, quoteVault: collateralVault,
  userQuote: u.quote, userYes: u.yes, userNo: u.no,
});
const restAskIx = (user: PublicKey, oo: PublicKey, yesAta: PublicKey, price: bigint, lots: bigint, id: bigint) =>
  ob.harnessPlaceLimitOrderIx({
    user, ooAccount: oo, userTokenAccount: yesAta,
    market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
    eventHeap: heap.publicKey, marketVault: baseVault,
    args: { side: ob.Side.Ask, priceLots: price, maxBaseLots: lots,
      maxQuoteLotsIncludingFees: price * lots, clientOrderId: id,
      orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
      selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
  });
const redeemIx = (qLots: bigint, price: bigint, oos: PublicKey[]) =>
  ob.harnessRedeemNoViaMarketIx(seller.publicKey, {
    market: market.publicKey, yesMint, noMint, quoteVault: collateralVault,
    tradeYesAta, userQuote: sellerQuote, userNo: sellerNo,
    bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey,
    marketBaseVault: baseVault, marketQuoteVault: quoteVault,
    makerOoAccounts: oos, qLots, priceLots: price,
  });

let vaultLamports0: number, pdaLamports0: number;

before(async () => {
  conn = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try { await conn.getLatestBlockhash(); break; }
    catch { if (i > 30) throw new Error("no validator at " + RPC + " — use scripts/run-suite.sh"); await new Promise(r => setTimeout(r, 1000)); }
  }
  for (const kp of [payer, maker, seller]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 20_000_000_000);
    await conn.confirmTransaction(sig, "confirmed");
  }
  pairPda = ob.pairVaultPda(market.publicKey);
  quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  yesMint = await createMint(conn, payer, pairPda, null, 6);  // PDA mint authority
  noMint = await createMint(conn, payer, pairPda, null, 6);
  collateralVault = await createAssociatedTokenAccountIdempotent(conn, payer, quoteMint, pairPda, undefined, undefined, undefined, true);
  tradeYesAta = await createAssociatedTokenAccountIdempotent(conn, payer, yesMint, pairPda, undefined, undefined, undefined, true);
  for (const [u, set] of [[maker, (q: PublicKey, y: PublicKey, n: PublicKey) => { makerQuote = q; makerYes = y; makerNo = n; }],
                          [seller, (q: PublicKey, y: PublicKey, n: PublicKey) => { sellerQuote = q; sellerYes = y; sellerNo = n; }]] as const) {
    const q = await createAssociatedTokenAccount(conn, payer, quoteMint, u.publicKey);
    const y = await createAssociatedTokenAccount(conn, payer, yesMint, u.publicKey);
    const n = await createAssociatedTokenAccount(conn, payer, noMint, u.publicKey);
    await mintTo(conn, payer, quoteMint, q, payer, 100_000_000n);
    set(q, y, n);
  }

  await send([ob.harnessInitializeIx(payer.publicKey, quoteMint)], [payer]);
  const bookRent = await conn.getMinimumBalanceForRentExemption(ob.BOOKSIDE_SPACE);
  const heapRent = await conn.getMinimumBalanceForRentExemption(ob.EVENT_HEAP_SPACE);
  await send([
    ob.bookAccountIx(payer.publicKey, bids, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(payer.publicKey, asks, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(payer.publicKey, heap, ob.EVENT_HEAP_SPACE, heapRent),
  ], [payer, bids, asks, heap]);
  // Yes/quote Venue Market via the pinned creation wrapper
  const auth = ob.marketAuthorityPda(market.publicKey);
  await send([new TransactionInstruction({
    programId: ob.HARNESS_PID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ob.harnessConfigPda(), isSigner: false, isWritable: false },
      { pubkey: ob.venueAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: market.publicKey, isSigner: true, isWritable: true },
      { pubkey: auth, isSigner: false, isWritable: false },
      { pubkey: bids.publicKey, isSigner: false, isWritable: true },
      { pubkey: asks.publicKey, isSigner: false, isWritable: true },
      { pubkey: heap.publicKey, isSigner: false, isWritable: true },
      { pubkey: ob.ataFor(yesMint, auth), isSigner: false, isWritable: true },
      { pubkey: ob.ataFor(quoteMint, auth), isSigner: false, isWritable: true },
      { pubkey: yesMint, isSigner: false, isWritable: false },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ob.TOKEN_PID, isSigner: false, isWritable: false },
      { pubkey: ob.ATA_PID, isSigner: false, isWritable: false },
      { pubkey: ob.eventAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: PublicKey.findProgramAddressSync([Buffer.from("meridian_fee_admin_sentinel")], SystemProgram.programId)[0], isSigner: false, isWritable: false },
      { pubkey: ob.OPENBOOK_PID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([ob.disc("create_venue_market"),
      (() => { const b = Buffer.alloc(4); b.writeUInt32LE(9); return b; })(), Buffer.from("G5-YES/US"),
      Buffer.alloc(8)]),
  })], [payer, market]);
  baseVault = ob.ataFor(yesMint, auth);
  quoteVault = ob.ataFor(quoteMint, auth);
  const now = BigInt(Math.floor(Date.now() / 1000));
  await send([ob.harnessCreateVenueGateIx(payer.publicKey, market.publicKey, now - 60n, now + 3600n, payer.publicKey)], [payer]);
  await send([ob.harnessInitPairIx(payer.publicKey, { market: market.publicKey, yesMint, noMint, quoteVault: collateralVault })], [payer]);
  for (const u of [maker, seller]) {
    await send([
      ob.createOoIndexerIx(payer.publicKey, u.publicKey),
      ob.createOoAccountIx(payer.publicKey, u.publicKey, 1, market.publicKey),
    ], [payer, u]);
  }
  makerOo = ob.ooAccountPda(maker.publicKey, 1);
  sellerOo = ob.ooAccountPda(seller.publicKey, 1);
  vaultLamports0 = (await conn.getAccountInfo(collateralVault))!.lamports;
  pdaLamports0 = (await conn.getAccountInfo(pairPda))!.lamports;
});

test("G5.1 mint_pair and direct Pair Redemption: exact atom accounting", async () => {
  await send([ob.harnessMintPairIx(maker.publicKey, market.publicKey, 10n * LOT,
    pairOpts({ quote: makerQuote, yes: makerYes, no: makerNo }))], [maker]);
  assert.equal(await bal(collateralVault), 10n * LOT, "vault holds 10 atoms per pair");
  assert.equal(await bal(makerYes), 10n * LOT); assert.equal(await bal(makerNo), 10n * LOT);
  assert.equal(await liability(), 10n * LOT, "liability == minted pairs");
  await send([ob.harnessMintPairIx(seller.publicKey, market.publicKey, 5n * LOT,
    pairOpts({ quote: sellerQuote, yes: sellerYes, no: sellerNo }))], [seller]);
  assert.equal(await liability(), 15n * LOT);
  // direct redemption releases exactly q
  await send([ob.harnessRedeemPairDirectIx(seller.publicKey, market.publicKey, 1n * LOT,
    pairOpts({ quote: sellerQuote, yes: sellerYes, no: sellerNo }))], [seller]);
  assert.equal(await liability(), 14n * LOT);
  assert.equal(await bal(collateralVault), 14n * LOT, "vault == liability (solvent)");
});

test("G5.2 Sell No at $0.40: exact proceeds; vault delta == liability delta == -q", async () => {
  await send([restAskIx(maker.publicKey, makerOo, makerYes, 40n, 2n, 1n)], [maker]);
  const v0 = await bal(collateralVault), l0 = await liability();
  const no0 = await bal(sellerNo), q0 = await bal(sellerQuote);
  await send([redeemIx(2n, 40n, [makerOo])], [seller]);
  assert.equal(no0 - await bal(sellerNo), 2n * LOT, "2 No burned (user-signed)");
  assert.equal(await bal(sellerQuote) - q0, 2n * LOT - 2n * 40n * CENT, "proceeds = q(1-P) = 1.20");
  assert.equal(v0 - await bal(collateralVault), 2n * LOT, "vault delta exactly -q");
  assert.equal(l0 - await liability(), 2n * LOT, "liability delta exactly -q");
  assert.equal(await bal(tradeYesAta), 0n, "acquired Yes fully burned");
});

test("G5.3 only the bound collateral vault can fund quote", async () => {
  await send([restAskIx(maker.publicKey, makerOo, makerYes, 40n, 1n, 2n)], [maker]);
  const ix = redeemIx(1n, 40n, [makerOo]);
  const badKeys = ix.keys.map(k => k.pubkey.equals(collateralVault) ? { ...k, pubkey: makerQuote } : k);
  await expectFail(send([new TransactionInstruction({ programId: ix.programId, keys: badKeys, data: ix.data })], [seller]),
    "WrongCollateralVault", "foreign vault");
});

test("G5.4 program Yes-trade ATA exact", async () => {
  const ix = redeemIx(1n, 40n, [makerOo]);
  const badKeys = ix.keys.map(k => k.pubkey.equals(tradeYesAta) ? { ...k, pubkey: sellerYes } : k);
  await expectFail(send([new TransactionInstruction({ programId: ix.programId, keys: badKeys, data: ix.data })], [seller]),
    "WrongTradeAta", "non-canonical trade ATA");
  // clean up the resting ask from G5.3
  await send([ob.cancelAllOrdersIx(maker.publicKey, makerOo, market.publicKey, bids.publicKey, asks.publicKey),
    ob.settleFundsIx({ owner: maker.publicKey, ooAccount: makerOo, market: market.publicKey,
      marketBaseVault: baseVault, marketQuoteVault: quoteVault,
      userBaseAccount: makerYes, userQuoteAccount: makerQuote })], [maker]);
});

test("G5.5 99-cent zero-fee corner", async () => {
  await send([restAskIx(maker.publicKey, makerOo, makerYes, 99n, 1n, 3n)], [maker]);
  const q0 = await bal(sellerQuote), v0 = await bal(collateralVault);
  await send([redeemIx(1n, 99n, [makerOo])], [seller]);
  assert.equal(await bal(sellerQuote) - q0, LOT - 99n * CENT, "proceeds exactly 1 cent per token");
  assert.equal(v0 - await bal(collateralVault), LOT, "vault delta exactly -q at the corner");
});

test("G5.6 insufficient liquidity reverts everything", async () => {
  // top up: the seller must hold enough No that the burn succeeds and the
  // revert is provably the venue fill check, not a token balance error
  await send([ob.harnessMintPairIx(seller.publicKey, market.publicKey, 3n * LOT,
    pairOpts({ quote: sellerQuote, yes: sellerYes, no: sellerNo }))], [seller]);
  await send([restAskIx(maker.publicKey, makerOo, makerYes, 40n, 1n, 4n)], [maker]);
  const v0 = await bal(collateralVault), l0 = await liability();
  const no0 = await bal(sellerNo), q0 = await bal(sellerQuote);
  await expectFail(send([redeemIx(2n, 40n, [makerOo])], [seller]),
    "PartialFillReverted", "2 lots against 1 resting");
  assert.equal(await bal(collateralVault), v0, "vault untouched");
  assert.equal(await liability(), l0, "liability untouched");
  assert.equal(await bal(sellerNo), no0, "No not burned");
  assert.equal(await bal(sellerQuote), q0, "no proceeds");
  await send([ob.cancelAllOrdersIx(maker.publicKey, makerOo, market.publicKey, bids.publicKey, asks.publicKey),
    ob.settleFundsIx({ owner: maker.publicKey, ooAccount: makerOo, market: market.publicKey,
      marketBaseVault: baseVault, marketQuoteVault: quoteVault,
      userBaseAccount: makerYes, userQuoteAccount: makerQuote })], [maker]);
});

test("G5.7 knowing self-cross: builder refuses; raced self-cross stays solvent (Internal Unwind)", async () => {
  // the seller rests their OWN Yes ask at 30 — the redemption's buy would cross it
  await send([restAskIx(seller.publicKey, sellerOo, sellerYes, 30n, 1n, 5n)], [seller]);
  const ooData = (await conn.getAccountInfo(sellerOo))!.data;
  assert.equal(ob.wouldKnowinglySelfCross(ooData, "buy", 30n), true,
    "builder detects the knowing self-cross");
  assert.equal(ob.wouldKnowinglySelfCross(ooData, "buy", 29n), false,
    "no false positive below the resting price");
  // the builder rule ROUTES: chosen alternative is direct Pair Redemption,
  // and that route executes green
  assert.equal(ob.chooseSellNoRoute(ooData, 30n), "direct-pair-redemption");
  const l0r = await liability();
  await send([ob.harnessRedeemPairDirectIx(seller.publicKey, market.publicKey, 1n * LOT,
    pairOpts({ quote: sellerQuote, yes: sellerYes, no: sellerNo }))], [seller]);
  assert.equal(l0r - await liability(), LOT, "routed direct Pair Redemption executed");
  // adversarial/raced path: force it anyway — solvency must hold
  const v0 = await bal(collateralVault), l0 = await liability();
  await send([redeemIx(1n, 30n, [sellerOo])], [seller]);
  assert.equal(v0 - await bal(collateralVault), LOT, "Internal Unwind: vault delta still exactly -q");
  assert.equal(l0 - await liability(), LOT, "liability still exact");
  // seller's maker side received the quote in their OpenOrders — settle it
  await send([ob.settleFundsIx({ owner: seller.publicKey, ooAccount: sellerOo, market: market.publicKey,
    marketBaseVault: baseVault, marketQuoteVault: quoteVault,
    userBaseAccount: sellerYes, userQuoteAccount: sellerQuote })], [seller]);
});

test("G5.8 user signature is REQUIRED for the No burn (negative)", async () => {
  // an attacker cannot burn the victim's No: the burn authority is the user
  // Signer, so naming the victim's No account under an attacker signer fails
  // at the token program with an owner mismatch
  await send([restAskIx(maker.publicKey, makerOo, makerYes, 40n, 1n, 9n)], [maker]);
  const ix = ob.harnessRedeemNoViaMarketIx(maker.publicKey, { // maker signs...
    market: market.publicKey, yesMint, noMint, quoteVault: collateralVault,
    tradeYesAta, userQuote: makerQuote,
    userNo: sellerNo, // ...but names the SELLER's No account
    bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey,
    marketBaseVault: baseVault, marketQuoteVault: quoteVault,
    makerOoAccounts: [makerOo], qLots: 1n, priceLots: 40n,
  });
  await expectFail(send([ix], [maker]), "owner does not match", "burning someone else's No");
  await send([ob.cancelAllOrdersIx(maker.publicKey, makerOo, market.publicKey, bids.publicKey, asks.publicKey),
    ob.settleFundsIx({ owner: maker.publicKey, ooAccount: makerOo, market: market.publicKey,
      marketBaseVault: baseVault, marketQuoteVault: quoteVault,
      userBaseAccount: makerYes, userQuoteAccount: makerQuote })], [maker]);
});

test("G5.9 no lamport path debits collateral", async () => {
  assert.equal((await conn.getAccountInfo(collateralVault))!.lamports, vaultLamports0,
    "collateral vault lamports unchanged through every flow");
  assert.equal((await conn.getAccountInfo(pairPda))!.lamports, pdaLamports0,
    "PairVault PDA lamports unchanged (user is always penalty_payer)");
  // final solvency: vault raw >= accounted liability
  assert.ok(await bal(collateralVault) >= await liability(), "vault raw >= Collateral Liability");
});
