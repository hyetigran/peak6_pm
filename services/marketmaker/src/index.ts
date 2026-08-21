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
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction,
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
const LEVELS = [2, 4, 6];                   // cents around fair
const SIZE = 25n;                            // base lots (shares) per level
const INVENTORY = 150n;                      // pairs minted per market for ask inventory
const SPOT_BASE: Record<string, number> = { AAPL: 231, AMZN: 241, GOOGL: 204, META: 682, MSFT: 512, NVDA: 178, TSLA: 349 };

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

function bidIx(mm: PublicKey, oo: PublicKey, usdc: PublicKey, k: Mkt, priceCents: number): TransactionInstruction {
  return m.placeLimitOrderIx({
    user: mm, market: new PublicKey(k.pubkey), ooAccount: oo, userTokenAccount: usdc,
    obMarket: new PublicKey(k.openbook_market), bids: new PublicKey(k.bids), asks: new PublicKey(k.asks),
    eventHeap: new PublicKey(k.event_heap), marketVault: new PublicKey(k.openbook_quote_vault),
    args: { side: ob.Side.Bid, priceLots: BigInt(priceCents), maxBaseLots: SIZE, maxQuoteLotsIncludingFees: BigInt(priceCents) * SIZE,
      clientOrderId: nextCoid(), orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n, selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
  });
}
function askIx(mm: PublicKey, oo: PublicKey, yes: PublicKey, k: Mkt, priceCents: number): TransactionInstruction {
  return m.placeLimitOrderIx({
    user: mm, market: new PublicKey(k.pubkey), ooAccount: oo, userTokenAccount: yes,
    obMarket: new PublicKey(k.openbook_market), bids: new PublicKey(k.bids), asks: new PublicKey(k.asks),
    eventHeap: new PublicKey(k.event_heap), marketVault: new PublicKey(k.openbook_base_vault),
    args: { side: ob.Side.Ask, priceLots: BigInt(priceCents), maxBaseLots: SIZE, maxQuoteLotsIncludingFees: 1_000_000_000n,
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
      await send([
        createAssociatedTokenAccountIdempotentInstruction(mm.publicKey, yesAta, mm.publicKey, yesMint),
        createAssociatedTokenAccountIdempotentInstruction(mm.publicKey, noAta, mm.publicKey, noMint),
      ], [mm]);
    }
    const oo = ob.ooAccountPda(mm.publicKey, ooIndex.get(k.pubkey)!);
    const fair = fairCents(k.ticker, Number(k.strike_1e6) / 1e6);
    const book = seed ? { bids: [], asks: [] } : await getJson(`/book/${k.pubkey}`).catch(() => ({ bids: [], asks: [] }));
    const needBids = seed || (book.bids ?? []).length === 0;
    const needAsks = seed || (book.asks ?? []).length === 0;
    if (!needBids && !needAsks) return 0;

    // mint Yes inventory only when we're about to (re)post asks
    if (needAsks) await send([m.mintPairIx(mm.publicKey, new PublicKey(k.pubkey), INVENTORY * LOT, {
      yesMint, noMint, collateralVault: new PublicKey(k.collateral_vault), userQuote: usdc, userYes: yesAta, userNo: noAta,
    })], [mm]);

    let posted = 0;
    if (needBids) {
      for (const d of LEVELS) { try { await send([bidIx(mm.publicKey, oo, usdc, k, clampCents(fair - d))], [mm]); posted++; } catch (e) { if (seed) console.error(`[mm] bid ${k.ticker} ${clampCents(fair - d)}¢:`, (e as Error).message.slice(0, 180)); } }
    }
    if (needAsks) {
      for (const d of LEVELS) { try { await send([askIx(mm.publicKey, oo, yesAta, k, clampCents(fair + d))], [mm]); posted++; } catch (e) { if (seed) console.error(`[mm] ask ${k.ticker} ${clampCents(fair + d)}¢:`, (e as Error).message.slice(0, 180)); } }
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

  // initial seed
  let seeded = 0;
  for (const k of await activeMarkets()) {
    try { await quoteMarket(k, true); seeded++; console.log(`[mm] seeded ${k.ticker} $${Number(k.strike_1e6) / 1e6} @ fair ${fairCents(k.ticker, Number(k.strike_1e6) / 1e6)}¢`); }
    catch (e) { console.error(`[mm] seed ${k.ticker} failed:`, (e as Error).message.slice(0, 100)); }
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
