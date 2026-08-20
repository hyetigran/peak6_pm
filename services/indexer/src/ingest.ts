import { Connection, PublicKey } from "@solana/web3.js";
import type Database from "better-sqlite3";
import { acctDisc, decodeOutcomeMarket } from "./layout.js";
import { upsertMarket } from "./db.js";

/** Poll all OutcomeMarket accounts owned by the program and project them. */
export async function ingestOnce(conn: Connection, db: Database.Database, programId: PublicKey) {
  const disc = acctDisc("OutcomeMarket");
  const accts = await conn.getProgramAccounts(programId, {
    filters: [{ memcmp: { offset: 0, bytes: Buffer.from(disc).toString("base64"), encoding: "base64" } as any }],
  });
  const slot = await conn.getSlot("confirmed");
  const tx = db.transaction(() => {
    for (const a of accts) {
      try { upsertMarket(db, decodeOutcomeMarket(a.pubkey.toBase58(), a.account.data as Buffer), slot); }
      catch (e) { console.error("decode failed", a.pubkey.toBase58(), (e as Error).message); }
    }
    db.prepare("INSERT INTO meta(k,v) VALUES('last_slot',?) ON CONFLICT(k) DO UPDATE SET v=?").run(String(slot), String(slot));
  });
  tx();
  return accts.length;
}
