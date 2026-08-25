import http from "node:http";
import type Database from "better-sqlite3";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { createMintToInstruction, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import fs from "node:fs";
import { decodeBookSide, ladder, ownersFor, type BookLevel } from "./layout.js";
import { readPaused, setGlobalPause, settleMarket, overrideSettle, type SettleRow } from "./admin.js";
import { live } from "./ingest.js";
import { type BookHub, type BookSnapshot } from "./books.js";

const SYS_KEY = "11111111111111111111111111111111";

/** Attach a live YES mark (cents) + yes_prob to each venued market row. */
let hubRef: BookHub | null = null;
async function attachMarks(conn: Connection, rows: any[]) {
  const venued = rows.filter((r) => r.bids && r.bids !== SYS_KEY && r.asks && r.asks !== SYS_KEY).filter((r) => {
    const snap = hubRef?.snapshot(r.pubkey);
    if (!snap) return true;
    r.mark = snap.mark; r.yes_prob = snap.yes_prob; return false; // served from the subscription cache
  });
  if (!venued.length) return;
  const keys = venued.flatMap((r) => [new PublicKey(r.bids), new PublicKey(r.asks)]);
  const infos: (Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>>[number])[] = [];
  for (let i = 0; i < keys.length; i += 100) infos.push(...await conn.getMultipleAccountsInfo(keys.slice(i, i + 100)));
  venued.forEach((r, i) => {
    const bidsInfo = infos[i * 2], asksInfo = infos[i * 2 + 1];
    const bids = ladder(bidsInfo ? decodeBookSide(bidsInfo.data as Buffer) : [], "bid");
    const asks = ladder(asksInfo ? decodeBookSide(asksInfo.data as Buffer) : [], "ask");
    const bb = bids[0]?.price ?? null, ba = asks[0]?.price ?? null;
    const mark = bb != null && ba != null ? (bb + ba) / 2 : bb ?? ba ?? null;
    r.mark = mark;
    r.yes_prob = mark != null ? +(mark / 100).toFixed(4) : null;
  });
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(s);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let d = ""; req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

/** History Completeness: report the indexer's last-seen slot vs the chain tip. */
/** Health = "is the indexer keeping up with its own cadence", NOT slot distance.
 *  The market list is refreshed by the websocket (event-driven) and reconciled
 *  every pollMs; books/marks/portfolio are read live per request. So the
 *  list is stale only if neither a ws event nor a reconcile landed within
 *  2x the reconcile interval. `lag` is still reported for ops. */
let pollMsForHealth = 1500;
async function completeness(conn: Connection, db: Database.Database) {
  const meta = (k: string) => Number((db.prepare("SELECT v FROM meta WHERE k=?").get(k) as any)?.v ?? 0);
  const dbSlot = meta("last_slot");
  const lastIngestTs = meta("last_ingest_ts");
  const now = Math.floor(Date.now() / 1000);
  const wsFresh = live.subscribed && now - live.lastEventTs <= 30;
  const indexedSlot = wsFresh ? Math.max(dbSlot, live.lastSlot) : dbSlot;
  const tip = wsFresh ? Math.max(live.lastSlot, dbSlot) : await conn.getSlot("confirmed");
  const staleAfter = Math.max(30, Math.ceil((pollMsForHealth * 2) / 1000));
  const complete = wsFresh || (lastIngestTs > 0 && now - lastIngestTs <= staleAfter);
  return {
    indexed_slot: indexedSlot, chain_slot: tip, lag: Math.max(0, tip - indexedSlot), complete,
    mode: wsFresh ? "subscription" : "poll", last_ingest_ts: lastIngestTs, seconds_since_ingest: lastIngestTs ? now - lastIngestTs : null,
  };
}

// Short-TTL response memo so N viewers polling the same endpoint cost one RPC
// read per window instead of N. Keyed by full path (scope included).
const memo = new Map<string, { at: number; body: string }>();
const MEMO_MS: Record<string, number> = { "/markets": 2000, "/book": 1000, "/event": 1500, "/health": 2000 };

// Global pause flag, refreshed at most every 15s (it changes by admin action only).
let pausedCache: { at: number; v: boolean } = { at: 0, v: false };
async function pausedCached(conn: Connection): Promise<boolean> {
  if (Date.now() - pausedCache.at > 15_000) { try { pausedCache = { at: Date.now(), v: await readPaused(conn) }; } catch { pausedCache.at = Date.now(); } }
  return pausedCache.v;
}

/** Live book for a market row (bids/asks/mark). */
async function bookOf(conn: Connection, row: any) {
  if (!row?.openbook_market || row.openbook_market === SYS_KEY)
    return { bids: [], asks: [], best_bid: null, best_ask: null, mark: null, yes_prob: null, no_prob: null, note: "no venue attached" };
  const [bidsInfo, asksInfo] = await conn.getMultipleAccountsInfo([new PublicKey(row.bids), new PublicKey(row.asks)]);
  const bidLeaves = bidsInfo ? decodeBookSide(bidsInfo.data as Buffer) : [];
  const askLeaves = asksInfo ? decodeBookSide(asksInfo.data as Buffer) : [];
  const bids: BookLevel[] = ladder(bidLeaves, "bid"), asks: BookLevel[] = ladder(askLeaves, "ask");
  const bestBid = bids[0]?.price ?? null, bestAsk = asks[0]?.price ?? null;
  const mark = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk ?? null;
  const yes_prob = mark != null ? +(mark / 100).toFixed(4) : null;
  return { bids, asks, best_bid: bestBid, best_ask: bestAsk, mark, yes_prob, no_prob: yes_prob != null ? +(1 - yes_prob).toFixed(4) : null,
    // resting-order owners (for the keeper's prune pass)
    bid_owners: [...new Set(bidLeaves.map((l) => l.owner))], ask_owners: [...new Set(askLeaves.map((l) => l.owner))],
    // raw leaves so /event can derive "your orders" without a second read
    _bidLeaves: bidLeaves, _askLeaves: askLeaves };
}
const ordersFrom = (bidLeaves: any[], askLeaves: any[], oo: string) => {
  const mine = (leaves: any[], side: "bid" | "ask") => leaves.filter((l) => l.owner === oo).map((l) => ({ side, price: l.price, shares: l.shares }));
  const agg = new Map<string, { side: string; price: number; shares: number }>();
  for (const o of [...mine(bidLeaves, "bid"), ...mine(askLeaves, "ask")]) { const k = `${o.side}:${o.price}`; const e = agg.get(k); if (e) e.shares += o.shares; else agg.set(k, { ...o }); }
  return [...agg.values()].sort((a, b) => b.price - a.price);
};
const stripLeaves = ({ _bidLeaves, _askLeaves, ...rest }: any) => rest;
function memoFor(pathname: string): number { if (pathname.endsWith("/stream")) return 0; for (const k of Object.keys(MEMO_MS)) if (pathname === k || pathname.startsWith(k + "/")) return MEMO_MS[k]; return 0; }

export function serve(db: Database.Database, conn: Connection, port: number, pollMs = 1500, hub: BookHub | null = null) {
  pollMsForHealth = pollMs; hubRef = hub;
  // Live books from the hub when it has the venue; RPC otherwise.
  const bookFor = async (row: any) => {
    const snap = hub?.snapshot(row.pubkey);
    if (snap) return { ...snap, _bidLeaves: [] as any[], _askLeaves: [] as any[], _hub: true };
    return bookOf(conn, row);
  };
  const ordersFor = (row: any, book: any, oo: string) => hub?.has(row.pubkey) ? hub.orders(row.pubkey, oo) : ordersFrom(book._bidLeaves, book._askLeaves, oo);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      // memoized GET reads
      const ttl = req.method === "GET" ? memoFor(url.pathname) : 0;
      const memoKey = url.pathname + url.search;
      if (ttl) {
        const hit = memo.get(memoKey);
        if (hit && Date.now() - hit.at < ttl) { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "x-memo": "hit" }); return res.end(hit.body); }
        // capture the fresh 200 body as it is written
        const end = res.end.bind(res);
        (res as any).end = (chunk?: any, ...rest: any[]) => {
          if (res.statusCode === 200 && typeof chunk === "string") memo.set(memoKey, { at: Date.now(), body: chunk });
          return end(chunk, ...rest);
        };
      }
      if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" }); return res.end(); }
      if (url.pathname === "/health") return json(res, 200, { ok: true, ...(await completeness(conn, db)), paused: await pausedCached(conn), books_subscribed: hub?.size ?? 0 });

      // One-shot snapshot for the event page: the ticker's markets (all days, so
      // a bare /event/aapl can resolve the latest day), the order-slip book,
      // the drill-down book (only if different), recent fills and the caller's
      // resting orders — replaces five independent pollers with one request.
      const evMatch = url.pathname.match(/^\/event\/([A-Za-z]{1,8})$/);
      if (evMatch) {
        const ticker = evMatch[1].toUpperCase();
        const sel = url.searchParams.get("sel"), exp = url.searchParams.get("exp"), oo = url.searchParams.get("oo");
        const isPk = (v: string | null): v is string => !!v && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
        const markets = db.prepare("SELECT * FROM markets WHERE ticker=? ORDER BY trading_day DESC, CAST(strike_1e6 AS INTEGER)").all(ticker) as any[];
        const rowOf = (pk: string) => markets.find((m) => m.pubkey === pk) ?? db.prepare("SELECT * FROM markets WHERE pubkey=?").get(pk);
        const selRow = isPk(sel) ? rowOf(sel) : null;
        const expRow = isPk(exp) ? (exp === sel ? selRow : rowOf(exp)) : null;
        const [book, expBookRaw] = await Promise.all([
          selRow ? bookFor(selRow) : Promise.resolve(null),
          expRow && exp !== sel ? bookFor(expRow) : Promise.resolve(null),
        ]);
        const expBook = exp === sel ? book : expBookRaw;
        const fills = isPk(exp) ? db.prepare("SELECT ts,side,price,qty FROM fills WHERE market=? ORDER BY id DESC LIMIT 25").all(exp) : [];
        const orders = expBook && expRow && isPk(oo) ? ordersFor(expRow, expBook, oo) : [];
        // YES marks for every live row of the ticker (one batched read), so the
        // strike list renders prices; the two full books above override theirs.
        await attachMarks(conn, markets.filter((m) => m.state !== 3 && m.state !== 4));
        for (const m of markets) { const b = m.pubkey === sel ? book : m.pubkey === exp ? expBook : null; if (b) { m.mark = b.mark; m.yes_prob = b.yes_prob; } }
        return json(res, 200, {
          ticker, markets, book: book ? stripLeaves(book) : null, exp_book: expBook ? stripLeaves(expBook) : null, fills, orders,
          health: { ...(await completeness(conn, db)), paused: await pausedCached(conn) },
        });
      }

      // Server-sent events for the event page: initial snapshot (markets of the
      // ticker, every live book, recent fills, caller's orders), then `book`
      // deltas as the venue subscriptions fire and `market` rows as they change.
      // One websocket per venue on the indexer; zero polling in the browser.
      const esMatch = url.pathname.match(/^\/event\/([A-Za-z]{1,8})\/stream$/);
      if (esMatch) {
        if (!hub) return json(res, 503, { error: "streaming disabled (INDEXER_SUBSCRIBE=0)" });
        const ticker = esMatch[1].toUpperCase();
        const oo = url.searchParams.get("oo");
        const ooOk = !!oo && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(oo);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "connection": "keep-alive",
          "access-control-allow-origin": "*", "x-accel-buffering": "no" });
        res.flushHeaders?.();
        const sendEv = (event: string, data: unknown) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
        const rows = db.prepare("SELECT * FROM markets WHERE ticker=? ORDER BY trading_day DESC, CAST(strike_1e6 AS INTEGER)").all(ticker) as any[];
        const books: Record<string, BookSnapshot> = {}, fills: Record<string, any[]> = {}, orders: Record<string, any[]> = {};
        for (const r of rows) {
          const snap = hub.snapshot(r.pubkey);
          if (snap) { books[r.pubkey] = snap; r.mark = snap.mark; r.yes_prob = snap.yes_prob; }
          if (r.state !== 3 && r.state !== 4) {
            fills[r.pubkey] = db.prepare("SELECT ts,side,price,qty FROM fills WHERE market=? ORDER BY id DESC LIMIT 25").all(r.pubkey);
            if (ooOk) orders[r.pubkey] = hub.orders(r.pubkey, oo!);
          }
        }
        sendEv("snapshot", { ticker, markets: rows, books, fills, orders, health: { ...(await completeness(conn, db)), paused: await pausedCached(conn) } });
        const onBook = (e: any) => {
          if (e.ticker !== ticker) return;
          sendEv("book", { market: e.market, book: e.book, fills: e.fills, orders: ooOk ? hub.orders(e.market, oo!) : undefined });
        };
        const onMarket = (m: any) => {
          const row = db.prepare("SELECT * FROM markets WHERE pubkey=?").get(m.pubkey) as any;
          if (!row || row.ticker !== ticker) return;
          const snap = hub.snapshot(row.pubkey); if (snap) { row.mark = snap.mark; row.yes_prob = snap.yes_prob; }
          sendEv("market", row);
        };
        hub.on("book", onBook); hub.on("market", onMarket);
        const hb = setInterval(() => { if (!res.writableEnded) res.write(`: hb ${Date.now()}\n\n`); }, 15_000);
        req.on("close", () => { clearInterval(hb); hub.off("book", onBook); hub.off("market", onMarket); });
        return;
      }

      // --- Admin / Ops console (localnet demo: signs with .demo-config.json roles) ---
      if (url.pathname === "/admin/state") {
        try { return json(res, 200, { paused: await readPaused(conn) }); }
        catch (e) { return json(res, 200, { paused: false, error: (e as Error).message }); }
      }
      if (url.pathname === "/admin/keeper") {
        try {
          const s = JSON.parse(fs.readFileSync(process.env.KEEPER_STATUS ?? ".keeper-status.json", "utf8"));
          const age = Math.floor(Date.now() / 1000) - (s.ts ?? 0);
          return json(res, 200, { ...s, age, running: age <= 20 }); // stale after ~20s
        } catch { return json(res, 200, { running: false }); }
      }
      if (url.pathname === "/admin/marketmaker") {
        try {
          const s = JSON.parse(fs.readFileSync(process.env.MM_STATUS ?? ".mm-status.json", "utf8"));
          const age = Math.floor(Date.now() / 1000) - (s.ts ?? 0);
          return json(res, 200, { ...s, age, running: age <= 30 });
        } catch { return json(res, 200, { running: false }); }
      }
      if (url.pathname === "/admin/pause" && req.method === "POST") {
        try {
          const { paused } = await readBody(req);
          const sig = await setGlobalPause(conn, !!paused);
          return json(res, 200, { ok: true, paused: !!paused, sig });
        } catch (e) { return json(res, 503, { error: "pause failed: " + (e as Error).message }); }
      }
      const sMatch = url.pathname.match(/^\/admin\/settle\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (sMatch && req.method === "POST") {
        try {
          const row = db.prepare("SELECT pubkey,ticker_id,trading_day,strike_1e6,close_ts,settled_ts,settlement_record FROM markets WHERE pubkey=?").get(sMatch[1]) as SettleRow | undefined;
          if (!row) return json(res, 404, { error: "market not found" });
          if (row.settled_ts) return json(res, 409, { error: "already settled" });
          const body = await readBody(req);
          const close1e6 = body.price != null ? BigInt(Math.round(Number(body.price) * 1e6)) : BigInt(row.strike_1e6) + 5_000_000n;
          const r = await settleMarket(conn, row, close1e6);
          return json(res, 200, { ok: true, ...r, close_1e6: close1e6.toString() });
        } catch (e) { return json(res, 503, { error: "settle failed: " + (e as Error).message }); }
      }
      const oMatch = url.pathname.match(/^\/admin\/override\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (oMatch && req.method === "POST") {
        try {
          const row = db.prepare("SELECT pubkey,ticker_id,trading_day,strike_1e6,close_ts,settled_ts,settlement_record FROM markets WHERE pubkey=?").get(oMatch[1]) as SettleRow | undefined;
          if (!row) return json(res, 404, { error: "market not found" });
          if (row.settled_ts) return json(res, 409, { error: "already settled" });
          const body = await readBody(req);
          if (body.price == null) return json(res, 400, { error: "override requires an explicit close price" });
          const close1e6 = BigInt(Math.round(Number(body.price) * 1e6));
          const r = await overrideSettle(conn, row, close1e6, body.reason ?? 1);
          return json(res, 200, { ok: true, ...r, close_1e6: close1e6.toString() });
        } catch (e) { return json(res, 503, { error: "override failed: " + (e as Error).message }); }
      }
      if (url.pathname === "/admin/settle-all" && req.method === "POST") {
        try {
          const now = Math.floor(Date.now() / 1000);
          const rows = db.prepare("SELECT pubkey,ticker_id,trading_day,strike_1e6,close_ts,settled_ts,settlement_record FROM markets WHERE (settled_ts IS NULL OR settled_ts=0) AND close_ts<=? ORDER BY ticker_id, CAST(strike_1e6 AS INTEGER)").all(now) as SettleRow[];
          const settled: string[] = [], errors: { market: string; error: string }[] = [];
          for (const row of rows) {
            try { await settleMarket(conn, row, BigInt(row.strike_1e6) + 5_000_000n); settled.push(row.pubkey); }
            catch (e) { errors.push({ market: row.pubkey, error: (e as Error).message }); }
          }
          return json(res, 200, { ok: true, eligible: rows.length, settled: settled.length, errors });
        } catch (e) { return json(res, 503, { error: "settle-all failed: " + (e as Error).message }); }
      }

      if (url.pathname === "/markets") {
        // ?scope=live -> only markets that are not Settled/Abandoned (the current
        // session); default (all) keeps the keeper/market-maker/portfolio/history
        // views, which need settled rows too. Live rows also skip the per-market
        // book reads for dead venues.
        const scope = url.searchParams.get("scope") ?? "all";
        const rows = (scope === "live"
          ? db.prepare("SELECT * FROM markets WHERE state NOT IN (3,4) AND (settled_ts IS NULL OR settled_ts=0) ORDER BY ticker, CAST(strike_1e6 AS INTEGER)")
          : db.prepare("SELECT * FROM markets ORDER BY ticker, CAST(strike_1e6 AS INTEGER)")).all() as any[];
        await attachMarks(conn, rows); // live YES mark per market for the market cards
        return json(res, 200, { markets: rows, meta: await completeness(conn, db) });
      }
      const mMatch = url.pathname.match(/^\/markets\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (mMatch) {
        const row = db.prepare("SELECT * FROM markets WHERE pubkey=?").get(mMatch[1]);
        return row ? json(res, 200, row) : json(res, 404, { error: "not found" });
      }
      const fMatch = url.pathname.match(/^\/faucet\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (fMatch) {
        // localnet demo faucet: mint 1000 test USDC to the address.
        try {
          const cfg = JSON.parse(fs.readFileSync(process.env.DEMO_FAUCET ?? ".demo-faucet.json", "utf8"));
          const auth = Keypair.fromSecretKey(Uint8Array.from(cfg.authority));
          const mint = new PublicKey(cfg.quoteMint);
          const owner = new PublicKey(fMatch[1]);
          const ata = getAssociatedTokenAddressSync(mint, owner);
          const tx = new Transaction().add(
            createAssociatedTokenAccountIdempotentInstruction(auth.publicKey, ata, owner, mint),
            createMintToInstruction(mint, ata, auth.publicKey, 1000_000_000n),
          );
          const sig = await sendAndConfirmTransaction(conn, tx, [auth], { commitment: "confirmed" });
          return json(res, 200, { ok: true, minted: "1000", mint: mint.toBase58(), sig });
        } catch (e) { return json(res, 503, { error: "faucet unavailable: " + (e as Error).message }); }
      }
      const bMatch = url.pathname.match(/^\/book\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (bMatch) {
        const row = db.prepare("SELECT pubkey,bids,asks,openbook_market,state_name FROM markets WHERE pubkey=?").get(bMatch[1]) as any;
        if (!row) return json(res, 404, { error: "not found" });
        if (!row.openbook_market || row.openbook_market === "11111111111111111111111111111111")
          return json(res, 200, { bids: [], asks: [], best_bid: null, best_ask: null, mark: null, yes_prob: null, no_prob: null, note: "no venue attached" });
        const cached = hub?.snapshot(row.pubkey);
        if (cached) return json(res, 200, { ...cached, note: undefined });
        const [bidsInfo, asksInfo] = await conn.getMultipleAccountsInfo([new PublicKey(row.bids), new PublicKey(row.asks)]);
        const bidLeaves = bidsInfo ? decodeBookSide(bidsInfo.data as Buffer) : [];
        const askLeaves = asksInfo ? decodeBookSide(asksInfo.data as Buffer) : [];
        const bids: BookLevel[] = ladder(bidLeaves, "bid");
        const asks: BookLevel[] = ladder(askLeaves, "ask");
        const bestBid = bids[0]?.price ?? null;
        const bestAsk = asks[0]?.price ?? null;
        const mark = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2
          : bestBid ?? bestAsk ?? null; // one-sided fallback
        return json(res, 200, {
          bids, asks, best_bid: bestBid, best_ask: bestAsk, mark,
          yes_prob: mark != null ? +(mark / 100).toFixed(4) : null,
          no_prob: mark != null ? +((100 - mark) / 100).toFixed(4) : null,
          bid_owners: ownersFor(bidLeaves, "bid"), ask_owners: ownersFor(askLeaves, "ask"),
        });
      }
      // market-wide recent fills (decoded from the EventHeap by the ingest loop)
      const flMatch = url.pathname.match(/^\/fills\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (flMatch) {
        const fills = db.prepare("SELECT ts,side,price,qty FROM fills WHERE market=? ORDER BY id DESC LIMIT 25").all(flMatch[1]);
        return json(res, 200, { market: flMatch[1], fills });
      }
      // resting orders on a market owned by a given OpenOrders account
      const ordMatch = url.pathname.match(/^\/orders\/([1-9A-HJ-NP-Za-km-z]{32,44})\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (ordMatch) {
        const row = db.prepare("SELECT bids,asks,openbook_market FROM markets WHERE pubkey=?").get(ordMatch[1]) as any;
        if (!row || !row.openbook_market || row.openbook_market === "11111111111111111111111111111111") return json(res, 200, { orders: [] });
        const oo = ordMatch[2];
        const [bidsInfo, asksInfo] = await conn.getMultipleAccountsInfo([new PublicKey(row.bids), new PublicKey(row.asks)]);
        const mine = (info: any, side: "bid" | "ask") =>
          (info ? decodeBookSide(info.data as Buffer) : []).filter((l) => l.owner === oo).map((l) => ({ side, price: l.price, shares: l.shares }));
        const raw = [...mine(bidsInfo, "bid"), ...mine(asksInfo, "ask")];
        // aggregate by side+price
        const agg = new Map<string, { side: string; price: number; shares: number }>();
        for (const o of raw) { const k = `${o.side}:${o.price}`; const e = agg.get(k); if (e) e.shares += o.shares; else agg.set(k, { ...o }); }
        const orders = [...agg.values()].sort((a, b) => b.price - a.price);
        return json(res, 200, { market: ordMatch[1], owner: oo, orders });
      }
      const pMatch = url.pathname.match(/^\/portfolio\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (pMatch) {
        // Position State is derived from on-chain token balances, read live.
        const owner = new PublicKey(pMatch[1]);
        const markets = db.prepare("SELECT pubkey,ticker,strike_1e6,yes_mint,no_mint,state_name,outcome_name FROM markets").all() as any[];
        const positions = [];
        for (const m of markets) {
          const yes = await tokenBalance(conn, owner, new PublicKey(m.yes_mint));
          const no = await tokenBalance(conn, owner, new PublicKey(m.no_mint));
          if (yes > 0n || no > 0n) positions.push({ ...m, yes: yes.toString(), no: no.toString(),
            position: yes > 0n && no > 0n ? (yes === no ? "Flat-paired" : "Mixed") : yes > 0n ? "Yes-sided" : "No-sided" });
        }
        return json(res, 200, { owner: pMatch[1], positions });
      }
      json(res, 404, { error: "unknown route" });
    } catch (e) { json(res, 500, { error: (e as Error).message }); }
  });
  server.listen(port, () => console.log(`[indexer] api on :${port}`));
  return server;
}

async function tokenBalance(conn: Connection, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const ata = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(), mint.toBuffer()],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0];
  const info = await conn.getAccountInfo(ata);
  if (!info) return 0n;
  return info.data.readBigUInt64LE(64);
}
