/**
 * Unit tests for the Pyth adapter client (#16). Pure — no validator.
 * Run: pnpm exec tsx --test tests/pyth-adapter-client.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { crankIx, deliveryPda, PYTH_FEED_IDS, PYTH_ADAPTER_PID } from "../services/keeper/src/pyth-adapter.js";

test("PYTH_FEED_IDS: all 7 MAG7 tickers, each a 64-char hex id", () => {
  for (let t = 1; t <= 7; t++) assert.match(PYTH_FEED_IDS[t], /^[0-9a-f]{64}$/, `ticker ${t}`);
});

test("deliveryPda: stable per ticker, distinct across tickers, matches the seeds", () => {
  assert.ok(deliveryPda(1).equals(deliveryPda(1)), "same ticker -> same address");
  assert.ok(!deliveryPda(1).equals(deliveryPda(2)), "different ticker -> different address");
  const [expected] = PublicKey.findProgramAddressSync([Buffer.from("delivery"), Buffer.from([1])], PYTH_ADAPTER_PID);
  assert.ok(deliveryPda(1).equals(expected), "derived from [b\"delivery\", ticker] under the adapter id");
});

test("crankIx: discriminator, borsh args, account order/flags", () => {
  const cranker = PublicKey.unique();
  const priceUpdate = PublicKey.unique();
  const ix = crankIx({ cranker, priceUpdate, tickerId: 3, maxAgeSecs: 300n });

  // discriminator = sha256("global:crank")[..8]
  assert.deepEqual(ix.data.subarray(0, 8), createHash("sha256").update("global:crank").digest().subarray(0, 8));
  // String: u32 len (64) + the feed id utf8
  assert.equal(ix.data.readUInt32LE(8), 64);
  assert.equal(ix.data.subarray(12, 12 + 64).toString("utf8"), PYTH_FEED_IDS[3]);
  // u64 max_age then u8 ticker
  assert.equal(ix.data.readBigUInt64LE(12 + 64), 300n);
  assert.equal(ix.data[12 + 64 + 8], 3);

  // accounts: cranker(signer,mut), price_update(ro), delivery(mut,PDA), system
  assert.ok(ix.keys[0].pubkey.equals(cranker) && ix.keys[0].isSigner && ix.keys[0].isWritable);
  assert.ok(ix.keys[1].pubkey.equals(priceUpdate) && !ix.keys[1].isSigner && !ix.keys[1].isWritable);
  assert.ok(ix.keys[2].pubkey.equals(deliveryPda(3)) && ix.keys[2].isWritable && !ix.keys[2].isSigner);
  assert.ok(ix.keys[3].pubkey.equals(SystemProgram.programId));
  assert.ok(ix.programId.equals(PYTH_ADAPTER_PID));
});

test("crankIx: rejects an unsupported ticker", () => {
  assert.throws(() => crankIx({ cranker: PublicKey.unique(), priceUpdate: PublicKey.unique(), tickerId: 99 }), /no Pyth feed id/);
});
