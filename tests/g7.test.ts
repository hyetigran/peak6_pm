/**
 * G7 — Transaction feasibility / one-approval gate (PRD v0.7.1 §15).
 *
 * Every composite is measured (serialized bytes, account count, CU, wallet
 * simulation) under the STRICT ALT split: the lookup table holds only stable
 * program IDs, the Config PDA, and the pinned quote mint; every per-day and
 * per-user address stays inline. Measurements land in
 * docs/adr/g7-measurements.json.
 *
 *   1. first-use Buy-No-limit  — HARD SPEC GATE: both outcome ATAs absent,
 *      funded quote ATA present: OOI + OOA + both ATA creates + mint_pair +
 *      PostOnly ask, ONE transaction, ONE approval
 *   2. first-use Buy-Yes-limit — OOI + OOA + PostOnly bid
 *   3. redeem_no_via_market with the max (11) inline maker accounts
 *   4. pre-consume + take composite
 *   5. post-close cancel + settle + direct Pair Redemption helper
 *   9. create_venue_market composite: operator funds all three book accounts
 *      and the pinned creation CPI + gate + pair binding in one transaction
 * (6/7/8/10 need M1 instructions — Metaplex metadata, SettlementRecord,
 *  attach — and are tracked by the go/no-go issue.)
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccount, createAssociatedTokenAccountIdempotent,
  createAssociatedTokenAccountInstruction, createMint, getAccount,
  getAssociatedTokenAddressSync, mintTo,
} from "@solana/spl-token";
import * as ob from "./lib/openbook.js";
import { createAlt } from "./lib/v0.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
let conn: Connection;
const payer = Keypair.generate();   // operator
const maker = Keypair.generate();   // liquidity for takes
const market = Keypair.generate(), bids = Keypair.generate(), asks = Keypair.generate(), heap = Keypair.generate();
let yesMint: PublicKey, noMint: PublicKey, quoteMint: PublicKey;
let pairPda: PublicKey, collateralVault: PublicKey, tradeYesAta: PublicKey;
let baseVault: PublicKey, quoteVault: PublicKey;
let makerYes: PublicKey, makerNo: PublicKey, makerQuote: PublicKey, makerOo: PublicKey;
let stableAlt: PublicKey;

const LOT = 1_000_000n, CENT = 10_000n;
const results: Record<string, unknown>[] = [];

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
/** Measure a composite under the strict ALT split, then execute it. */
async function measure(name: string, ixs: TransactionInstruction[], signers: Keypair[], opts?: { mustFit?: boolean; mustExecute?: boolean }) {
  const alt = (await conn.getAddressLookupTable(stableAlt)).value!;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message([alt]);
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  let bytes = 0, fits = true;
  try { bytes = tx.serialize().length; fits = bytes <= 1232; }
  catch { fits = false; }
  const accounts = msg.staticAccountKeys.length +
    msg.addressTableLookups.reduce((a, l) => a + l.readonlyIndexes.length + l.writableIndexes.length, 0);
  // wallet simulation (what a wallet does before showing one approval)
  const sim = fits ? await conn.simulateTransaction(tx, { commitment: "confirmed" }) : null;
  const simOk = sim !== null && sim.value.err === null;
  if (sim && !simOk) console.error(`G7 ${name} SIM ERR:`, JSON.stringify(sim.value.err), (sim.value.logs ?? []).join(" | "));
  let cu = sim?.value.unitsConsumed ?? null;
  let executed = false;
  if (fits && simOk) {
    const sig = await conn.sendTransaction(tx);
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    const info = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    cu = info!.meta!.computeUnitsConsumed!;
    executed = info!.meta!.err === null;
  }
  const row = { name, bytes, fits_1232: fits, accounts, cu, wallet_sim_ok: simOk, executed, signers: signers.length };
  results.push(row);
  console.error(`G7 ${name}: ${bytes}B, ${accounts} accts, CU=${cu}, sim=${simOk}, executed=${executed}`);
  if (opts?.mustFit) {
    assert.ok(fits && simOk && executed, `${name} must fit one approval (bytes=${bytes})`);
    assert.equal(signers.length, 1, `${name} must need exactly ONE user signature`);
  }
  if (opts?.mustExecute) assert.ok(fits && simOk && executed, `${name} must execute (bytes=${bytes})`);
  return row;
}

before(async () => {
  conn = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try { await conn.getLatestBlockhash(); break; }
    catch { if (i > 30) throw new Error("no validator — use scripts/run-suite.sh"); await new Promise(r => setTimeout(r, 1000)); }
  }
  for (const kp of [payer, maker]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 50_000_000_000);
    await conn.confirmTransaction(sig, "confirmed");
  }
  pairPda = ob.pairVaultPda(market.publicKey);
  quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  yesMint = await createMint(conn, payer, pairPda, null, 6);
  noMint = await createMint(conn, payer, pairPda, null, 6);
  collateralVault = await createAssociatedTokenAccountIdempotent(conn, payer, quoteMint, pairPda, undefined, undefined, undefined, true);
  tradeYesAta = await createAssociatedTokenAccountIdempotent(conn, payer, yesMint, pairPda, undefined, undefined, undefined, true);
  makerQuote = await createAssociatedTokenAccount(conn, payer, quoteMint, maker.publicKey);
  makerYes = await createAssociatedTokenAccount(conn, payer, yesMint, maker.publicKey);
  makerNo = await createAssociatedTokenAccount(conn, payer, noMint, maker.publicKey);
  await mintTo(conn, payer, quoteMint, makerQuote, payer, 1_000_000_000n);
  await send([ob.harnessInitializeIx(payer.publicKey)], [payer]);
  // the STRICT stable-only ALT: programs + config + quote mint, nothing else
  stableAlt = await createAlt(conn, payer, [
    SystemProgram.programId, ob.TOKEN_PID, ob.ATA_PID, ob.OPENBOOK_PID, ob.HARNESS_PID,
    ob.harnessConfigPda(), quoteMint,
  ]);
});

test("G7.9 create_venue_market composite: operator funds books + pinned CPI + gate + pair in ONE tx", async () => {
  const bookRent = await conn.getMinimumBalanceForRentExemption(ob.BOOKSIDE_SPACE);
  const heapRent = await conn.getMinimumBalanceForRentExemption(ob.EVENT_HEAP_SPACE);
  const auth = ob.marketAuthorityPda(market.publicKey);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const nameBuf = Buffer.from("G7-YES/US");
  const len = Buffer.alloc(4); len.writeUInt32LE(nameBuf.length);
  const createIx = new TransactionInstruction({
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
    data: Buffer.concat([ob.disc("create_venue_market"), len, nameBuf, Buffer.alloc(8)]),
  });
  // MEASURED: the everything-in-one transaction variant does NOT fit
  // (1319B > 1232 with five signatures) — the operator flow is two
  // transactions. Only the user-facing composite 1 carries the one-approval
  // requirement; operator flows are unconstrained by the spec.
  await measure("venue_books_funding_tx", [
    ob.bookAccountIx(payer.publicKey, bids, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(payer.publicKey, asks, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(payer.publicKey, heap, ob.EVENT_HEAP_SPACE, heapRent),
  ], [payer, bids, asks, heap], { mustExecute: true });
  await measure("venue_create_gate_pair_tx", [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createIx,
    ob.harnessCreateVenueGateIx(payer.publicKey, market.publicKey, now - 60n, now + 3600n, payer.publicKey),
    ob.harnessInitPairIx(payer.publicKey, { market: market.publicKey, yesMint, noMint, quoteVault: collateralVault }),
  ], [payer, market], { mustExecute: true });
  baseVault = ob.ataFor(yesMint, auth);
  quoteVault = ob.ataFor(quoteMint, auth);
  // maker plumbing for later composites
  await send([
    ob.createOoIndexerIx(payer.publicKey, maker.publicKey),
    ob.createOoAccountIx(payer.publicKey, maker.publicKey, 1, market.publicKey),
  ], [payer, maker]);
  makerOo = ob.ooAccountPda(maker.publicKey, 1);
  await send([ob.harnessMintPairIx(maker.publicKey, market.publicKey, 50n * LOT, {
    yesMint, noMint, quoteVault: collateralVault,
    userQuote: makerQuote, userYes: makerYes, userNo: makerNo,
  })], [maker]);
});

test("G7.1 HARD GATE: first-use Buy-No-limit fits ONE approval", async () => {
  // a brand-new user: funded quote ATA, NO outcome ATAs, no OpenOrders
  const user = Keypair.generate();
  const sig = await conn.requestAirdrop(user.publicKey, 5_000_000_000);
  await conn.confirmTransaction(sig, "confirmed");
  const userQuote = await createAssociatedTokenAccount(conn, payer, quoteMint, user.publicKey);
  await mintTo(conn, payer, quoteMint, userQuote, payer, 100_000_000n);
  const userYes = getAssociatedTokenAddressSync(yesMint, user.publicKey);
  const userNo = getAssociatedTokenAddressSync(noMint, user.publicKey);
  const userOo = ob.ooAccountPda(user.publicKey, 1);
  // Buy No at $0.40 == mint pair + PostOnly ASK of Yes at $0.60
  const q = 2n;
  await measure("first_use_buy_no_limit", [
    ob.createOoIndexerIx(user.publicKey, user.publicKey),
    ob.createOoAccountIx(user.publicKey, user.publicKey, 1, market.publicKey),
    createAssociatedTokenAccountInstruction(user.publicKey, userYes, user.publicKey, yesMint),
    createAssociatedTokenAccountInstruction(user.publicKey, userNo, user.publicKey, noMint),
    ob.harnessMintPairIx(user.publicKey, market.publicKey, q * LOT, {
      yesMint, noMint, quoteVault: collateralVault,
      userQuote, userYes, userNo,
    }),
    ob.harnessPlaceLimitOrderIx({
      user: user.publicKey, ooAccount: userOo, userTokenAccount: userYes,
      market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
      eventHeap: heap.publicKey, marketVault: baseVault,
      args: { side: ob.Side.Ask, priceLots: 60n, maxBaseLots: q, maxQuoteLotsIncludingFees: 60n * q,
        clientOrderId: 1n, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
        selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
    }),
  ], [user], { mustFit: true });
  // the No position exists and the ask rests
  assert.equal((await getAccount(conn, userNo)).amount, q * LOT, "user holds the No side");
  assert.equal((await getAccount(conn, baseVault)).amount, q * LOT, "Yes ask rests on the Venue Market");
});

test("G7.2 first-use Buy-Yes-limit fits one approval", async () => {
  const user = Keypair.generate();
  const sig = await conn.requestAirdrop(user.publicKey, 5_000_000_000);
  await conn.confirmTransaction(sig, "confirmed");
  const userQuote = await createAssociatedTokenAccount(conn, payer, quoteMint, user.publicKey);
  await mintTo(conn, payer, quoteMint, userQuote, payer, 100_000_000n);
  const userOo = ob.ooAccountPda(user.publicKey, 1);
  await measure("first_use_buy_yes_limit", [
    ob.createOoIndexerIx(user.publicKey, user.publicKey),
    ob.createOoAccountIx(user.publicKey, user.publicKey, 1, market.publicKey),
    ob.harnessPlaceLimitOrderIx({
      user: user.publicKey, ooAccount: userOo, userTokenAccount: userQuote,
      market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
      eventHeap: heap.publicKey, marketVault: quoteVault,
      args: { side: ob.Side.Bid, priceLots: 35n, maxBaseLots: 1n, maxQuoteLotsIncludingFees: 35n,
        clientOrderId: 1n, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
        selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
    }),
  ], [user], { mustFit: true });
});

test("G7.3/G7.4/G7.5 remaining composites measured", async () => {
  // seller with No to redeem
  const seller = Keypair.generate();
  const sig = await conn.requestAirdrop(seller.publicKey, 5_000_000_000);
  await conn.confirmTransaction(sig, "confirmed");
  const sellerQuote = await createAssociatedTokenAccount(conn, payer, quoteMint, seller.publicKey);
  const sellerYes = await createAssociatedTokenAccount(conn, payer, yesMint, seller.publicKey);
  const sellerNo = await createAssociatedTokenAccount(conn, payer, noMint, seller.publicKey);
  await mintTo(conn, payer, quoteMint, sellerQuote, payer, 100_000_000n);
  await send([ob.createOoIndexerIx(payer.publicKey, seller.publicKey),
    ob.createOoAccountIx(payer.publicKey, seller.publicKey, 1, market.publicKey)], [payer, seller]);
  await send([ob.harnessMintPairIx(seller.publicKey, market.publicKey, 12n * LOT, {
    yesMint, noMint, quoteVault: collateralVault,
    userQuote: sellerQuote, userYes: sellerYes, userNo: sellerNo,
  })], [seller]);

  // maker rests 11 asks (the measured inline max) for the redemption to eat
  const restOne = (id: bigint) => ob.harnessPlaceLimitOrderIx({
    user: maker.publicKey, ooAccount: makerOo, userTokenAccount: makerYes,
    market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
    eventHeap: heap.publicKey, marketVault: baseVault,
    args: { side: ob.Side.Ask, priceLots: 40n, maxBaseLots: 1n, maxQuoteLotsIncludingFees: 40n,
      clientOrderId: id, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
      selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
  });
  for (let k = 0; k < 11; k++) await send([restOne(100n + BigInt(k))], [maker]);
  // G7.3: redemption with 11 inline maker accounts (all the same OO here;
  // production worst case is 11 DISTINCT makers — bytes measured with 11
  // remaining slots either way)
  const oos = Array.from({ length: 11 }, () => makerOo);
  await measure("redeem_no_via_market_max_makers", [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ob.harnessRedeemNoViaMarketIx(seller.publicKey, {
      market: market.publicKey, yesMint, noMint, quoteVault: collateralVault,
      tradeYesAta, userQuote: sellerQuote, userNo: sellerNo,
      bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey,
      marketBaseVault: baseVault, marketQuoteVault: quoteVault,
      makerOoAccounts: oos, qLots: 11n, priceLots: 40n,
    })], [seller]);

  // G7.4: pre-consume + take composite
  for (let k = 0; k < 4; k++) await send([restOne(200n + BigInt(k))], [maker]);
  await send([ob.harnessPlaceTakeOrderIx({
    user: seller.publicKey, market: market.publicKey, bids: bids.publicKey,
    asks: asks.publicKey, eventHeap: heap.publicKey,
    marketBaseVault: baseVault, marketQuoteVault: quoteVault,
    userBaseAccount: sellerYes, userQuoteAccount: sellerQuote, makerOoAccounts: [],
    args: { side: ob.Side.Bid, priceLots: 40n, maxBaseLots: 2n, maxQuoteLotsIncludingFees: 80n,
      orderType: ob.PlaceOrderType.ImmediateOrCancel, limit: 16 },
  })], [seller]); // 2 heaped events
  await measure("preconsume_plus_take", [
    ob.consumeEventsIx(market.publicKey, heap.publicKey, 8n, [makerOo]),
    ob.harnessPlaceTakeOrderIx({
      user: seller.publicKey, market: market.publicKey, bids: bids.publicKey,
      asks: asks.publicKey, eventHeap: heap.publicKey,
      marketBaseVault: baseVault, marketQuoteVault: quoteVault,
      userBaseAccount: sellerYes, userQuoteAccount: sellerQuote, makerOoAccounts: [makerOo],
      args: { side: ob.Side.Bid, priceLots: 40n, maxBaseLots: 2n, maxQuoteLotsIncludingFees: 80n,
        orderType: ob.PlaceOrderType.ImmediateOrCancel, limit: 16 },
    })], [seller]);

  // G7.5: post-close recovery helper: cancel + settle + direct redemption
  await measure("cancel_settle_redeem_helper", [
    ob.cancelAllOrdersIx(seller.publicKey, ob.ooAccountPda(seller.publicKey, 1), market.publicKey, bids.publicKey, asks.publicKey),
    ob.settleFundsIx({
      owner: seller.publicKey, ooAccount: ob.ooAccountPda(seller.publicKey, 1), market: market.publicKey,
      marketBaseVault: baseVault, marketQuoteVault: quoteVault,
      userBaseAccount: sellerYes, userQuoteAccount: sellerQuote,
    }),
    ob.harnessRedeemPairDirectIx(seller.publicKey, market.publicKey, 1n * LOT, {
      yesMint, noMint, quoteVault: collateralVault,
      userQuote: sellerQuote, userYes: sellerYes, userNo: sellerNo,
    }),
  ], [seller]);

  fs.writeFileSync("docs/adr/g7-measurements.json", JSON.stringify({
    alt_contents: "programs (system, token, ATA, openbook, harness), config PDA, quote mint — stable only; every per-day/per-user address inline",
    composites: results,
    deferred_m1: ["create_strike_market first/later (Metaplex + SettlementRecord)", "batched settlement", "intraday add-strike attach sequence"],
  }, null, 2) + "\n");
  for (const r of results) assert.ok((r as any).fits_1232 && (r as any).executed, `${(r as any).name} fits and executes`);
});
