/**
 * Client for the Pyth oracle adapter (programs/pyth-adapter) — the synthetic
 * devnet-demo settlement transport (#16). Pure builders (no RPC), so they
 * unit-test without a validator. The Hermes pull + posting the PriceUpdateV2
 * live in the keeper's devnet crank path; this module builds the adapter
 * `crank` instruction and derives the per-ticker delivery account Meridian pins.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "node:crypto";

export const PYTH_ADAPTER_PID = new PublicKey("Egc4ykuRJaDz7VfWS9EB9U2hsP2aU9repCCk8XGnk7w4");

/** Verified Pyth `Equity.US.<T>/USD` feed ids (Hermes, devnet-usable), by ticker id. */
export const PYTH_FEED_IDS: Record<number, string> = {
  1: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688", // AAPL
  2: "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a", // AMZN
  3: "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6", // GOOGL (Class A)
  4: "78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe", // META
  5: "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1", // MSFT
  6: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593", // NVDA
  7: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1", // TSLA
};

const disc = (name: string): Buffer => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

/** The per-ticker delivery account the adapter owns and Meridian pins as
 *  `record.switchboard_feed` (seeds `[b"delivery", ticker_id]`). Stable across
 *  trading days; overwritten each settlement. */
export function deliveryPda(tickerId: number, adapter: PublicKey = PYTH_ADAPTER_PID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("delivery"), Buffer.from([tickerId])], adapter)[0];
}

/** Build the adapter `crank(feed_id_hex, max_age_secs, ticker_id)` instruction.
 *  The price is read from `priceUpdate` on-chain; the args carry only the feed
 *  id + staleness bound + ticker (for the delivery seed). */
export function crankIx(opts: {
  cranker: PublicKey;
  priceUpdate: PublicKey;
  tickerId: number;
  maxAgeSecs?: bigint;
  adapter?: PublicKey;
}): TransactionInstruction {
  const adapter = opts.adapter ?? PYTH_ADAPTER_PID;
  const feedIdHex = PYTH_FEED_IDS[opts.tickerId];
  if (!feedIdHex) throw new Error(`no Pyth feed id for ticker ${opts.tickerId}`);

  // borsh args: String (u32 len + utf8), u64, u8
  const feed = Buffer.from(feedIdHex, "utf8");
  const len = Buffer.alloc(4); len.writeUInt32LE(feed.length);
  const maxAge = Buffer.alloc(8); maxAge.writeBigUInt64LE(opts.maxAgeSecs ?? 300n);
  const data = Buffer.concat([disc("crank"), len, feed, maxAge, Buffer.from([opts.tickerId])]);

  return new TransactionInstruction({
    programId: adapter,
    keys: [
      { pubkey: opts.cranker, isSigner: true, isWritable: true },
      { pubkey: opts.priceUpdate, isSigner: false, isWritable: false },
      { pubkey: deliveryPda(opts.tickerId, adapter), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}
