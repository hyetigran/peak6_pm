/**
 * BookHub — ONE websocket subscription per live venue book (bids + asks),
 * held by the indexer, fanned out to browsers over SSE. Replaces per-viewer
 * polling: RPC cost is independent of how many tabs are open, and a book
 * change reaches the page in one hop instead of on the next poll tick.
 *
 *   syncVenues(rows)   — subscribe live venues / drop settled ones (idempotent)
 *   snapshot(market)   — latest decoded book (or null before first read)
 *   on("book"|"market") — change events for SSE fans
 *
 * Fills are derived here too: a resting level shrinking between two book
 * versions IS a fill (inline settlement, no EventHeap), so the diff runs on
 * every notification rather than every reconcile pass.
 */
import { EventEmitter } from "node:events";
import { Connection, PublicKey } from "@solana/web3.js";
import type Database from "better-sqlite3";
import { decodeBookSide, ladder, ownersFor, type Leaf, type BookLevel } from "./layout.js";
import { insertFills, type DiffFill } from "./db.js";

const SYS = "11111111111111111111111111111111";

export interface BookSnapshot {
  bids: BookLevel[]; asks: BookLevel[]; best_bid: number | null; best_ask: number | null;
  mark: number | null; yes_prob: number | null; no_prob: number | null;
  bid_owners: string[]; ask_owners: string[]; slot: number;
}
interface Venue { market: string; ticker: string; bids: string; asks: string; bidLeaves: Leaf[]; askLeaves: Leaf[]; slot: number; subs: number[] }

export function ordersOf(v: { bidLeaves: Leaf[]; askLeaves: Leaf[] }, oo: string) {
  const mine = (leaves: Leaf[], side: "bid" | "ask") => leaves.filter((l) => l.owner === oo).map((l) => ({ side, price: l.price, shares: l.shares }));
  const agg = new Map<string, { side: string; price: number; shares: number }>();
  for (const o of [...mine(v.bidLeaves, "bid"), ...mine(v.askLeaves, "ask")]) { const k = `${o.side}:${o.price}`; const e = agg.get(k); if (e) e.shares += o.shares; else agg.set(k, { ...o }); }
  return [...agg.values()].sort((a, b) => b.price - a.price);
}

export function toSnapshot(v: { bidLeaves: Leaf[]; askLeaves: Leaf[]; slot: number }): BookSnapshot {
  const bids = ladder(v.bidLeaves, "bid"), asks = ladder(v.askLeaves, "ask");
  const best_bid = bids[0]?.price ?? null, best_ask = asks[0]?.price ?? null;
  const mark = best_bid != null && best_ask != null ? (best_bid + best_ask) / 2 : best_bid ?? best_ask ?? null;
  const yes_prob = mark != null ? +(mark / 100).toFixed(4) : null;
  return { bids, asks, best_bid, best_ask, mark, yes_prob, no_prob: yes_prob != null ? +(1 - yes_prob).toFixed(4) : null,
    bid_owners: ownersFor(v.bidLeaves, "bid"), ask_owners: ownersFor(v.askLeaves, "ask"), slot: v.slot };
}

export class BookHub extends EventEmitter {
  private venues = new Map<string, Venue>();      // market pubkey -> venue
  private byAccount = new Map<string, string>();  // bids/asks pubkey -> market pubkey
  constructor(private conn: Connection, private db: Database.Database) { super(); this.setMaxListeners(0); }

  get size() { return this.venues.size; }
  has(market: string) { return this.venues.has(market); }
  snapshot(market: string): BookSnapshot | null { const v = this.venues.get(market); return v && v.slot ? toSnapshot(v) : null; }
  orders(market: string, oo: string) { const v = this.venues.get(market); return v ? ordersOf(v, oo) : []; }
  /** Every venue of a ticker (for the SSE initial snapshot). */
  tickerVenues(ticker: string) { return [...this.venues.values()].filter((v) => v.ticker === ticker); }

  /** Subscribe live venues, unsubscribe dead ones. Rows are indexer market rows. */
  async syncVenues(rows: any[]) {
    const wanted = new Map<string, any>();
    for (const r of rows) if (r.state !== 3 && r.state !== 4 && r.bids && r.bids !== SYS && r.asks && r.asks !== SYS) wanted.set(r.pubkey, r);
    for (const [pk, v] of this.venues) if (!wanted.has(pk)) { await this.drop(v); }
    const fresh: Venue[] = [];
    for (const [pk, r] of wanted) if (!this.venues.has(pk)) {
      const v: Venue = { market: pk, ticker: r.ticker, bids: r.bids, asks: r.asks, bidLeaves: [], askLeaves: [], slot: 0, subs: [] };
      this.venues.set(pk, v); this.byAccount.set(r.bids, pk); this.byAccount.set(r.asks, pk);
      v.subs.push(this.conn.onAccountChange(new PublicKey(r.bids), (info, ctx) => this.apply(v, "bid", info.data as Buffer, ctx.slot), "confirmed"));
      v.subs.push(this.conn.onAccountChange(new PublicKey(r.asks), (info, ctx) => this.apply(v, "ask", info.data as Buffer, ctx.slot), "confirmed"));
      fresh.push(v);
    }
    if (fresh.length) await this.prime(fresh);
  }

  /** One batched read to seed new venues (so snapshots exist before the first change). */
  private async prime(vs: Venue[]) {
    const keys = vs.flatMap((v) => [new PublicKey(v.bids), new PublicKey(v.asks)]);
    for (let i = 0; i < keys.length; i += 100) {
      const infos = await this.conn.getMultipleAccountsInfoAndContext(keys.slice(i, i + 100));
      infos.value.forEach((info, j) => {
        const v = vs[Math.floor((i + j) / 2)], side = (i + j) % 2 === 0 ? "bid" : "ask";
        if (info) this.apply(v, side, info.data as Buffer, infos.context.slot, true);
        else if (side === "ask") { v.slot = infos.context.slot; }
      });
    }
    for (const v of vs) if (!v.slot) v.slot = 1; // venue exists but both sides empty
  }

  private apply(v: Venue, side: "bid" | "ask", data: Buffer, slot: number, priming = false) {
    let leaves: Leaf[];
    try { leaves = decodeBookSide(data); } catch (e) { console.error(`[books] decode ${v.market} ${side}: ${(e as Error).message}`); return; }
    const prev = side === "bid" ? v.bidLeaves : v.askLeaves;
    if (side === "bid") v.bidLeaves = leaves; else v.askLeaves = leaves;
    if (slot > v.slot) v.slot = slot;
    if (priming) return;
    // fills: a level that shrank is a fill (ask shrank => someone bought Yes; bid shrank => sold Yes)
    const before = new Map(ladder(prev, side).map((l) => [l.price, l.shares] as const));
    const after = new Map(ladder(leaves, side).map((l) => [l.price, l.shares] as const));
    const ts = Math.floor(Date.now() / 1000);
    const fills: DiffFill[] = [];
    for (const [price, sz] of before) { const cur = after.get(price) ?? 0; if (cur < sz) fills.push({ ts, side: side === "ask" ? 0 : 1, price, qty: sz - cur }); }
    if (fills.length) { try { insertFills(this.db, v.market, fills); } catch (e) { console.error(`[books] fills ${v.market}: ${(e as Error).message}`); } }
    this.emit("book", { market: v.market, ticker: v.ticker, book: toSnapshot(v), fills, venue: v });
  }

  private async drop(v: Venue) {
    this.venues.delete(v.market); this.byAccount.delete(v.bids); this.byAccount.delete(v.asks);
    for (const s of v.subs) await this.conn.removeAccountChangeListener(s).catch(() => {});
  }
}
