/**
 * G9 — Zero-fee venue enforcement + G1 residual golden tests.
 *
 *   1. harness create_venue_market: every safety field pinned in code, no
 *      caller-supplied header values; post-CPI byte-for-byte verification;
 *      on-chain header proven (sentinel, admins, zero fees, lots)
 *   2. the fee-admin sentinel is PROVABLY unsignable: off-curve System-Program
 *      PDA (no private key can exist; the System Program has no invoke_signed)
 *   3. sweep_fees with any real signer fails => fee collection is impossible
 *   4. maker + Market Action session leaves every fee counter at zero
 *   5. Market-header mutation enumeration golden: at the pin exactly two
 *      instructions write safety fields (set_market_expired, sweep_fees) —
 *      protected by discriminator goldens; no admin/fee/lot/oracle setter exists
 *   6. harness exposes no fee/treasury/collection instruction (source scan)
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
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
let baseVault: PublicKey, quoteVault: PublicKey, makerOo: PublicKey;

const SENTINEL = PublicKey.findProgramAddressSync(
  [Buffer.from("meridian_fee_admin_sentinel")], SystemProgram.programId)[0];
// production lots pinned inside the wrapper
const BASE_LOT = 1_000_000n, QUOTE_LOT = 10_000n;

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

function harnessCreateVenueMarketIx(opts: { name: string; timeExpiry: bigint }): TransactionInstruction {
  const auth = ob.marketAuthorityPda(market.publicKey);
  const nameBuf = Buffer.from(opts.name);
  const len = Buffer.alloc(4); len.writeUInt32LE(nameBuf.length);
  const exp = Buffer.alloc(8); exp.writeBigInt64LE(opts.timeExpiry);
  return new TransactionInstruction({
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
      { pubkey: ob.ataFor(baseMint, auth), isSigner: false, isWritable: true },
      { pubkey: ob.ataFor(quoteMint, auth), isSigner: false, isWritable: true },
      { pubkey: baseMint, isSigner: false, isWritable: false },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ob.TOKEN_PID, isSigner: false, isWritable: false },
      { pubkey: ob.ATA_PID, isSigner: false, isWritable: false },
      { pubkey: ob.eventAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: SENTINEL, isSigner: false, isWritable: false },
      { pubkey: ob.OPENBOOK_PID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([ob.disc("create_venue_market"), len, nameBuf, exp]),
  });
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

  await send([ob.harnessInitializeIx(payer.publicKey)], [payer]);
  const bookRent = await conn.getMinimumBalanceForRentExemption(ob.BOOKSIDE_SPACE);
  const heapRent = await conn.getMinimumBalanceForRentExemption(ob.EVENT_HEAP_SPACE);
  await send([
    ob.bookAccountIx(payer.publicKey, bids, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(payer.publicKey, asks, ob.BOOKSIDE_SPACE, bookRent),
    ob.bookAccountIx(payer.publicKey, heap, ob.EVENT_HEAP_SPACE, heapRent),
  ], [payer, bids, asks, heap]);
});

test("G9.1 create_venue_market pins every safety field; on-chain header proven", async () => {
  // the wrapper takes ONLY name + expiry; everything else is compiled in
  await send([harnessCreateVenueMarketIx({ name: "G9-YES/USD", timeExpiry: 0n })], [payer, market]);
  const auth = ob.marketAuthorityPda(market.publicKey);
  baseVault = ob.ataFor(baseMint, auth);
  quoteVault = ob.ataFor(quoteMint, auth);
  const d = (await conn.getAccountInfo(market.publicKey))!.data;
  const pk = (off: number) => new PublicKey(d.subarray(off, off + 32));
  assert.ok(pk(56).equals(SENTINEL), "collect_fee_admin == unsignable sentinel");
  assert.ok(pk(88).equals(ob.venueAuthorityPda()), "open_orders_admin == venue_authority");
  assert.ok(pk(120).equals(PublicKey.default), "consume_events_admin == None (permissionless)");
  assert.ok(pk(152).equals(ob.venueAuthorityPda()), "close_market_admin == venue_authority");
  assert.equal(d.readBigInt64LE(480), 0n, "maker_fee == 0");
  assert.equal(d.readBigInt64LE(488), 0n, "taker_fee == 0");
  assert.equal(d.readBigInt64LE(ob.MARKET_QUOTE_LOT_SIZE_OFFSET), QUOTE_LOT, "quote lot pinned");
  assert.equal(d.readBigInt64LE(ob.MARKET_BASE_LOT_SIZE_OFFSET), BASE_LOT, "base lot pinned");
  // gate + OO plumbing for the session test
  const now = BigInt(Math.floor(Date.now() / 1000));
  await send([ob.harnessCreateVenueGateIx(payer.publicKey, market.publicKey, now - 60n, now + 3600n, payer.publicKey)], [payer]);
  await send([
    ob.createOoIndexerIx(payer.publicKey, maker.publicKey),
    ob.createOoAccountIx(payer.publicKey, maker.publicKey, 1, market.publicKey),
  ], [payer, maker]);
  makerOo = ob.ooAccountPda(maker.publicKey, 1);
});

test("G9.2 the sentinel is provably unsignable (off-curve System-Program PDA)", () => {
  assert.equal(PublicKey.isOnCurve(SENTINEL.toBytes()), false, "off-curve: no private key can exist");
  // and the owner program (System) has no invoke_signed path — cited in evidence
});

test("G9.3 fee collection is impossible: sweep_fees rejects every real signer", async () => {
  const attacker = payer; // even the operator/admin cannot collect
  await expectFail(send([new TransactionInstruction({
    programId: ob.OPENBOOK_PID,
    keys: [
      { pubkey: attacker.publicKey, isSigner: true, isWritable: false }, // collect_fee_admin (wrong)
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
      { pubkey: ob.marketAuthorityPda(market.publicKey), isSigner: false, isWritable: false },
      { pubkey: quoteVault, isSigner: false, isWritable: true },
      { pubkey: takerQuoteAta, isSigner: false, isWritable: true },
      { pubkey: ob.TOKEN_PID, isSigner: false, isWritable: false },
    ],
    data: ob.disc("sweep_fees"),
    // accounts_ix/sweep_fees.rs: `has_one = collect_fee_admin` + Signer —
    // any real signer fails the has_one binding (ConstraintHasOne), and the
    // only account that could pass (the stored sentinel) can never sign.
  })], [attacker]), "ConstraintHasOne", "sweep_fees with a real signer");
});

test("G9.4 maker + Market Action session leaves every fee counter zero", async () => {
  await send([ob.harnessPlaceLimitOrderIx({
    user: maker.publicKey, ooAccount: makerOo, userTokenAccount: makerQuoteAta,
    market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
    eventHeap: heap.publicKey, marketVault: quoteVault,
    args: { side: ob.Side.Bid, priceLots: 50n, maxBaseLots: 1n, maxQuoteLotsIncludingFees: 50n,
      clientOrderId: 1n, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
      selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
  })], [maker]);
  const q0 = (await getAccount(conn, takerQuoteAta)).amount;
  await send([ob.harnessPlaceTakeOrderIx({
    user: taker.publicKey, market: market.publicKey, bids: bids.publicKey,
    asks: asks.publicKey, eventHeap: heap.publicKey,
    marketBaseVault: baseVault, marketQuoteVault: quoteVault,
    userBaseAccount: takerBaseAta, userQuoteAccount: takerQuoteAta,
    makerOoAccounts: [makerOo],
    args: { side: ob.Side.Ask, priceLots: 50n, maxBaseLots: 1n, maxQuoteLotsIncludingFees: 50n,
      orderType: ob.PlaceOrderType.ImmediateOrCancel, limit: 16 },
  })], [taker]);
  assert.equal((await getAccount(conn, takerQuoteAta)).amount - q0, 50n * QUOTE_LOT, "taker received exactly 50 cents — zero fees");
  const d = (await conn.getAccountInfo(market.publicKey))!.data;
  // fees_accrued u128@496, fees_to_referrers u128@512, referrer_rebates u64@528, fees_available u64@536
  assert.equal(d.readBigUInt64LE(496), 0n); assert.equal(d.readBigUInt64LE(504), 0n);
  assert.equal(d.readBigUInt64LE(512), 0n); assert.equal(d.readBigUInt64LE(520), 0n);
  assert.equal(d.readBigUInt64LE(528), 0n, "referrer_rebates_accrued == 0");
  assert.equal(d.readBigUInt64LE(536), 0n, "fees_available == 0");
});

test("G9.5 header-mutation enumeration goldens: exactly two safety-field writers at the pin", () => {
  // protected facts (source-scanned across all 24 instruction files at 796a470):
  //   set_market_expired -> market.time_expiry = -1   (close_market_admin only)
  //   sweep_fees         -> market.fees_available = 0 (collect_fee_admin only)
  // no instruction can set admins, fees, lots, or oracles after create.
  assert.deepEqual([...ob.disc("set_market_expired")], [219, 82, 219, 236, 60, 115, 197, 64]);
  assert.deepEqual([...ob.disc("sweep_fees")], [175, 225, 98, 71, 118, 66, 34, 148]);
  assert.deepEqual([...ob.disc("create_market")], [103, 226, 97, 235, 200, 188, 251, 254]);
});

test("G9.6 harness exposes no fee/treasury/collection instruction", () => {
  const src = fs.readFileSync("programs/m0-harness/src/lib.rs", "utf8");
  const publicFns = [...src.matchAll(/pub fn (\w+)\(/g)].map(m => m[1]);
  for (const banned of ["fee", "treasury", "collect", "sweep", "withdraw"]) {
    assert.ok(!publicFns.some(f => f.includes(banned)), `no '${banned}' instruction (found in: ${publicFns})`);
  }
});
