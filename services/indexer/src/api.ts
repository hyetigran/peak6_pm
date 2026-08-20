import http from "node:http";
import type Database from "better-sqlite3";
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeBookSide, ladder, type BookLevel } from "./layout.js";

function json(res: http.ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(s);
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
      if (url.pathname === "/health") return json(res, 200, { ok: true, ...(await completeness(conn, db)) });
      if (url.pathname === "/markets") {
        const rows = db.prepare("SELECT * FROM markets ORDER BY ticker, CAST(strike_1e6 AS INTEGER)").all();
        return json(res, 200, { markets: rows, meta: await completeness(conn, db) });
      }
      const mMatch = url.pathname.match(/^\/markets\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (mMatch) {
        const row = db.prepare("SELECT * FROM markets WHERE pubkey=?").get(mMatch[1]);
        return row ? json(res, 200, row) : json(res, 404, { error: "not found" });
      }
      const bMatch = url.pathname.match(/^\/book\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (bMatch) {
        const row = db.prepare("SELECT bids,asks,openbook_market,state_name FROM markets WHERE pubkey=?").get(bMatch[1]) as any;
        if (!row) return json(res, 404, { error: "not found" });
        if (!row.openbook_market || row.openbook_market === "11111111111111111111111111111111")
          return json(res, 200, { bids: [], asks: [], best_bid: null, best_ask: null, mark: null, yes_prob: null, no_prob: null, note: "no venue attached" });
        const [bidsInfo, asksInfo] = await conn.getMultipleAccountsInfo([new PublicKey(row.bids), new PublicKey(row.asks)]);
        const bids: BookLevel[] = bidsInfo ? ladder(decodeBookSide(bidsInfo.data as Buffer), "bid") : [];
        const asks: BookLevel[] = asksInfo ? ladder(decodeBookSide(asksInfo.data as Buffer), "ask") : [];
        const bestBid = bids[0]?.price ?? null;
        const bestAsk = asks[0]?.price ?? null;
        const mark = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2
          : bestBid ?? bestAsk ?? null; // one-sided fallback
        return json(res, 200, {
          bids, asks, best_bid: bestBid, best_ask: bestAsk, mark,
          yes_prob: mark != null ? +(mark / 100).toFixed(4) : null,
          no_prob: mark != null ? +((100 - mark) / 100).toFixed(4) : null,
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
