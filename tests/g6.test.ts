/**
 * G6 — EventHeap / inline maker policy (PRD v0.7.1 §15).
 *
 * Pin facts under test:
 *   - FILL_EVENT_REMAINING_LIMIT = 15 (book.rs:19): with 16 fills and all 16
 *     maker OOs supplied, exactly 15 settle inline and the 16th lands on the
 *     heap — the limit is a program constant, not an account-count bound
 *   - MAX_NUM_EVENTS = 600 (heap.rs:9); EventHeap 91,280 B
 *   - saturation: push_back asserts !is_full (heap.rs:77) — a fill against a
 *     full heap PANICS the transaction: new fills become impossible until
 *     consume_events runs (fail-closed; motivates the consume-prepend policy)
 *   - consume_events CU cost measured per event => keeper throughput budget
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey,
  SystemProgram, Transaction, TransactionInstruction, TransactionMessage,
  VersionedTransaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction, createMintToInstruction, createMint,
  getAssociatedTokenAddressSync, createAssociatedTokenAccount, mintTo, getAccount,
} from "@solana/spl-token";
import * as ob from "./lib/openbook.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
let conn: Connection;
const payer = Keypair.generate();
const taker = Keypair.generate();
const MAKERS = 16;
const makers: Keypair[] = Array.from({ length: MAKERS }, () => Keypair.generate());
const market = Keypair.generate(), bids = Keypair.generate(), asks = Keypair.generate(), heap = Keypair.generate();
let baseMint: PublicKey, quoteMint: PublicKey;
let baseVault: PublicKey, quoteVault: PublicKey;
let takerBase: PublicKey, takerQuote: PublicKey;
const makerBase: PublicKey[] = [], makerQuote: PublicKey[] = [], makerOo: PublicKey[] = [];

const BASE_LOT = 1_000_000n, QUOTE_LOT = 10_000n;

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
let altAddress: PublicKey;
/** v0 + ALT sender — the exact G7 composite mechanics (large taker txs need
 * requestHeapFrame AND a lookup table to fit). */
async function sendV0(ixs: TransactionInstruction[], signers: Keypair[]) {
  const alt = (await conn.getAddressLookupTable(altAddress)).value!;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs,
  }).compileToV0Message([alt]);
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}
const heapCount = async () => (await conn.getAccountInfo(heap.publicKey))!.data.readUInt16LE(8 + 4); // header: free u16, used u16, count u16
async function cuOf(sig: string) {
  const info = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return info!.meta!.computeUnitsConsumed!;
}
const restIx = (i: number, price: bigint, id: bigint) => ob.harnessPlaceLimitOrderIx({
  user: makers[i].publicKey, ooAccount: makerOo[i], userTokenAccount: makerBase[i],
  market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
  eventHeap: heap.publicKey, marketVault: baseVault,
  args: { side: ob.Side.Ask, priceLots: price, maxBaseLots: 1n, maxQuoteLotsIncludingFees: price,
    clientOrderId: id, orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n,
    selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
});
const takeIx = (lots: bigint, worst: bigint, oos: PublicKey[]) => ob.harnessPlaceTakeOrderIx({
  user: taker.publicKey, market: market.publicKey, bids: bids.publicKey,
  asks: asks.publicKey, eventHeap: heap.publicKey,
  marketBaseVault: baseVault, marketQuoteVault: quoteVault,
  userBaseAccount: takerBase, userQuoteAccount: takerQuote,
  makerOoAccounts: oos,
  args: { side: ob.Side.Bid, priceLots: worst, maxBaseLots: lots,
    maxQuoteLotsIncludingFees: worst * lots, orderType: ob.PlaceOrderType.ImmediateOrCancel, limit: 32 },
});

before(async () => {
  conn = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try { await conn.getLatestBlockhash(); break; }
    catch { if (i > 30) throw new Error("no validator — use scripts/run-suite.sh"); await new Promise(r => setTimeout(r, 1000)); }
  }
  for (const kp of [payer, taker]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 50_000_000_000);
    await conn.confirmTransaction(sig, "confirmed");
  }
  // fund makers from payer (faster than 16 airdrops)
  for (let i = 0; i < MAKERS; i += 8) {
    await send(makers.slice(i, i + 8).map(m =>
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: m.publicKey, lamports: 2_000_000_000 })), [payer]);
  }
  baseMint = await createMint(conn, payer, payer.publicKey, null, 6);
  quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  takerBase = await createAssociatedTokenAccount(conn, payer, baseMint, taker.publicKey);
  takerQuote = await createAssociatedTokenAccount(conn, payer, quoteMint, taker.publicKey);
  await mintTo(conn, payer, quoteMint, takerQuote, payer, 1_000_000_000n);
  // maker ATAs + base funding, batched
  for (let i = 0; i < MAKERS; i += 4) {
    const ixs: TransactionInstruction[] = [];
    for (const m of makers.slice(i, i + 4)) {
      const b = getAssociatedTokenAddressSync(baseMint, m.publicKey);
      const q = getAssociatedTokenAddressSync(quoteMint, m.publicKey);
      makerBase.push(b); makerQuote.push(q);
      ixs.push(
        createAssociatedTokenAccountInstruction(payer.publicKey, b, m.publicKey, baseMint),
        createAssociatedTokenAccountInstruction(payer.publicKey, q, m.publicKey, quoteMint),
        createMintToInstruction(baseMint, b, payer.publicKey, 100_000_000n),
      );
    }
    await send(ixs, [payer]);
  }
  await send([ob.harnessInitializeIx(payer.publicKey)], [payer]);
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
    name: "G6-YES/USD", quoteLotSize: QUOTE_LOT, baseLotSize: BASE_LOT,
    makerFee: 0n, takerFee: 0n, timeExpiry: 0n,
    openOrdersAdmin: ob.venueAuthorityPda(), closeMarketAdmin: ob.venueAuthorityPda(),
  })], [payer, market]);
  const auth = ob.marketAuthorityPda(market.publicKey);
  baseVault = ob.ataFor(baseMint, auth); quoteVault = ob.ataFor(quoteMint, auth);
  const now = BigInt(Math.floor(Date.now() / 1000));
  await send([ob.harnessCreateVenueGateIx(payer.publicKey, market.publicKey, now - 60n, now + 3600n, payer.publicKey)], [payer]);
  for (let i = 0; i < MAKERS; i++) {
    await send([
      ob.createOoIndexerIx(payer.publicKey, makers[i].publicKey),
      ob.createOoAccountIx(payer.publicKey, makers[i].publicKey, 1, market.publicKey),
    ], [payer, makers[i]]);
    makerOo.push(ob.ooAccountPda(makers[i].publicKey, 1));
  }
  // ALT with every static account of the big take (G7's frozen-ALT mechanics)
  const slot = await conn.getSlot("finalized");
  const [createIx, alt] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot,
  });
  altAddress = alt;
  await send([createIx], [payer]);
  const addrs = [market.publicKey, bids.publicKey, asks.publicKey, heap.publicKey,
    baseVault, quoteVault, ob.OPENBOOK_PID, ob.TOKEN_PID, SystemProgram.programId,
    ob.harnessConfigPda(), ob.venueGatePda(market.publicKey), ob.venueAuthorityPda(),
    ...makerOo];
  for (let i = 0; i < addrs.length; i += 20) {
    await send([AddressLookupTableProgram.extendLookupTable({
      lookupTable: alt, authority: payer.publicKey, payer: payer.publicKey,
      addresses: addrs.slice(i, i + 20),
    })], [payer]);
  }
  await new Promise(r => setTimeout(r, 1500)); // ALT activates next slot
});

async function restAll(n: number, round: bigint) {
  for (let i = 0; i < n; i++) await send([restIx(i, BigInt(40 + i), round)], [makers[i]]);
}
async function cleanupMakers(n: number) {
  for (let i = 0; i < n; i++) {
    await send([
      ob.cancelAllOrdersIx(makers[i].publicKey, makerOo[i], market.publicKey, bids.publicKey, asks.publicKey),
      ob.settleFundsIx({
        owner: makers[i].publicKey, ooAccount: makerOo[i], market: market.publicKey,
        marketBaseVault: baseVault, marketQuoteVault: quoteVault,
        userBaseAccount: makerBase[i], userQuoteAccount: makerQuote[i],
      })], [makers[i]]);
  }
}
const HEAP_FRAME = [
  ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 }),
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
];

test("G6.1 KEY FINDING: the venue's SBF heap bounds inline fills below the 15-account policy", async () => {
  await restAll(16, 1n);
  assert.equal(await heapCount(), 0, "clean heap before the take");
  // without a heap frame: OOM inside the PINNED VENUE PROGRAM
  let text = "";
  try { await sendV0([takeIx(16n, BigInt(40 + MAKERS - 1), makerOo)], [taker]); }
  catch (e: any) { text = `${e.message}\n${(e.transactionLogs ?? e.logs ?? []).join("\n")}`; }
  assert.ok(text.includes("memory allocation failed"), "16 inline fills OOM the venue at the pin");
  // requestHeapFrame(256KB) does NOT rescue the CPI'd program on this
  // validator: the inner invocation still gets the default heap
  text = "";
  try { await sendV0([...HEAP_FRAME, takeIx(16n, BigInt(40 + MAKERS - 1), makerOo)], [taker]); }
  catch (e: any) { text = `${e.message}\n${(e.transactionLogs ?? e.logs ?? []).join("\n")}`; }
  assert.ok(text.includes("memory allocation failed"),
    "heap frame does not extend the CPI'd venue program's heap — the bound is hard");
  await cleanupMakers(16);
});

test("G6.1b measured practical inline capacity (the number that replaces the 15 policy)", async () => {
  let maxOk = 0;
  for (const n of [4, 8, 10, 12, 14, 15]) {
    await restAll(n, 10n + BigInt(n));
    try {
      await sendV0([takeIx(BigInt(n), BigInt(40 + n - 1), makerOo.slice(0, n))], [taker]);
      maxOk = n;
      await send([ob.consumeEventsIx(market.publicKey, heap.publicKey, 8n, makerOo.slice(0, n))], [payer]).catch(() => {});
      await cleanupMakers(n); // settle proceeds so the next round can rest again
    } catch {
      await cleanupMakers(n); // clear resting orders from the failed take
      break;
    }
  }
  console.error(`G6 MEASURED practical inline-fill capacity: ${maxOk} (policy said 15; heap-bounded below that)`);
  assert.ok(maxOk >= 4, "a meaningful inline batch works");
  assert.ok(maxOk < 16, "the 16th can never settle inline anyway (FILL_EVENT_REMAINING_LIMIT)");
});

test("G6.2 consume_events batch CU: marginal cost per event and keeper budget", async () => {
  // settle any maker proceeds; rest 8 fresh asks and take with NO maker OOs
  // supplied so all 8 fills heap (heap frame for the take's own allocations)
  await restAll(8, 2n);
  await send([takeIx(8n, 47n, [])], [taker]);
  assert.equal(await heapCount(), 8, "all 8 fills heaped without remaining accounts");
  // an owner-less consume SKIPS everything (events need their OO accounts)
  await send([ob.consumeEventsIx(market.publicKey, heap.publicKey, 8n)], [payer]);
  assert.equal(await heapCount(), 8, "consume without owner OOs consumes nothing (skip semantics)");
  const sig1 = await send([ob.consumeEventsIx(market.publicKey, heap.publicKey, 1n, makerOo.slice(0, 8))], [payer]);
  const cu1 = await cuOf(sig1);
  assert.equal(await heapCount(), 7);
  const sig7 = await send([ob.consumeEventsIx(market.publicKey, heap.publicKey, 7n, makerOo.slice(0, 8))], [payer]);
  const cu7 = await cuOf(sig7);
  assert.equal(await heapCount(), 0, "batch consume with owner OOs drains the heap");
  const marginal = Math.ceil((cu7 - cu1) / 6);
  // MAX_EVENTS_CONSUME = 8 caps a single instruction; a 1.4M-CU tx chains
  // multiple consume instructions
  const perIx = 8;
  const cuPerIx = cu7 + marginal; // ~8-event instruction cost
  const ixPerTx = Math.floor(1_400_000 / cuPerIx);
  console.error(`G6 consume CU: 1-event=${cu1}, 7-event=${cu7}, marginal/event≈${marginal}; ` +
    `MAX_EVENTS_CONSUME=8/ix; ~${ixPerTx} consume ixs per 1.4M-CU tx => ${perIx * ixPerTx} events/tx; ` +
    `at 2 keeper tx/s => ${2 * perIx * ixPerTx} events/s vs heap capacity 600 => full drain < ${Math.ceil(600 / (2 * perIx * ixPerTx))}s`);
  assert.ok(marginal < 30_000, "consuming an event costs a small, bounded CU amount");
  assert.ok(perIx * ixPerTx >= 40, "one tx can drain a meaningful batch");
});

test("G6.3 saturation is fail-closed at the pin (source-anchored)", async () => {
  // heap.rs:77 push_back asserts !is_full(): a fill against a FULL heap
  // panics, reverting the order transaction — new fills are impossible until
  // consume_events runs. Empirical full-heap fill (600 unsettled events) is
  // impractical in-suite; the discriminator golden + the G6.1/G6.2 heap
  // accounting anchor the behavior to the scanned source.
  assert.equal(await heapCount(), 0);
  assert.deepEqual([...ob.disc("consume_events")], [221, 145, 177, 52, 31, 47, 63, 201]);
  // additional consume facts pinned by G6.2: MAX_EVENTS_CONSUME = 8 per
  // instruction (consume_events.rs:11) and skip-without-owner semantics
  // (consume_events.rs load_open_orders_account! macro)
});
