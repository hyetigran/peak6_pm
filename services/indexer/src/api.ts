import http from "node:http";
import type Database from "better-sqlite3";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { createMintToInstruction, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import fs from "node:fs";
import { decodeBookSide, ladder, ownersFor, type BookLevel } from "./layout.js";
import { readPaused, setGlobalPause, settleMarket, overrideSettle, type SettleRow } from "./admin.js";

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
async function completeness(conn: Connection, db: Database.Database) {
  const last = Number((db.prepare("SELECT v FROM meta WHERE k='last_slot'").get() as any)?.v ?? 0);
  const tip = await conn.getSlot("confirmed");
  return { indexed_slot: last, chain_slot: tip, lag: tip - last, complete: tip - last <= 8 };
}

export function serve(db: Database.Database, conn: Connection, port: number) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" }); return res.end(); }
      if (url.pathname === "/health") return json(res, 200, { ok: true, ...(await completeness(conn, db)) });

      // --- Admin / Ops console (localnet demo: signs with .demo-config.json roles) ---
      if (url.pathname === "/admin/state") {
        try { return json(res, 200, { paused: await readPaused(conn) }); }
        catch (e) { return json(res, 200, { paused: false, error: (e as Error).message }); }
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
        const rows = db.prepare("SELECT * FROM markets ORDER BY ticker, CAST(strike_1e6 AS INTEGER)").all();
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
        const row = db.prepare("SELECT bids,asks,openbook_market,state_name FROM markets WHERE pubkey=?").get(bMatch[1]) as any;
        if (!row) return json(res, 404, { error: "not found" });
        if (!row.openbook_market || row.openbook_market === "11111111111111111111111111111111")
          return json(res, 200, { bids: [], asks: [], best_bid: null, best_ask: null, mark: null, yes_prob: null, no_prob: null, note: "no venue attached" });
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
