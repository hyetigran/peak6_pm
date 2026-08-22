/**
 * Register the Pyth adapter as the settlement transport for every MAG7 ticker
 * (#16). For each ticker it calls register_transport with oracleProgram = the
 * adapter program and feed = the adapter's per-ticker delivery PDA — so Meridian
 * pins that delivery account (owner = adapter) as the record's oracle_feed.
 * Run once, after the program + config are up. Governance-signed.
 *
 *   RPC_URL=<devnet> DEMO_CONFIG=.demo-config.json pnpm exec tsx scripts/register-pyth-transports.ts
 */
import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import fs from "node:fs";
import * as m from "@meridian/sdk/meridian";
import { deliveryPda, PYTH_ADAPTER_PID } from "../services/keeper/src/pyth-adapter.js";

const TICKERS = [1, 2, 3, 4, 5, 6, 7]; // AAPL..TSLA

async function main() {
  const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
  const cfg = JSON.parse(fs.readFileSync(process.env.DEMO_CONFIG ?? ".demo-config.json", "utf8"));
  const gov = Keypair.fromSecretKey(Uint8Array.from(cfg.governance));

  const transports: Record<number, string> = {};
  for (const tid of TICKERS) {
    const feed = deliveryPda(tid);
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        m.registerTransportIx({ governance: gov.publicKey, versionId: 1, tickerId: tid, feed, oracleProgram: PYTH_ADAPTER_PID }),
      ),
      [gov],
      { commitment: "confirmed" },
    );
    transports[tid] = feed.toBase58();
    console.log(`ticker ${tid}: feed=${feed.toBase58()} oracle=${PYTH_ADAPTER_PID.toBase58()}`);
  }
  console.log("done — Pyth adapter transports registered for all 7 tickers");
  console.log("transports:", JSON.stringify(transports));
}

main().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
