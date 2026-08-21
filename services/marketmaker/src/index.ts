/**
 * Meridian demo market-maker — seeds and maintains two-sided liquidity on every
 * Active venue so the order books, marks and implied probabilities are live (and
 * so the keeper's consume_events path has real fills to drain).
 *
 * It mints Yes/No pairs for inventory and rests PostOnly Yes bids/asks around a
 * fair value derived from a mock spot (same base map the keeper uses). Funds a
 * fresh wallet each run (validator is --reset). Builders come from the shared @meridian/sdk workspace package. This is demo
 * liquidity, not a real strategy.
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
} from "@solana/spl-token";
import fs from "node:fs";
import * as m from "@meridian/sdk/meridian";
import * as ob from "@meridian/sdk/openbook";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const INDEXER = process.env.MM_INDEXER ?? "http://127.0.0.1:8787";
const CONFIG = process.env.DEMO_CONFIG ?? ".demo-config.json";
const STATUS = process.env.MM_STATUS ?? ".mm-status.json";
const TICK = Number(process.env.MM_TICK ?? "8") * 1000;

const conn = new Connection(RPC, "confirmed");
const LOT = 1_000_000n;                    // 1 share
const BANDS = [1, 2, 3, 5, 7, 10, 14, 18];  // cents from fair — wider spacing further out
const SPOT_BASE: Record<string, number> = { AAPL: 231, AMZN: 241, GOOGL: 204, META: 682, MSFT: 512, NVDA: 178, TSLA: 349 };

// Deterministic per-market ladder of {distance-from-fair, size}. Size tapers
// from ~heavy near the touch to lighter in the tail, with organic variation.
function ladder(pubkey: string): { d: number; size: bigint }[] {
  let seed = [...pubkey].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  return BANDS.map((d, i) => {
    const base = 80 - i * 8;               // ~80 near mid → ~24 in the tail
    return { d, size: BigInt(Math.max(12, Math.round(base * (0.6 + rnd() * 0.8)))) };
  });
}

let coid = 1;
const nextCoid = () => BigInt(coid++);
const clampCents = (c: number) => Math.max(1, Math.min(99, Math.round(c)));
function fairCents(ticker: string, strikeUsd: number): number {
  const spot = SPOT_BASE[ticker] ?? strikeUsd;
  const prob = 0.5 + ((spot - strikeUsd) / strikeUsd) * 6;
  return clampCents(Math.max(0.10, Math.min(0.90, prob)) * 100);
}
const send = (ixs: TransactionInstruction[], signers: Keypair[]) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
const getJson = async (p: string) => { const r = await fetch(`${INDEXER}${p}`); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };

interface Mkt {
  pubkey: string; ticker: string; ticker_id: number; strike_1e6: string; state_name: string; close_ts: number;
  yes_mint: string; no_mint: string; collateral_vault: string; openbook_market: string;
  bids: string; asks: string; event_heap: string; openbook_base_vault: string; openbook_quote_vault: string;
}

function bidIx(mm: PublicKey, oo: PublicKey, usdc: PublicKey, k: Mkt, priceCents: number, size: bigint): TransactionInstruction {
  return m.placeLimitOrderIx({
    user: mm, market: new PublicKey(k.pubkey), ooAccount: oo, userTokenAccount: usdc,
    obMarket: new PublicKey(k.openbook_market), bids: new PublicKey(k.bids), asks: new PublicKey(k.asks),
    eventHeap: new PublicKey(k.event_heap), marketVault: new PublicKey(k.openbook_quote_vault),
    args: { side: ob.Side.Bid, priceLots: BigInt(priceCents), maxBaseLots: size, maxQuoteLotsIncludingFees: BigInt(priceCents) * size,
      clientOrderId: nextCoid(), orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n, selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
  });
}
function askIx(mm: PublicKey, oo: PublicKey, yes: PublicKey, k: Mkt, priceCents: number, size: bigint): TransactionInstruction {
  return m.placeLimitOrderIx({
    user: mm, market: new PublicKey(k.pubkey), ooAccount: oo, userTokenAccount: yes,
    obMarket: new PublicKey(k.openbook_market), bids: new PublicKey(k.bids), asks: new PublicKey(k.asks),
    eventHeap: new PublicKey(k.event_heap), marketVault: new PublicKey(k.openbook_base_vault),
    args: { side: ob.Side.Ask, priceLots: BigInt(priceCents), maxBaseLots: size, maxQuoteLotsIncludingFees: 1_000_000_000n,
      clientOrderId: nextCoid(), orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n, selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
  });
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  const gov = Keypair.fromSecretKey(Uint8Array.from(cfg.governance)); // quote-mint authority
  const quoteMint = new PublicKey(cfg.quoteMint);
  const mm = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(mm.publicKey, 200e9), "confirmed");
  const usdc = getAssociatedTokenAddressSync(quoteMint, mm.publicKey);
  await send([
    createAssociatedTokenAccountIdempotentInstruction(mm.publicKey, usdc, mm.publicKey, quoteMint),
    createMintToInstruction(quoteMint, usdc, gov.publicKey, 5_000_000_000_000n), // 5,000,000 test USD
  ], [mm, gov]);
  await send([ob.createOoIndexerIx(mm.publicKey, mm.publicKey)], [mm]);
  console.log(`[mm] wallet ${mm.publicKey.toBase58()} · indexer ${INDEXER} · tick ${TICK / 1000}s`);

  const ooIndex = new Map<string, number>(); // market pubkey -> OO account index
  let nextIndex = 1;
  let ordersPosted = 0;

  const quoteMarket = async (k: Mkt, seed: boolean) => {
    const yesMint = new PublicKey(k.yes_mint), noMint = new PublicKey(k.no_mint);
    const yesAta = getAssociatedTokenAddressSync(yesMint, mm.publicKey);
    const noAta = getAssociatedTokenAddressSync(noMint, mm.publicKey);
    if (!ooIndex.has(k.pubkey)) {
      const idx = nextIndex++;
      await send([ob.createOoAccountIx(mm.publicKey, mm.publicKey, idx, new PublicKey(k.openbook_market))], [mm]);
      ooIndex.set(k.pubkey, idx);
    }
    const oo = ob.ooAccountPda(mm.publicKey, ooIndex.get(k.pubkey)!);
    const fair = fairCents(k.ticker, Number(k.strike_1e6) / 1e6);
    const book = seed ? { bids: [], asks: [] } : await getJson(`/book/${k.pubkey}`).catch(() => ({ bids: [], asks: [] }));
    const needBids = seed || (book.bids ?? []).length === 0;
    const needAsks = seed || (book.asks ?? []).length === 0;
    if (!needBids && !needAsks) return 0;

    const lad = ladder(k.pubkey);
    // create the Yes/No ATAs AND mint the ask-backing inventory in ONE tx — a
    // separate ATA tx races the mint's simulation at "confirmed" and fails.
    if (needAsks) await send([
      createAssociatedTokenAccountIdempotentInstruction(mm.publicKey, yesAta, mm.publicKey, yesMint),
      createAssociatedTokenAccountIdempotentInstruction(mm.publicKey, noAta, mm.publicKey, noMint),
      m.mintPairIx(mm.publicKey, new PublicKey(k.pubkey), lad.reduce((a, l) => a + l.size, 0n) * LOT, {
        yesMint, noMint, collateralVault: new PublicKey(k.collateral_vault), userQuote: usdc, userYes: yesAta, userNo: noAta,
      }),
    ], [mm]);

    // build the deduped ladder as instructions, then post in batches for speed
    const build = (sign: 1 | -1, ixOf: (p: number, s: bigint) => TransactionInstruction) => {
      const used = new Set<number>(); const out: TransactionInstruction[] = [];
      for (const { d, size } of lad) { const p = clampCents(fair + sign * d); if (used.has(p)) continue; used.add(p); out.push(ixOf(p, size)); }
      return out;
    };
    const orders = [
      ...(needBids ? build(-1, (p, s) => bidIx(mm.publicKey, oo, usdc, k, p, s)) : []),
      ...(needAsks ? build(1, (p, s) => askIx(mm.publicKey, oo, yesAta, k, p, s)) : []),
    ];
    const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
    let posted = 0;
    for (let i = 0; i < orders.length; i += 4) {
      const batch = orders.slice(i, i + 4);
      try { await send([cu, ...batch], [mm]); posted += batch.length; }
      catch (e) { if (seed) console.error(`[mm] ${k.ticker} order batch:`, (e as Error).message.slice(0, 120)); }
    }
    ordersPosted += posted;
    return posted;
  };

  const writeStatus = (quoted: number, extra: any = {}) => {
    try {
      fs.writeFileSync(STATUS, JSON.stringify({ running: true, ts: Math.floor(Date.now() / 1000), wallet: mm.publicKey.toBase58(),
        markets_quoted: quoted, orders_posted: ordersPosted, ...extra }));
    } catch {}
  };

  const activeMarkets = async (): Promise<Mkt[]> => {
    const now = Math.floor(Date.now() / 1000);
    return ((await getJson("/markets")).markets as Mkt[]).filter((k) => k.state_name === "Active" && now < k.close_ts
      && k.openbook_market && k.openbook_market !== "11111111111111111111111111111111");
  };

  // initial seed. OpenOrders accounts must be created in order (the OO indexer's
  // created_counter is sequential), so create them all first, then mint+quote
  // several markets concurrently for speed.
  const markets = await activeMarkets();
  for (const k of markets) {
    if (ooIndex.has(k.pubkey)) continue;
    const idx = nextIndex++;
    try { await send([ob.createOoAccountIx(mm.publicKey, mm.publicKey, idx, new PublicKey(k.openbook_market))], [mm]); ooIndex.set(k.pubkey, idx); }
    catch (e) { console.error(`[mm] oo ${k.ticker} failed:`, (e as Error).message.slice(0, 100)); }
  }
  let seeded = 0;
  const CONC = 4;
  const ready = markets.filter((k) => ooIndex.has(k.pubkey));
  for (let i = 0; i < ready.length; i += CONC) {
    await Promise.all(ready.slice(i, i + CONC).map(async (k) => {
      try { await quoteMarket(k, true); seeded++; console.log(`[mm] seeded ${k.ticker} $${Number(k.strike_1e6) / 1e6}`); }
      catch (e) { console.error(`[mm] seed ${k.ticker} failed:`, (e as Error).message.slice(0, 100)); }
    }));
    writeStatus(seeded);
  }
  console.log(`[mm] seeded ${seeded} markets · ${ordersPosted} orders`);

  // top-up loop: re-quote any side that has emptied out (fills)
  const loop = async () => {
    let quoted = 0;
    for (const k of await activeMarkets()) {
      if (!ooIndex.has(k.pubkey)) { try { await quoteMarket(k, true); } catch {} quoted++; continue; }
      try { if (await quoteMarket(k, false) > 0) console.log(`[mm] topped up ${k.ticker} $${Number(k.strike_1e6) / 1e6}`); quoted++; } catch {}
    }
    writeStatus(quoted);
  };
  setInterval(loop, TICK);
}
main().catch((e) => { console.error("[mm] fatal:", e); process.exit(1); });
