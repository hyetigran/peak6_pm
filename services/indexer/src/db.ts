import Database from "better-sqlite3";
import type { OutcomeMarketRow } from "./layout.js";

export function openDb(path = ".indexer.sqlite") {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS markets (
      pubkey TEXT PRIMARY KEY, ticker_id INTEGER, ticker TEXT, trading_day INTEGER,
      strike_1e6 TEXT, mint_open_ts INTEGER, trade_open_ts INTEGER, close_ts INTEGER,
      state INTEGER, state_name TEXT, activity_started INTEGER, paused INTEGER,
      emergency_expired INTEGER, settlement_price_1e6 TEXT, outcome INTEGER, outcome_name TEXT,
      settled_ts INTEGER, settlement_record TEXT, yes_mint TEXT, no_mint TEXT,
      collateral_vault TEXT, openbook_market TEXT, bids TEXT, asks TEXT, event_heap TEXT,
      openbook_base_vault TEXT, openbook_quote_vault TEXT, collateral_liability_atoms TEXT,
      updated_slot INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT, ts INTEGER, side INTEGER, price INTEGER, qty INTEGER
    );
    CREATE INDEX IF NOT EXISTS fills_market_id ON fills(market, id DESC);
  `);
  return db;
}

export interface DiffFill { ts: number; side: number; price: number; qty: number }
export function insertFills(db: Database.Database, market: string, fills: DiffFill[]) {
  if (!fills.length) return;
  const stmt = db.prepare("INSERT INTO fills(market,ts,side,price,qty) VALUES(?,?,?,?,?)");
  const tx = db.transaction((fs: DiffFill[]) => { for (const f of fs) stmt.run(market, f.ts, f.side, f.price, f.qty); });
  tx(fills);
  // keep the table bounded per market
  db.prepare("DELETE FROM fills WHERE market=? AND id NOT IN (SELECT id FROM fills WHERE market=? ORDER BY id DESC LIMIT 60)").run(market, market);
}

export function upsertMarket(db: Database.Database, m: OutcomeMarketRow, slot: number) {
  db.prepare(`
    INSERT INTO markets (pubkey,ticker_id,ticker,trading_day,strike_1e6,mint_open_ts,trade_open_ts,close_ts,
      state,state_name,activity_started,paused,emergency_expired,settlement_price_1e6,outcome,outcome_name,
      settled_ts,settlement_record,yes_mint,no_mint,collateral_vault,openbook_market,bids,asks,event_heap,
      openbook_base_vault,openbook_quote_vault,collateral_liability_atoms,updated_slot)
    VALUES (@pubkey,@tickerId,@ticker,@tradingDay,@strike1e6,@mintOpenTs,@tradeOpenTs,@closeTs,
      @state,@stateName,@activityStarted,@paused,@emergencyExpired,@settlementPrice1e6,@outcome,@outcomeName,
      @settledTs,@settlementRecord,@yesMint,@noMint,@collateralVault,@openbookMarket,@bids,@asks,@eventHeap,
      @openbookBaseVault,@openbookQuoteVault,@collateralLiabilityAtoms,@slot)
    ON CONFLICT(pubkey) DO UPDATE SET
      state=@state,state_name=@stateName,activity_started=@activityStarted,paused=@paused,
      emergency_expired=@emergencyExpired,settlement_price_1e6=@settlementPrice1e6,outcome=@outcome,
      outcome_name=@outcomeName,settled_ts=@settledTs,collateral_liability_atoms=@collateralLiabilityAtoms,
      openbook_market=@openbookMarket,bids=@bids,asks=@asks,event_heap=@eventHeap,
      openbook_base_vault=@openbookBaseVault,openbook_quote_vault=@openbookQuoteVault,updated_slot=@slot
  `).run({ ...m, activityStarted: m.activityStarted ? 1 : 0, paused: m.paused ? 1 : 0,
           emergencyExpired: m.emergencyExpired ? 1 : 0, slot });
}
