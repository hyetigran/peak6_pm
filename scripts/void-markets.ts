/**
 * VOID a set of markets whose Settlement Records can never finalize normally:
 * finalize_settlement_manual at a sentinel value (override authority), then
 * settle_market for every market bound to those records (permissionless).
 * Usage: RPC_URL=… OVERRIDE_KEYPAIR=keys/override-*.json EVIDENCE=docs/settlement-evidence/<file>.json
 *        [CRANKER_KEYPAIR=~/.config/solana/id.json] [INDEXER=https://…] pnpm exec tsx scripts/void-markets.ts
 */
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as m from "@meridian/sdk/meridian";

const conn = new Connection(process.env.RPC_URL!, "confirmed");
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const override = load(process.env.OVERRIDE_KEYPAIR!);
const cranker = load(process.env.CRANKER_KEYPAIR ?? os.homedir() + "/.config/solana/id.json");
const evidencePath = process.env.EVIDENCE!;
const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
const manifestSha256 = createHash("sha256").update(fs.readFileSync(evidencePath)).digest();
const INDEXER = process.env.INDEXER ?? "https://indexer-production-86c3.up.railway.app";
const send = (ixs: any[], signers: Keypair[]) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });

const all = await (await fetch(`${INDEXER}/markets`)).json();
const records = new Set<string>(Object.values(evidence.records) as string[]);
const markets: any[] = (Array.isArray(all) ? all : all.markets).filter((x: any) => records.has(x.settlement_record));
console.log(`evidence ${evidencePath} sha256 ${manifestSha256.toString("hex")}`);
console.log(`${markets.length} markets, ${records.size} records, sentinel ${evidence.official_close_1e6} reason ${evidence.reason_code}`);

const recState = async (rec: string) => (await conn.getAccountInfo(new PublicKey(rec)))!.data[8];
for (const rec of records) {
  const s = await recState(rec);
  if (s !== 0) { console.log(`record ${rec} already state ${s}, skip`); continue; }
  const sig = await send([m.finalizeSettlementManualIx({
    overrideAuthority: override.publicKey, record: new PublicKey(rec),
    sourceA1e6: BigInt(evidence.official_close_1e6), sourceB1e6: BigInt(evidence.official_close_1e6),
    reasonCode: evidence.reason_code, manifestSha256,
  })], [override]);
  console.log(`finalize_manual ${rec} -> state ${await recState(rec)} ${sig}`);
}
let settled = 0;
for (const mk of markets) {
  if (mk.state === 3) { settled++; continue; }
  if (!records.has(mk.settlement_record)) { console.log(`skip ${mk.pubkey}: record not in evidence`); continue; }
  try {
    const sig = await send([m.settleMarketIx({ cranker: cranker.publicKey, market: new PublicKey(mk.pubkey), record: new PublicKey(mk.settlement_record) })], [cranker]);
    settled++; console.log(`settle ${mk.ticker} ${Number(mk.strike_1e6) / 1e6} ${sig.slice(0, 12)}…`);
  } catch (e: any) { console.log(`FAIL ${mk.ticker} ${mk.pubkey}: ${e.message.split("\n")[0]}`); }
}
console.log(`settled ${settled}/${markets.length}`);
