/**
 * The delivery-refresh closure shared by the demo loop (index.ts) and the prod
 * scheduler (scheduler.ts): before finalize, write a fresh Official Close into
 * the per-ticker delivery account Meridian reads.
 *
 *   harness (localnet, default): publish the mock feed at `mockClose1e6` (the
 *     caller's price — the demo's random-walk spot, or a base for the scheduler).
 *   pyth    (KEEPER_ORACLE=pyth, devnet): Hermes pull -> post PriceUpdateV2 ->
 *     crank the adapter that OWNS the delivery account. Deps are dynamically
 *     imported so localnet never loads them. Capture-at-close policy per #26.
 *
 * Returns the Official Close actually delivered on-chain (in pyth mode the real
 * Pyth price, not the advisory `mockClose1e6`).
 */
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { publishMockFeedIx, DELIVERY_CLOSE_1E6 } from "./ix.js";

export type OracleRefresh = (tickerId: number, feed: PublicKey, closeTs: number, mockClose1e6: bigint) => Promise<bigint>;

export async function buildOracleRefresh(opts: {
  conn: Connection;
  op: Keypair;
  send: (ixs: TransactionInstruction[]) => Promise<unknown>;
  mode?: string;
  log?: (m: string) => void;
}): Promise<OracleRefresh> {
  const { conn, op, send } = opts;
  const log = opts.log ?? (() => {});
  if ((opts.mode ?? "harness") !== "pyth") {
    return async (tickerId, feed, _closeTs, mockClose1e6) => {
      await send([publishMockFeedIx(op.publicKey, feed, tickerId, mockClose1e6)]);
      return mockClose1e6;
    };
  }
  const { PythSolanaReceiver } = await import("@pythnetwork/pyth-solana-receiver");
  const { HermesClient } = await import("@pythnetwork/hermes-client");
  const { buildPythCrankTxs } = await import("./pyth-crank.js");
  const { captureWindow, parseCaptureMode } = await import("./pyth-capture.js");
  const capture = parseCaptureMode(process.env.KEEPER_PYTH_CAPTURE); // throws at boot on junk
  const maxAge = process.env.KEEPER_PYTH_MAX_AGE_SECS ? BigInt(process.env.KEEPER_PYTH_MAX_AGE_SECS) : undefined;
  const wallet: any = { publicKey: op.publicKey, payer: op, signTransaction: async (t: any) => { t.sign([op]); return t; }, signAllTransactions: async (t: any[]) => { t.forEach((x) => x.sign([op])); return t; } };
  const receiver = new PythSolanaReceiver({ connection: conn, wallet });
  const hermes = new HermesClient("https://hermes.pyth.network");
  log(`oracle = pyth (Hermes pull -> post -> adapter crank; capture=${capture})`);
  return async (tickerId, feed, closeTs) => {
    const w = captureWindow({ closeTs, now: Math.floor(Date.now() / 1000), mode: capture, latestMaxAgeSecs: maxAge });
    const txs = await buildPythCrankTxs({ receiver, hermes, cranker: op.publicKey, tickerId, maxAgeSecs: w.maxAgeSecs, publishTime: w.publishTime });
    for (const { tx, signers } of txs) { tx.sign([op, ...signers]); await conn.confirmTransaction(await conn.sendTransaction(tx), "confirmed"); }
    const info = await conn.getAccountInfo(feed);
    if (!info) throw new Error("pyth: delivery account not written");
    return info.data.readBigUInt64LE(DELIVERY_CLOSE_1E6);
  };
}
