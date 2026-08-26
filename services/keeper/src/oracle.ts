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
 *     Hermes price-update reads need auth: set PYTH_HERMES_TOKEN (Bearer) and
 *     optionally PYTH_HERMES_URL. Without a token every settlement retries.
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
  // Hermes requires an access token for /v2/updates/price/* (a bare public read
  // 401s). PYTH_HERMES_TOKEN is sent as a Bearer header by the client;
  // PYTH_HERMES_URL points at a self-hosted or provider Hermes instead.
  const hermesUrl = process.env.PYTH_HERMES_URL?.trim() || "https://hermes.pyth.network";
  const hermesToken = process.env.PYTH_HERMES_TOKEN?.trim() || undefined;
  const hermes = new HermesClient(hermesUrl, hermesToken ? { accessToken: hermesToken } : {});
  if (!hermesToken) log(`WARNING: PYTH_HERMES_TOKEN is unset — ${hermesUrl} will 401 on price updates and every settlement will retry`);
  log(`oracle = pyth (Hermes pull -> post -> adapter crank; capture=${capture}; hermes=${hermesUrl} ${hermesToken ? "with token" : "NO TOKEN"})`);
  return async (tickerId, feed, closeTs) => {
    const w = captureWindow({ closeTs, now: Math.floor(Date.now() / 1000), mode: capture, latestMaxAgeSecs: maxAge });
    let txs;
    try {
      txs = await buildPythCrankTxs({ receiver, hermes, cranker: op.publicKey, tickerId, maxAgeSecs: w.maxAgeSecs, publishTime: w.publishTime });
    } catch (e) {
      // Annotate the auth failure — otherwise it surfaces as an opaque fetch error
      // inside a retry reason and looks like a transient blip forever.
      const msg = (e as Error).message ?? String(e);
      if (/\b401\b|unauthorized|\b403\b|forbidden/i.test(msg)) {
        throw new Error(`Hermes rejected the request as unauthorized (${hermesUrl}); ${hermesToken ? "PYTH_HERMES_TOKEN is set but not accepted" : "PYTH_HERMES_TOKEN is unset"}: ${msg.slice(0, 120)}`);
      }
      throw e;
    }
    for (const { tx, signers } of txs) { tx.sign([op, ...signers]); await conn.confirmTransaction(await conn.sendTransaction(tx), "confirmed"); }
    const info = await conn.getAccountInfo(feed);
    if (!info) throw new Error("pyth: delivery account not written");
    return info.data.readBigUInt64LE(DELIVERY_CLOSE_1E6);
  };
}
