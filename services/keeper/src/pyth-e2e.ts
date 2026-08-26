/**
 * Local end-to-end proof of the Pyth crank chain (#16), against a validator that
 * clones the Pyth receiver + Wormhole (+ guardian set) from devnet and loads the
 * adapter. Pulls a REAL Hermes update, posts it, cranks the adapter, and reads
 * the delivery account. Dev harness (not part of the keeper runtime).
 *
 *   scripts/pyth-local.sh            # in one shell (clone validator)
 *   cd services/keeper && pnpm exec tsx src/pyth-e2e.ts [tickerId]   # in another
 */
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { HermesClient } from "@pythnetwork/hermes-client";
import { buildPythCrankTxs } from "./pyth-crank.js";
import { deliveryPda } from "./pyth-adapter.js";

async function main() {
  const conn = new Connection("http://127.0.0.1:8899", "confirmed");
  const payer = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 5_000_000_000), "confirmed");

  const wallet: any = {
    publicKey: payer.publicKey,
    payer,
    signTransaction: async (tx: any) => { tx.sign([payer]); return tx; },
    signAllTransactions: async (txs: any[]) => { txs.forEach((t) => t.sign([payer])); return txs; },
  };
  const receiver = new PythSolanaReceiver({ connection: conn, wallet });
  // Same auth as the keeper's oracle path: Hermes price-update reads 401 keyless.
  const hermesToken = process.env.PYTH_HERMES_TOKEN?.trim() || undefined;
  if (!hermesToken) console.warn("[e2e] PYTH_HERMES_TOKEN unset — Hermes will reject the pull with 401");
  const hermes = new HermesClient(
    process.env.PYTH_HERMES_URL?.trim() || "https://hermes.pyth.network",
    hermesToken ? { accessToken: hermesToken } : {},
  );

  const tickerId = Number(process.argv[2] ?? 1); // 1=AAPL
  console.log(`[e2e] pull Hermes -> post PriceUpdateV2 -> adapter crank (ticker ${tickerId})`);
  // large max age: equities are stale on weekends; still a real Pyth price.
  const txs = await buildPythCrankTxs({ receiver, hermes, cranker: payer.publicKey, tickerId, maxAgeSecs: 604_800n });

  for (const { tx, signers } of txs as { tx: VersionedTransaction; signers: any[] }[]) {
    tx.sign([payer, ...signers]);
    const sig = await conn.sendTransaction(tx);
    await conn.confirmTransaction(sig, "confirmed");
    console.log(`  sent ${sig.slice(0, 20)}…`);
  }

  const d = deliveryPda(tickerId);
  const info = await conn.getAccountInfo(d);
  if (!info) throw new Error("delivery account not written");
  const close = info.data.readBigUInt64LE(8);
  const slot = info.data.readBigUInt64LE(16);
  console.log(`[e2e] delivery ${d.toBase58()}`);
  console.log(`      official_close_1e6=${close} ($${(Number(close) / 1e6).toFixed(2)})  slot=${slot}  halt=${info.data[32]}  samples=${info.data[33]}`);
  console.log(close > 0n ? "[e2e] OK — a real Pyth price landed in the delivery account" : "[e2e] FAIL — zero price");
}
main().catch((e) => { console.error("[e2e]", String(e).slice(0, 700)); process.exit(1); });
