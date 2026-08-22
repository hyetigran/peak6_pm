/**
 * Wire-format golden for the keeper's abandon_market instruction (#21). Locks
 * the Anchor discriminator and the account order/flags against the program's
 * AbandonMarket context (operator, config, market, yes_mint, no_mint). Pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { abandonMarketIx, configPda, MERIDIAN_PID } from "../services/keeper/src/ix.js";

test("abandonMarketIx: sha256('global:abandon_market') discriminator, no args", () => {
  const op = Keypair.generate().publicKey, market = Keypair.generate().publicKey;
  const yes = Keypair.generate().publicKey, no = Keypair.generate().publicKey;
  const ix = abandonMarketIx(op, market, yes, no);
  const disc = createHash("sha256").update("global:abandon_market").digest().subarray(0, 8);
  assert.ok(ix.programId.equals(MERIDIAN_PID));
  assert.deepEqual(Uint8Array.from(ix.data), Uint8Array.from(disc), "discriminator only, no borsh args");
});

test("abandonMarketIx: account order + signer/writable flags match the program", () => {
  const op = Keypair.generate().publicKey, market = Keypair.generate().publicKey;
  const yes = Keypair.generate().publicKey, no = Keypair.generate().publicKey;
  const k = abandonMarketIx(op, market, yes, no).keys;
  assert.equal(k.length, 5);
  assert.ok(k[0].pubkey.equals(op) && k[0].isSigner && k[0].isWritable);      // operator (payer/signer)
  assert.ok(k[1].pubkey.equals(configPda()) && !k[1].isSigner && !k[1].isWritable); // config
  assert.ok(k[2].pubkey.equals(market) && !k[2].isSigner && k[2].isWritable); // market (mut)
  assert.ok(k[3].pubkey.equals(yes) && !k[3].isWritable);                     // yes_mint
  assert.ok(k[4].pubkey.equals(no) && !k[4].isWritable);                      // no_mint
});
