/**
 * G8 — Rent / daily market budget (PRD v0.7.1 §15).
 *
 * Measures exact lamports from real localnet accounts for every class that
 * exists today, computes rent for the frozen-layout Meridian accounts
 * (SettlementRecord, SettlementTransportVersion — PRD ID-014/ID-015), and
 * proves the ADR-0027 refund rule: venue close paths return rent ONLY to the
 * snapshotted Rent Refund Address. Emits the full table as JSON evidence.
 *
 * Not yet measurable (layouts land in M1, tracked by the go/no-go issue):
 * Meridian Outcome Market account, Config. Metaplex metadata is computed at
 * its standard 679-byte size.
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createAssociatedTokenAccount, createMint, mintTo } from "@solana/spl-token";
import * as ob from "./lib/openbook.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
let conn: Connection;
const payer = Keypair.generate();
const maker = Keypair.generate();
const refund = Keypair.generate();  // the snapshotted Rent Refund Address
const market = Keypair.generate(), bids = Keypair.generate(), asks = Keypair.generate(), heap = Keypair.generate();
let baseMint: PublicKey, quoteMint: PublicKey, makerQuoteAta: PublicKey;
let baseVault: PublicKey, quoteVault: PublicKey, makerOo: PublicKey;

const BASE_LOT = 1_000_000n, QUOTE_LOT = 1n;

/** Frozen-layout sizes, bytes = 8 (anchor disc) + field sum. */
// PRD ID-015 SettlementRecord: state 1 + header 251 + common 19 + oracle 131 + manual 50 + reserved 64
const SETTLEMENT_RECORD_BYTES = 8 + 1 + 251 + 19 + 131 + 50 + 64;
// PRD ID-014 SettlementTransportVersion: schema 1 + reserved 64 + version 4 + ticker 1
//   + pubkeys/hashes (32*6) + slot 8 + provider 2 + close_method 2 + activation 4
const TRANSPORT_VERSION_BYTES = 8 + 1 + 64 + 4 + 1 + 32 * 6 + 8 + 2 + 2 + 4;
const METAPLEX_METADATA_BYTES = 679; // standard Metadata account allocation
const SPL_MINT_BYTES = 82;
const ATA_BYTES = 165;

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
async function measure(name: string, pk: PublicKey) {
  const info = await conn.getAccountInfo(pk);
  assert.ok(info, `${name} exists`);
  const exempt = await conn.getMinimumBalanceForRentExemption(info!.data.length);
  assert.equal(info!.lamports, exempt, `${name} holds exactly rent-exempt minimum`);
  return { name, bytes: info!.data.length, lamports: info!.lamports };
}

before(async () => {
  conn = new Connection(RPC, "confirmed");
  for (let i = 0; ; i++) {
    try { await conn.getLatestBlockhash(); break; }
    catch { if (i > 30) throw new Error("no validator at " + RPC + " — use scripts/run-suite.sh"); await new Promise(r => setTimeout(r, 1000)); }
  }
  for (const kp of [payer, maker]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 20_000_000_000);
    await conn.confirmTransaction(sig, "confirmed");
  }
  baseMint = await createMint(conn, payer, payer.publicKey, null, 6);
  quoteMint = await createMint(conn, payer, payer.publicKey, null, 6);
  makerQuoteAta = await createAssociatedTokenAccount(conn, payer, quoteMint, maker.publicKey);
  await mintTo(conn, payer, quoteMint, makerQuoteAta, payer, 10_000_000n);

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
    name: "G8-YES/USD", quoteLotSize: QUOTE_LOT, baseLotSize: BASE_LOT,
    makerFee: 0n, takerFee: 0n, timeExpiry: 0n,
    openOrdersAdmin: ob.venueAuthorityPda(), closeMarketAdmin: ob.venueAuthorityPda(),
  })], [payer, market]);
  const auth = ob.marketAuthorityPda(market.publicKey);
  baseVault = ob.ataFor(baseMint, auth);
  quoteVault = ob.ataFor(quoteMint, auth);

  await send([ob.harnessInitializeIx(payer.publicKey)], [payer]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  await send([ob.harnessCreateVenueGateIx(payer.publicKey, market.publicKey, now - 60n, now + 3600n, refund.publicKey)], [payer]);
  await send([
    ob.createOoIndexerIx(payer.publicKey, maker.publicKey),
    ob.createOoAccountIx(payer.publicKey, maker.publicKey, 1, market.publicKey),
  ], [payer, maker]);
  makerOo = ob.ooAccountPda(maker.publicKey, 1);
});

test("G8.1 measure every existing account class; emit evidence table", async () => {
  const rows = [
    await measure("openbook_market", market.publicKey),
    await measure("bids", bids.publicKey),
    await measure("asks", asks.publicKey),
    await measure("event_heap", heap.publicKey),
    await measure("market_base_vault_ata", baseVault),
    await measure("market_quote_vault_ata", quoteVault),
    await measure("venue_gate", ob.venueGatePda(market.publicKey)),
    await measure("oo_indexer_1_entry", ob.ooIndexerPda(maker.publicKey)),
    await measure("oo_account", makerOo),
    await measure("spl_mint", baseMint),
    await measure("user_ata", makerQuoteAta),
  ];
  assert.equal(rows.find(r => r.name === "bids")!.bytes, ob.BOOKSIDE_SPACE);
  assert.equal(rows.find(r => r.name === "event_heap")!.bytes, ob.EVENT_HEAP_SPACE);
  assert.equal(rows.find(r => r.name === "spl_mint")!.bytes, SPL_MINT_BYTES);
  assert.equal(rows.find(r => r.name === "user_ata")!.bytes, ATA_BYTES);

  // frozen-layout Meridian accounts: exact rent, computed
  // computed exactly from frozen layouts — NOT on-chain measurements; each
  // must be re-measured when its account first exists (records/transport in
  // M1/M3, metadata in G12)
  const computed: { name: string; bytes: number; lamports: number; computed_from_frozen_layout: true }[] = [];
  for (const [name, bytes] of [
    ["settlement_record_frozen_layout", SETTLEMENT_RECORD_BYTES],
    ["settlement_transport_version_frozen_layout", TRANSPORT_VERSION_BYTES],
    ["metaplex_metadata_standard", METAPLEX_METADATA_BYTES],
  ] as const) {
    computed.push({ name, bytes, lamports: await conn.getMinimumBalanceForRentExemption(bytes), computed_from_frozen_layout: true });
  }

  const L = (n: string) => [...rows, ...computed].find(r => r.name === n)!.lamports;
  // one Outcome Market's venue-side footprint (operator-funded; PRD G8: the
  // operator is payer for every OpenBook Market/book/EventHeap/vault allocation)
  const perMarketVenue = L("openbook_market") + L("bids") + L("asks") + L("event_heap")
    + L("market_base_vault_ata") + L("market_quote_vault_ata") + L("venue_gate");
  // Meridian-side per Outcome Market (known today): 2 mints + 2 immutable
  // metadata; the Outcome Market account itself lands in M1
  const perMarketMeridianKnown = 2n * BigInt(L("spl_mint")) + 2n * BigInt(L("metaplex_metadata_standard"));
  const perDay = 49n * (BigInt(perMarketVenue) + perMarketMeridianKnown)
    + 7n * BigInt(L("settlement_record_frozen_layout"));
  const fiveDay = perDay * 5n;
  const budget = (fiveDay * 120n) / 100n;
  // worst-case locked: vaults, mints, metadata, settlement records never close
  // venue_gate has no close path in the harness => locked
  const lockedPerDay = 49n * (BigInt(L("market_base_vault_ata")) + BigInt(L("market_quote_vault_ata")) + BigInt(L("venue_gate")) + perMarketMeridianKnown)
    + 7n * BigInt(L("settlement_record_frozen_layout"));
  // best-case reclaimed: market+books+heap via close_market, OO accounts by owners
  const reclaimablePerDay = 49n * BigInt(L("openbook_market") + L("bids") + L("asks") + L("event_heap"));

  const evidence = {
    method: "measured on localnet against the pinned bytes; rent parameters are cluster defaults (verify on devnet in issue #8)",
    measured: rows,
    computed_from_frozen_layouts: computed,
    budget_lamports: {
      per_market_venue_side: perMarketVenue.toString(),
      per_market_meridian_known_side: perMarketMeridianKnown.toString(),
      per_day_49_markets_7_records: perDay.toString(),
      five_days: fiveDay.toString(),
      five_days_plus_20pct_reserve: budget.toString(),
      worst_case_locked_per_day: lockedPerDay.toString(),
      best_case_reclaimable_per_day: reclaimablePerDay.toString(),
    },
    pending_on_chain_measurement: [
      "meridian_outcome_market_account (M1)", "meridian_config (M1)",
      "settlement_record (M1/M3)", "settlement_transport_version (M1/M3)",
      "metaplex_metadata (G12)", "64-byte reserved padding verification in allocations (M1)",
    ],
  };
  fs.writeFileSync("docs/adr/g8-rent-measurements.json", JSON.stringify(evidence, null, 2) + "\n");
  assert.ok(budget > 0n);
  console.error(`G8 budget: 5 days + 20% = ${Number(budget) / 1e9} SOL; per-day locked ${Number(lockedPerDay) / 1e9} SOL, reclaimable ${Number(reclaimablePerDay) / 1e9} SOL`);
});

test("G8.2 venue close refunds ONLY to the snapshotted Rent Refund Address (ADR-0027)", async () => {
  // the collateral/venue vaults never pay: close only touches market+books+heap
  const mkt = (await conn.getAccountInfo(market.publicKey))!.lamports;
  const bb = (await conn.getAccountInfo(bids.publicKey))!.lamports;
  const aa = (await conn.getAccountInfo(asks.publicKey))!.lamports;
  const hh = (await conn.getAccountInfo(heap.publicKey))!.lamports;

  // must be expired first (G3-proven close precondition)
  await send([ob.harnessExpireMarketIx(payer.publicKey, market.publicKey)], [payer]);

  // wrong destination: rejected by the snapshot rule before any CPI
  await expectFail(send([ob.harnessCloseVenueMarketIx(payer.publicKey, {
    market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
    eventHeap: heap.publicKey, solDestination: payer.publicKey,
  })], [payer]), "WrongRefundDestination", "close to non-snapshotted destination");

  await send([ob.harnessCloseVenueMarketIx(payer.publicKey, {
    market: market.publicKey, bids: bids.publicKey, asks: asks.publicKey,
    eventHeap: heap.publicKey, solDestination: refund.publicKey,
  })], [payer]);
  const got = (await conn.getAccountInfo(refund.publicKey))!.lamports;
  assert.equal(BigInt(got), BigInt(mkt + bb + aa + hh), "refund address received exactly market+books+heap rent");
  assert.equal(await conn.getAccountInfo(market.publicKey), null, "market closed");

  // owner-path OO cleanup refunds the owner's chosen destination. At the pin
  // it ALSO shrinks the indexer by one Pubkey entry and sends that freed rent
  // (32 bytes) to the same destination.
  const ooLam = (await conn.getAccountInfo(makerOo))!.lamports;
  const idxBefore = (await conn.getAccountInfo(ob.ooIndexerPda(maker.publicKey)))!.lamports;
  const dest = Keypair.generate();
  await send([ob.closeOoAccountIx(maker.publicKey, ob.ooIndexerPda(maker.publicKey), makerOo, dest.publicKey)], [maker]);
  const idxAfter = (await conn.getAccountInfo(ob.ooIndexerPda(maker.publicKey)))!.lamports;
  assert.equal((await conn.getAccountInfo(dest.publicKey))!.lamports, ooLam + (idxBefore - idxAfter),
    "OO rent + indexer shrink refund recovered by owner");
  assert.ok(idxBefore > idxAfter, "indexer shrank by the removed entry");
});
