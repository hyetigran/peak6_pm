/**
 * Settle a trading day through the Override Authority path when the pinned
 * oracle transport cannot deliver the Official Close.
 *
 * Why this exists: a SettlementRecord's oracle identity header (oracle_program_id,
 * oracle_feed, oracle_executable_sha256, ...) is IMMUTABLE once the first market
 * for the (ticker, day) is created. So when the pinned transport goes away —
 * Pyth gating US equity feeds behind a paid entitlement on 2026-08-26, say —
 * finalize_settlement_normal can never satisfy the Settlement Quality Predicate
 * for those records, and no config change can rescue them. finalize_settlement_manual
 * is the designed escape hatch: the Override Authority attests an Official Close
 * that TWO independent sources agree on, with a sha256 of the evidence manifest
 * recorded on-chain (finalize_settlement.rs: `source_a == source_b && > 0`,
 * `now >= close_ts + override_delay_secs`).
 *
 * This is NOT the same as scripts/void-markets.ts. That one finalizes at a
 * sentinel (reason 65535) to void markets that can never have a real price.
 * This one settles at a REAL, corroborated Official Close — the outcomes are
 * genuine, but their trust model is operator attestation rather than a Pyth
 * signature, and the evidence file says so in the clear.
 *
 * Dry run by default — it prints the table and writes nothing on-chain.
 * Pass --execute to submit.
 *
 * Usage:
 *   RPC_URL=… OVERRIDE_KEYPAIR=keys/override-FXo9Dw….json \
 *   [CRANKER_KEYPAIR=~/.config/solana/id.json] [INDEXER=https://…] \
 *   [DAY=20260826] [REASON_CODE=1] \
 *   pnpm exec tsx scripts/manual-settle.ts [--execute]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as m from "@meridian/sdk/meridian";

const EXECUTE = process.argv.includes("--execute");
const INDEXER = process.env.INDEXER ?? "https://indexer-production-86c3.up.railway.app";
const REASON_CODE = Number(process.env.REASON_CODE ?? "1"); // 1 = oracle transport unavailable (65535 is the VOID sentinel)
const UA = { "User-Agent": "Mozilla/5.0" };

const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p.replace(/^~/, os.homedir()), "utf8"))));

/** Round to cents, then scale to the 1e6 fixed point Meridian stores. Both
 *  sources must land on the SAME integer — the on-chain guard is exact
 *  equality, so a half-cent disagreement fails closed rather than settling. */
const to1e6 = (raw: number): bigint => BigInt(Math.round(Number(raw) * 100)) * 10_000n;

interface SourceQuote { close1e6: bigint; raw: string; day: string }

/** Source A — Yahoo Finance daily chart; last bar is the session just closed. */
async function yahoo(sym: string): Promise<SourceQuote> {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`, { headers: UA });
  if (!r.ok) throw new Error(`yahoo ${sym}: HTTP ${r.status}`);
  const res = (await r.json() as any).chart.result[0];
  const i = res.timestamp.length - 1;
  const close = res.indicators.quote[0].close[i];
  if (close == null) throw new Error(`yahoo ${sym}: null close`);
  return { close1e6: to1e6(close), raw: String(close), day: new Date(res.timestamp[i] * 1000).toISOString().slice(0, 10) };
}

/** Source B — CNBC quote service. Independent vendor pipeline from Yahoo's. */
async function cnbc(sym: string): Promise<SourceQuote> {
  const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${sym}`
    + `&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`cnbc ${sym}: HTTP ${r.status}`);
  const q = (await r.json() as any).FormattedQuoteResult.FormattedQuote[0];
  if (q?.last == null) throw new Error(`cnbc ${sym}: no last`);
  return { close1e6: to1e6(q.last), raw: String(q.last), day: String(q.last_time ?? "").slice(0, 10) };
}

const conn = new Connection(process.env.RPC_URL!, "confirmed");
const override = load(process.env.OVERRIDE_KEYPAIR!);
const cranker = load(process.env.CRANKER_KEYPAIR ?? os.homedir() + "/.config/solana/id.json");
/** Submit with backoff. "Blockhash not found" is a routine devnet-RPC blip, and
 *  without a retry it silently strands a record mid-run — which is exactly what
 *  it did on the first execution. Safe to retry: both instructions re-check
 *  on-chain state, so a duplicate is a no-op rather than a double-settle. */
async function send(ixs: any[], signers: Keypair[], attempts = 4): Promise<string> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
    } catch (e) {
      last = e;
      const msg = (e as Error).message ?? "";
      if (!/blockhash not found|block height exceeded|node is behind|timed out/i.test(msg) || i === attempts) throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** (i - 1)));
    }
  }
  throw last as Error;
}

// --- 1. what needs settling -------------------------------------------------
const all: any = await (await fetch(`${INDEXER}/markets`)).json();
const rows: any[] = Array.isArray(all) ? all : all.markets;
const nowSec = Math.floor(Date.now() / 1000);
// Only a day whose close has ALREADY happened can be settled. Defaulting to
// max(trading_day) is a trap: market-open creates the NEXT session the moment
// the current one settles, so the highest trading_day is routinely a session
// that has not closed yet — and pricing it at today's close would be flatly
// wrong. The chain refuses that with SettlementTooEarly, but we must not ask.
const settleable = rows.filter((r) => !r.settled_ts && r.close_ts <= nowSec);
if (!settleable.length) { console.log("no unsettled market whose close_ts has already passed"); process.exit(0); }
const DAY = Number(process.env.DAY ?? Math.max(...settleable.map((r) => r.trading_day)));
const pending = rows.filter((r) => r.trading_day === DAY && !r.settled_ts);
if (!pending.length) { console.log(`nothing pending for trading_day ${DAY}`); process.exit(0); }
// Belt to the default's braces: an explicit DAY= must clear the same bar.
const future = pending.filter((r) => r.close_ts > nowSec);
if (future.length) {
  console.error(`REFUSING trading_day ${DAY}: ${future.length} market(s) close in the FUTURE `
    + `(${new Date(future[0].close_ts * 1000).toISOString()}). A session that has not closed has no Official Close.`);
  process.exit(1);
}

// Quote EVERY ticker in the day, not just the ones still pending. The evidence
// manifest must describe the TRADING DAY, not "whatever was left when this run
// happened" — otherwise a resumed run produces different content, and hence a
// different sha256, from the one earlier records already committed on-chain.
const dayRows = rows.filter((r) => r.trading_day === DAY);
const allTickers = [...new Set(dayRows.map((r) => r.ticker))].sort();
const byTicker = new Map<string, any[]>();
for (const r of pending) byTicker.set(r.ticker, [...(byTicker.get(r.ticker) ?? []), r]);
const closeTs = pending[0].close_ts;

console.log(`trading_day ${DAY} · ${pending.length} unsettled markets across ${byTicker.size} tickers`);
console.log(`close_ts ${closeTs} (${new Date(closeTs * 1000).toISOString()})`);
console.log(EXECUTE ? "MODE: EXECUTE — will write on-chain\n" : "MODE: dry run — nothing will be written (pass --execute)\n");

// --- 2. corroborate a close from two independent sources ---------------------
const closes: Record<string, any> = {};
const agreed: { ticker: string; record: string; close1e6: bigint; markets: any[] }[] = [];
console.log("ticker   yahoo        cnbc         1e6            agree");
for (const ticker of allTickers) {
  const markets = byTicker.get(ticker) ?? [];           // [] => nothing left to settle for it
  const record = (markets[0] ?? dayRows.find((r) => r.ticker === ticker)).settlement_record;
  try {
    const [a, b] = await Promise.all([yahoo(ticker), cnbc(ticker)]);
    const ok = a.close1e6 === b.close1e6 && a.close1e6 > 0n;
    const note = markets.length === 0 ? "(already settled)" : ok ? "yes" : "** NO — SKIPPED **";
    console.log(`${ticker.padEnd(8)} ${a.raw.padEnd(12)} ${b.raw.padEnd(12)} ${String(a.close1e6).padEnd(14)} ${note}`);
    closes[ticker] = {
      record, markets_settled_by_this_path: markets.length,
      source_a_raw: a.raw, source_b_raw: b.raw,
      source_a_1e6: Number(a.close1e6), source_b_1e6: Number(b.close1e6),
      source_a_day: a.day, source_b_day: b.day, agreed: ok,
    };
    if (ok && markets.length) agreed.push({ ticker, record, close1e6: a.close1e6, markets });
  } catch (e) {
    console.log(`${ticker.padEnd(8)} ERROR ${(e as Error).message.slice(0, 60)} — SKIPPED`);
    closes[ticker] = { record, error: (e as Error).message, agreed: false };
  }
}
const skipped = byTicker.size - agreed.length;
console.log(`\n${agreed.length}/${byTicker.size} tickers corroborated${skipped ? `; ${skipped} SKIPPED (left Pending on purpose — fail closed)` : ""}`);
if (!agreed.length) { console.log("nothing to do"); process.exit(1); }

// --- 3. evidence manifest (hashed on-chain) ---------------------------------
const evidence = {
  kind: "MANUAL_CLOSE",
  cluster: "devnet",
  program: m.MERIDIAN_PID.toBase58(),
  trading_day_label: DAY,
  close_ts: closeTs,
  reason_code: REASON_CODE,
  rationale:
    "The Settlement Records for this trading day pin the Pyth adapter as their immutable oracle transport. "
    + "On 2026-08-26 16:00 UTC Pyth made Hermes authentication mandatory and placed US equity spot feeds behind a "
    + "paid Pro entitlement, so the pinned feed returns 403 Not entitled and finalize_settlement_normal can never "
    + "satisfy the Settlement Quality Predicate for these records. The Official Close below is therefore attested by "
    + "the Override Authority from TWO independent public sources that agreed to the cent. These are REAL corroborated "
    + "closing prices, not sentinels — but they carry operator attestation, NOT a Pyth publisher signature, and must "
    + "be read that way.",
  signed_by_role: "override_authority",
  override_authority: override.publicKey.toBase58(),
  sources: {
    a: "Yahoo Finance v8 chart API (daily bar, last close)",
    b: "CNBC quote-html-webservice restQuote (last)",
  },
  // NO wall-clock timestamp here, deliberately. The sha256 of this file is
  // committed on-chain by finalize_settlement_manual, so the content must be a
  // pure function of (trading day, tickers, corroborated prices). A `captured_at`
  // made every re-run produce a different hash, which stranded the records
  // finalized in an earlier run pointing at a manifest that no longer existed.
  closes,
};
const outDir = "docs/settlement-evidence";
fs.mkdirSync(outDir, { recursive: true });
const evidencePath = path.join(outDir, `${String(DAY).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")}-manual-close.json`);
const body = JSON.stringify(evidence, null, 2) + "\n";
// Never clobber a manifest whose hash may already be committed on-chain. With
// the timestamp gone a re-run is normally byte-identical; if it is NOT, the
// prices themselves changed, and silently overwriting would strand every record
// that already referenced the old content.
if (fs.existsSync(evidencePath) && fs.readFileSync(evidencePath, "utf8") !== body) {
  const alt = evidencePath.replace(/\.json$/, `.regenerated.json`);
  fs.writeFileSync(alt, body);
  console.error(`REFUSING to overwrite ${evidencePath} — its content differs from this run.`);
  console.error(`Wrote ${alt} instead. Records already finalized reference the ORIGINAL file's sha256;`);
  console.error(`reconcile the two before settling anything further for this day.`);
  process.exit(1);
}
fs.writeFileSync(evidencePath, body);
const manifestSha256 = createHash("sha256").update(fs.readFileSync(evidencePath)).digest();
console.log(`evidence ${evidencePath}\nsha256   ${manifestSha256.toString("hex")}`);

if (!EXECUTE) {
  console.log("\nDry run complete. Review the evidence file, then re-run with --execute.");
  process.exit(0);
}

// --- 4. finalize each record, then settle every market bound to it ----------
/** SettlementRecord.state: borsh 8-byte discriminator, then `state` (0 == Pending). */
const recState = async (rec: string) => (await conn.getAccountInfo(new PublicKey(rec)))!.data[8];
let finalized = 0, settled = 0, failed = 0;
for (const { ticker, record, close1e6, markets } of agreed) {
  try {
    if (await recState(record) !== 0) console.log(`${ticker}: record already finalized, skipping finalize`);
    else {
      const sig = await send([m.finalizeSettlementManualIx({
        overrideAuthority: override.publicKey, record: new PublicKey(record),
        sourceA1e6: close1e6, sourceB1e6: close1e6, reasonCode: REASON_CODE, manifestSha256,
      })], [override]);
      finalized++;
      console.log(`${ticker}: finalize_manual @ $${(Number(close1e6) / 1e6).toFixed(2)} -> state ${await recState(record)} ${sig}`);
    }
  } catch (e) { failed++; console.error(`${ticker}: finalize FAILED — ${(e as Error).message.slice(0, 160)}`); continue; }

  let ok = 0;
  for (const mk of markets) {
    try {
      await send([m.settleMarketIx({ cranker: cranker.publicKey, market: new PublicKey(mk.pubkey), record: new PublicKey(record) })], [cranker]);
      settled++; ok++;
    } catch (e) { failed++; console.error(`  settle ${mk.pubkey} FAILED — ${(e as Error).message.slice(0, 120)}`); }
  }
  // Report what actually landed, not what was attempted.
  console.log(`${ticker}: settled ${ok}/${markets.length} markets`);
}
console.log(`\ndone — ${finalized} records finalized, ${settled} markets settled, ${failed} failures`);
if (skipped) console.log(`${skipped} ticker(s) left Pending because their sources disagreed — re-run once they agree.`);
process.exit(failed ? 1 : 0);
