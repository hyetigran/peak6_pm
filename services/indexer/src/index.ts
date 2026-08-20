import { Connection, PublicKey } from "@solana/web3.js";
import { openDb } from "./db.js";
import { ingestOnce } from "./ingest.js";
import { serve } from "./api.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const PROGRAM = new PublicKey(process.env.MERIDIAN_PID ?? "FF6mu5FFb1q1Qz88x1HnhkePdF8Q1dXWnTfUUSkzUT3t");
const PORT = Number(process.env.PORT ?? 8787);
const DB = process.env.INDEXER_DB ?? ".indexer.sqlite";

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const db = openDb(DB);
  serve(db, conn, PORT);
  console.log(`[indexer] polling ${PROGRAM.toBase58()} on ${RPC}`);
  for (;;) {
    try { const n = await ingestOnce(conn, db, PROGRAM); process.stdout.write(`\r[indexer] ${n} markets   `); }
    catch (e) { console.error("[indexer] ingest error:", (e as Error).message); }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
main();
