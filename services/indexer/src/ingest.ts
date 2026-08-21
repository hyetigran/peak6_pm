import { Connection, PublicKey } from "@solana/web3.js";
import type Database from "better-sqlite3";
import { acctDisc, decodeOutcomeMarket, decodeBookSide, ladder, type OutcomeMarketRow } from "./layout.js";
import { upsertMarket, insertFills, type DiffFill } from "./db.js";

const SYS = "11111111111111111111111111111111";
// previous book snapshot per market (price -> shares), for fill detection
const prevBooks = new Map<string, { asks: Map<number, number>; bids: Map<number, number> }>();
const toMap = (levels: { price: number; shares: number }[]) => new Map(levels.map((l) => [l.price, l.shares] as const));

/** Poll all OutcomeMarket accounts owned by the program and project them. */
export async function ingestOnce(conn: Connection, db: Database.Database, programId: PublicKey) {
  const disc = acctDisc("OutcomeMarket");
  const accts = await conn.getProgramAccounts(programId, {
    filters: [{ memcmp: { offset: 0, bytes: Buffer.from(disc).toString("base64"), encoding: "base64" } as any }],
  });
  const slot = await conn.getSlot("confirmed");
  const markets: OutcomeMarketRow[] = [];
  const tx = db.transaction(() => {
    for (const a of accts) {
      try { const m = decodeOutcomeMarket(a.pubkey.toBase58(), a.account.data as Buffer); upsertMarket(db, m, slot); markets.push(m); }
      catch (e) { console.error("decode failed", a.pubkey.toBase58(), (e as Error).message); }
    }
    db.prepare("INSERT INTO meta(k,v) VALUES('last_slot',?) ON CONFLICT(k) DO UPDATE SET v=?").run(String(slot), String(slot));
  });
  tx();
  await recordFills(conn, db, markets).catch((e) => console.error("[indexer] fills:", (e as Error).message));
  return accts.length;
}

/** Detect fills by diffing consecutive book snapshots. Meridian settles maker
 *  fills INLINE (takers pass maker OpenOrders), so nothing lands in the
 *  EventHeap — but a resting order shrinking between polls IS a fill. An ask
 *  level shrinking => someone bought Yes; a bid shrinking => someone sold Yes.
 *  (V1 has no manual cancel, so a shrink during trading is a fill.) */
async function recordFills(conn: Connection, db: Database.Database, markets: OutcomeMarketRow[]) {
  const venued = markets.filter((m) => m.bids && m.bids !== SYS && m.asks && m.asks !== SYS);
  if (!venued.length) return;
  const keys = venued.flatMap((m) => [new PublicKey(m.bids), new PublicKey(m.asks)]);
  const infos: (Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>>[number])[] = [];
  for (let i = 0; i < keys.length; i += 100) infos.push(...await conn.getMultipleAccountsInfo(keys.slice(i, i + 100)));
  const ts = Math.floor(Date.now() / 1000);
  venued.forEach((m, i) => {
    const bidsInfo = infos[i * 2], asksInfo = infos[i * 2 + 1];
    const curBids = toMap(ladder(bidsInfo ? decodeBookSide(bidsInfo.data as Buffer) : [], "bid"));
    const curAsks = toMap(ladder(asksInfo ? decodeBookSide(asksInfo.data as Buffer) : [], "ask"));
    const prev = prevBooks.get(m.pubkey);
    if (prev) {
      const fills: DiffFill[] = [];
      for (const [price, sz] of prev.asks) { const cur = curAsks.get(price) ?? 0; if (cur < sz) fills.push({ ts, side: 0, price, qty: sz - cur }); }
      for (const [price, sz] of prev.bids) { const cur = curBids.get(price) ?? 0; if (cur < sz) fills.push({ ts, side: 1, price, qty: sz - cur }); }
      insertFills(db, m.pubkey, fills);
    }
    prevBooks.set(m.pubkey, { asks: curAsks, bids: curBids });
  });
}
