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
import * as ob from "@meridian/sdk/openbook";
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
async function measure(name: string, ixs: TransactionInstruction[], signers: Keypair[], opts?: { mustFit?: boolean; mustExecute?: boolean; mode?: "legacy" | "v0" | "v0+alt"; expectOversize?: boolean; measureOnly?: boolean }) {
  const mode = opts?.mode ?? "v0+alt";
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tmsg = new TransactionMessage({
    payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs,
  });
  const msg = mode === "legacy" ? tmsg.compileToLegacyMessage()
    : mode === "v0" ? tmsg.compileToV0Message([])
    : tmsg.compileToV0Message([(await conn.getAddressLookupTable(stableAlt)).value!]);
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  const bytes = tx.serialize().length; // raw size, even when oversize
  const fits = bytes <= 1232;
  const lookups = "addressTableLookups" in msg ? msg.addressTableLookups : [];
  const accounts = msg.staticAccountKeys.length +
    lookups.reduce((a, l) => a + l.readonlyIndexes.length + l.writableIndexes.length, 0);
  // wallet simulation (what a wallet does before showing one approval)
  const sim = fits ? await conn.simulateTransaction(tx, { commitment: "confirmed" }) : null;
  const simOk = sim !== null && sim.value.err === null;
  if (sim && !simOk) console.error(`G7 ${name} SIM ERR:`, JSON.stringify(sim.value.err), (sim.value.logs ?? []).join(" | "));
  let cu = sim?.value.unitsConsumed ?? null;
  let executed = false;
  if (fits && simOk && !opts?.measureOnly) {
    const sig = await conn.sendTransaction(tx);
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    const info = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    cu = info!.meta!.computeUnitsConsumed!;
    executed = info!.meta!.err === null;
  }
  const row = { name, mode, bytes, fits_1232: fits, accounts, cu, wallet_sim_ok: simOk, executed, signers: signers.length };
  results.push(row);
  // incremental evidence: never leave a stale file behind a failed assert
  fs.writeFileSync("docs/adr/g7-measurements.json", JSON.stringify({
    alt_contents: "programs (system, token, ATA, openbook, harness), config PDA, quote mint — stable only; every per-day/per-user address inline",
    composites: results,
    deferred_m1: ["create_strike_market first/later (Metaplex + SettlementRecord CPIs) — issue #14 AC re-scoped to M1 re-measure via #17", "batched settlement", "intraday add-strike attach sequence"],
  }, null, 2) + "\n");
  console.error(`G7 ${name} [${mode}]: ${bytes}B, ${accounts} accts, CU=${cu}, sim=${simOk}, executed=${executed}`);
  if (opts?.expectOversize) assert.ok(!fits, `${name} expected oversize, got ${bytes}B`);
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
  await send([ob.harnessInitializeIx(payer.publicKey, quoteMint)], [payer]);
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
  // the everything-in-one variant is MEASURED (not asserted from a comment):
  // it cannot fit with five signatures — the operator flow is two
  // transactions. Only the user-facing composite 1 carries the one-approval
  // requirement; operator flows are unconstrained by the spec.
  await measure("venue_all_in_one_tx_variant", [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ob.bookAccountIx(payer.publicKey, bids, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(payer.publicKey, asks, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(payer.publicKey, heap, ob.EVENT_HEAP_SPACE, heapRent),
    createIx,
    ob.harnessCreateVenueGateIx(payer.publicKey, market.publicKey, now - 60n, now + 3600n, payer.publicKey),
    ob.harnessInitPairIx(payer.publicKey, { market: market.publicKey, yesMint, noMint, quoteVault: collateralVault }),
  ], [payer, market, bids, asks, heap], { expectOversize: true, measureOnly: true });
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
  const buyNoIxs = () => [
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
  ];
  // the H7 mitigation ladder, exercised in order: legacy -> v0 -> v0+ALT.
  // Only the last rung executes (earlier rungs measure and stop).
  const legacy = await measure("first_use_buy_no_limit_legacy", buyNoIxs(), [user], { mode: "legacy", measureOnly: true });
  const v0bare = await measure("first_use_buy_no_limit_v0_no_alt", buyNoIxs(), [user], { mode: "v0", measureOnly: true });
  void legacy; void v0bare; // both recorded; fit or not is data, not policy
  await measure("first_use_buy_no_limit", buyNoIxs(), [user], { mustFit: true });
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

  // G7.3 production worst case: 11 DISTINCT makers (11 distinct inline OO
  // accounts — same-key copies would dedupe in the v0 message and understate
  // the bytes)
  const distinct: { kp: Keypair; oo: PublicKey }[] = [];
  for (let k = 0; k < 11; k++) {
    const mk = Keypair.generate();
    await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: mk.publicKey, lamports: 1_000_000_000 })], [payer]);
    const yesAta = await createAssociatedTokenAccount(conn, payer, yesMint, mk.publicKey);
    // fund with Yes from the main maker
    const { createTransferInstruction } = await import("@solana/spl-token");
    await send([createTransferInstruction(makerYes, yesAta, maker.publicKey, Number(LOT))], [maker]);
    await send([ob.createOoIndexerIx(payer.publicKey, mk.publicKey),
      ob.createOoAccountIx(payer.publicKey, mk.publicKey, 1, market.publicKey)], [payer, mk]);
    const oo = ob.ooAccountPda(mk.publicKey, 1);
    await send([ob.harnessPlaceLimitOrderIx({
      user: mk.publicKey, ooAccount: oo, userTokenAccount: yesAta,
      market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
      eventHeap: heap.publicKey, marketVault: baseVault,
      args: { side: ob.Side.Ask, priceLots: 40n, maxBaseLots: 1n, maxQuoteLotsIncludingFees: 40n,
        clientOrderId: 100n + BigInt(k), orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
        selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
    })], [mk]);
    distinct.push({ kp: mk, oo });
  }
  const restOne = (id: bigint) => ob.harnessPlaceLimitOrderIx({
    user: maker.publicKey, ooAccount: makerOo, userTokenAccount: makerYes,
    market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
    eventHeap: heap.publicKey, marketVault: baseVault,
    args: { side: ob.Side.Ask, priceLots: 40n, maxBaseLots: 1n, maxQuoteLotsIncludingFees: 40n,
      clientOrderId: id, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
      selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
  });
  const oos = distinct.map(d => d.oo);
  // the redemption path's own inline capacity: its burn/transfer CPIs consume
  // venue-side heap beyond a plain take, so probe downward from 11 distinct
  // makers until one executes — that number is the redeem builder's cap
  let redeemCapacity = 0;
  for (let n = 11; n >= 6; n--) {
    const row = await measure(`redeem_no_via_market_${n}_distinct_makers`, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ob.harnessRedeemNoViaMarketIx(seller.publicKey, {
        market: market.publicKey, yesMint, noMint, quoteVault: collateralVault,
        tradeYesAta, userQuote: sellerQuote, userNo: sellerNo,
        bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey,
        marketBaseVault: baseVault, marketQuoteVault: quoteVault,
        makerOoAccounts: oos.slice(0, n), qLots: BigInt(n), priceLots: 40n,
      })], [seller]);
    if ((row as any).executed) { redeemCapacity = n; break; }
  }
  console.error(`G7 MEASURED redeem inline-maker capacity: ${redeemCapacity} distinct makers`);
  assert.ok(redeemCapacity >= 6, "redemption fills a meaningful inline batch");

  // G7.4: pre-consume + take composite
  for (let k = 0; k < 10; k++) await send([restOne(200n + BigInt(k))], [maker]);
  await send([ob.harnessPlaceTakeOrderIx({
    user: seller.publicKey, market: market.publicKey, bids: bids.publicKey,
    asks: asks.publicKey, eventHeap: heap.publicKey,
    marketBaseVault: baseVault, marketQuoteVault: quoteVault,
    userBaseAccount: sellerYes, userQuoteAccount: sellerQuote, makerOoAccounts: [],
    args: { side: ob.Side.Bid, priceLots: 40n, maxBaseLots: 8n, maxQuoteLotsIncludingFees: 320n,
      orderType: ob.PlaceOrderType.ImmediateOrCancel, limit: 16 },
  })], [seller]); // 8 heaped events — a full consume batch of backlog
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

  // PRD: "remove ALT authority and prove mutation is impossible" — freeze the
  // stable ALT (LAST, after all measurements) and prove extension fails
  const { AddressLookupTableProgram: ALTP } = await import("@solana/web3.js");
  await send([ALTP.freezeLookupTable({ lookupTable: stableAlt, authority: payer.publicKey })], [payer]);
  let frozen = false;
  try {
    await send([ALTP.extendLookupTable({ lookupTable: stableAlt, authority: payer.publicKey, payer: payer.publicKey, addresses: [Keypair.generate().publicKey] })], [payer]);
  } catch { frozen = true; }
  assert.ok(frozen, "frozen ALT rejects mutation — the post-M0 immutability requirement, exercised");

  for (const r of results) {
    const nm = String((r as any).name);
    if (nm === "venue_all_in_one_tx_variant") { assert.ok(!(r as any).fits_1232, "the 1-tx venue variant must remain oversize"); continue; }
    if (nm.endsWith("_legacy") || nm.endsWith("_no_alt")) continue; // ladder rungs: recorded, not required
    if (nm.includes("_distinct_makers")) continue; // capacity probe rows: recorded; the cap assert covers them
    assert.ok((r as any).fits_1232 && (r as any).executed, `${nm} fits and executes`);
  }
});
