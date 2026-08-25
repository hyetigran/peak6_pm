import { Connection, PublicKey } from "@solana/web3.js";
import { openDb } from "./db.js";
import { ingestOnce } from "./ingest.js";
import { serve } from "./api.js";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const PROGRAM = new PublicKey(process.env.MERIDIAN_PID ?? "HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD");
const PORT = Number(process.env.PORT ?? 8787);
const DB = process.env.INDEXER_DB ?? ".indexer.sqlite";
// Full-scan cadence (one getProgramAccounts + one batched book read per pass).
// 1.5s is the localnet demo; on a keyed devnet/mainnet RPC use ~60s — the
// book/portfolio endpoints read live per request, so this only bounds how
// fast the market LIST and settlement state refresh.
const POLL_MS = Number(process.env.INDEXER_POLL_MS ?? "1500");
if (!Number.isFinite(POLL_MS) || POLL_MS < 250) throw new Error(`INDEXER_POLL_MS must be a number >= 250 (got ${process.env.INDEXER_POLL_MS})`);

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const db = openDb(DB);
  serve(db, conn, PORT);
  console.log(`[indexer] polling ${PROGRAM.toBase58()} on ${RPC} every ${POLL_MS}ms`);
  for (;;) {
    try { const n = await ingestOnce(conn, db, PROGRAM); process.stdout.write(`\r[indexer] ${n} markets   `); }
    catch (e) { console.error("[indexer] ingest error:", (e as Error).message); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
main();
