/**
 * Market-open (ADR-0032 / PRD §5–6): the generate→create→attach slot the
 * scheduler fires at resolution+5m for each settled ticker.
 *
 *   prior   = the just-finalized Official Close of (ticker, settled day)
 *   ladder  = prior ±3/6/9 %, snapped to the on-chain $10 grid, deduped
 *   session = mint now, trade +30m (ADR-0033), close 16:00 ET (13:00 ET early
 *             close) of the NEXT NYSE Trading Day
 *   create  = create_outcome_market → OpenBook book accounts → create_venue_market
 *             → publish_metadata, per strike, idempotent (a strike whose market
 *             already has a venue is skipped; one without a venue is completed)
 *
 * Refuses to run off a sentinel/void close (< $1) — a manual settlement that
 * voided the day is not a price to ladder from.
 */
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as m from "@meridian/sdk/meridian";
import * as ob from "@meridian/sdk/openbook";
import { decodeOutcomeMarket, TICKER } from "../../indexer/src/layout.js";
import { isEarlyClose, type NyseCalendar } from "./calendar.js";

export const STRIKE_BANDS_PCT = [-9, -6, -3, 3, 6, 9];
/** prior ±bands, snapped to $10, deduped, ascending. Cheap names collapse bands. */
export const strikesFor = (prior: number): number[] =>
  [...new Set(STRIKE_BANDS_PCT.map((b) => Math.round((prior * (1 + b / 100)) / 10) * 10))].filter((s) => s > 0).sort((a, b) => a - b);

// Strict-build floors (constants.rs); env may raise, never lower.
export const NORMAL_DELAY_FLOOR = 1200;
export const OVERRIDE_DELAY_FLOOR = 3600;
export const MINT_TO_TRADE_SECS = 1800;
export const MIN_ADD_STRIKE_LEAD_SECS = 1800;
/** Below this the "close" is a void sentinel, not a price. */
export const MIN_REAL_CLOSE_1E6 = 1_000_000n;
const SYS = PublicKey.default.toBase58();

// SettlementRecord (borsh, no padding): 8 disc, state@8, bump@9, schema@10,
// ticker@11, day u32@12, close_ts i64@16, prior u64@24, version u32@32,
// 5×32 pubkeys/hashes + u64 slot (36..236), provider u16@236, method u16@238,
// normal_delay u32@240, min_samples u8@244, max_stale u64@245, spread u16@253,
// band u16@255, override_delay u32@257, official_close u64@261, halt@269, is_final@270.
export const RECORD = { STATE: 8, CLOSE_TS: 16, OFFICIAL_CLOSE: 261, IS_FINAL: 270 } as const;
export function decodeRecordForOpen(data: Buffer): { state: number; closeTs: bigint; officialClose1e6: bigint; isFinal: boolean } {
  return {
    state: data[RECORD.STATE],
    closeTs: data.readBigInt64LE(RECORD.CLOSE_TS),
    officialClose1e6: data.readBigUInt64LE(RECORD.OFFICIAL_CLOSE),
    isFinal: data[RECORD.IS_FINAL] === 1,
  };
}

/** Unix ts of the regular (or early) close of NYSE Trading Day `day` in America/New_York. */
export function sessionCloseTs(day: number, cal: NyseCalendar): number {
  const y = Math.floor(day / 10000), mo = Math.floor((day % 10000) / 100), d = day % 100;
  const hour = isEarlyClose(day, cal) ? 13 : 16;
  // Find the UTC instant whose New York wall-clock is (day, hour:00): start from
  // the UTC guess and correct by the zone offset observed at that instant.
  const guess = Date.UTC(y, mo - 1, d, hour, 0, 0);
  const offsetMin = (t: number): number => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(t));
    const g = (k: string) => Number(parts.find((p) => p.type === k)!.value);
    const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
    return (asUtc - t) / 60000;
  };
  const t = guess - offsetMin(guess) * 60000;
  return Math.floor(t / 1000);
}

export interface OpenPlan {
  tickerId: number; name: string; day: number; prior: number; strikes: number[];
  mintOpenTs: bigint; tradeOpenTs: bigint; closeTs: bigint;
}
export function planOpen(opts: { tickerId: number; targetDay: number; officialClose1e6: bigint; nowSec: number; cal: NyseCalendar }): OpenPlan {
  if (opts.officialClose1e6 < MIN_REAL_CLOSE_1E6) throw new Error(`official close ${opts.officialClose1e6} is a void sentinel, not a price`);
  const prior = Number(opts.officialClose1e6) / 1e6;
  const tradeOpenTs = BigInt(opts.nowSec - 30);
  const closeTs = BigInt(sessionCloseTs(opts.targetDay, opts.cal));
  if (Number(closeTs) - opts.nowSec < MIN_ADD_STRIKE_LEAD_SECS) throw new Error(`target day ${opts.targetDay} closes at ${closeTs}, inside the ${MIN_ADD_STRIKE_LEAD_SECS}s lead`);
  return {
    tickerId: opts.tickerId, name: TICKER[opts.tickerId] ?? `T${opts.tickerId}`, day: opts.targetDay, prior,
    strikes: strikesFor(prior), mintOpenTs: tradeOpenTs - BigInt(MINT_TO_TRADE_SECS), tradeOpenTs, closeTs,
  };
}

export interface CreateOpts {
  conn: Connection; operator: Keypair; quoteMint: PublicKey; plan: OpenPlan;
  send: (ixs: TransactionInstruction[], extraSigners?: Keypair[]) => Promise<string>;
  normalDelaySecs?: number; overrideDelaySecs?: number; metadataUri?: string; versionId?: number;
  log?: (s: string) => void; dryRun?: boolean;
}
/** ~lamports one strike costs the operator (venue books/heap rent + market/mint accounts). */
export const LAMPORTS_PER_STRIKE = 2_050_000_000;

export async function createMarketsForPlan(o: CreateOpts): Promise<{ created: number; skipped: number }> {
  const { conn, operator, quoteMint, plan } = o;
  const log = o.log ?? (() => {});
  const normal = Math.max(NORMAL_DELAY_FLOOR, o.normalDelaySecs ?? NORMAL_DELAY_FLOOR);
  const override = Math.max(OVERRIDE_DELAY_FLOOR, o.overrideDelaySecs ?? OVERRIDE_DELAY_FLOOR);
  const versionId = o.versionId ?? 1;
  const uriTpl = o.metadataUri ?? "https://meridian.markets";
  let created = 0, skipped = 0;

  // The shared SettlementRecord fixes close_ts for the whole (ticker, day): if it
  // already exists it must not be finalized, and remaining strikes must reuse its close.
  let closeTs = plan.closeTs;
  const rec = await conn.getAccountInfo(m.settlementRecordPda(plan.tickerId, plan.day));
  if (rec) {
    const r = decodeRecordForOpen(rec.data);
    if (r.state !== 0) throw new Error(`record for ${plan.name} day ${plan.day} is already finalized (state ${r.state}) — cannot open markets on it`);
    if (r.closeTs !== closeTs) { log(`${plan.name} day ${plan.day}: reusing existing record close_ts ${r.closeTs}`); closeTs = r.closeTs; }
  }
  if (!(await conn.getAccountInfo(m.feedVersionPda(plan.tickerId, versionId)))) throw new Error(`no transport (FeedVersion v${versionId}) registered for ticker ${plan.tickerId}`);

  const bal = await conn.getBalance(operator.publicKey);
  const need = plan.strikes.length * LAMPORTS_PER_STRIKE;
  if (bal < need) throw new Error(`operator ${operator.publicKey.toBase58()} has ${(bal / 1e9).toFixed(2)} SOL, needs ~${(need / 1e9).toFixed(1)} for ${plan.strikes.length} strikes`);

  for (const s of plan.strikes) {
    const strike = BigInt(s) * 1_000_000n;
    const market = m.outcomeMarketPda(plan.tickerId, plan.day, strike);
    const mInfo = await conn.getAccountInfo(market);
    if (mInfo && decodeOutcomeMarket(market.toBase58(), mInfo.data).openbookMarket !== SYS) { skipped++; continue; }
    if (o.dryRun) { log(`DRY RUN would create ${plan.name}-${s} (day ${plan.day}, close ${closeTs})`); created++; continue; }
    if (!mInfo) {
      await o.send([m.createOutcomeMarketIx({
        operator: operator.publicKey, quoteMint, tickerId: plan.tickerId, tradingDay: plan.day, strike,
        versionId, priorClose: BigInt(Math.round(plan.prior * 1e6)), mintOpenTs: plan.mintOpenTs, tradeOpenTs: plan.tradeOpenTs, closeTs,
        metadataManifest: Buffer.alloc(32, 7), normalDelaySecs: normal, overrideDelaySecs: override,
      })]);
    } else {
      log(`${plan.name}-${s}: market exists without a venue — attaching venue`);
    }
    const yesMint = m.yesMintPda(market);
    const obMarket = Keypair.generate(), bids = Keypair.generate(), asks = Keypair.generate(), heap = Keypair.generate();
    const bookRent = await conn.getMinimumBalanceForRentExemption(ob.BOOKSIDE_SPACE);
    const heapRent = await conn.getMinimumBalanceForRentExemption(ob.EVENT_HEAP_SPACE);
    await o.send([
      ob.bookAccountIx(operator.publicKey, bids, ob.BOOKSIDE_SPACE, bookRent),
      ob.bookAccountIx(operator.publicKey, asks, ob.BOOKSIDE_SPACE, bookRent),
      ob.bookAccountIx(operator.publicKey, heap, ob.EVENT_HEAP_SPACE, heapRent),
    ], [bids, asks, heap]);
    await o.send([m.createVenueMarketIx({
      operator: operator.publicKey, market, obMarket: obMarket.publicKey,
      bids: bids.publicKey, asks: asks.publicKey, eventHeap: heap.publicKey,
      yesMint, quoteMint, name: `${plan.name}-${s}`, timeExpiry: 0n,
    })], [obMarket]);
    try {
      await o.send([m.publishMetadataIx({
        operator: operator.publicKey, market, yesMint, noMint: m.noMintPda(market),
        yesName: `${plan.name} $${s} YES`, yesSymbol: "mYES", noName: `${plan.name} $${s} NO`, noSymbol: "mNO",
        uri: uriTpl.replace("{ticker}", plan.name).replace("{strike}", String(s)),
      })]);
    } catch (e) { log(`metadata ${plan.name}-${s}: ${(e as Error).message.slice(0, 120)}`); }
    created++;
    log(`created ${plan.name}-${s} (day ${plan.day})`);
  }
  return { created, skipped };
}
