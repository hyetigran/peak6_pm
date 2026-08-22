/**
 * Devnet market-maker — seeds a few dollars of two-sided liquidity per Active
 * market and RECYCLES the capital when markets settle.
 *
 * Unlike the localnet demo MM (which airdrops SOL and self-mints test USDC),
 * this uses a dedicated, externally-funded wallet (MM_KEYPAIR) holding real
 * devnet USDC. It never mints the quote token.
 *
 * Capital cycle per market:
 *   seed (Active): mint K Yes/No pairs (K USDC collateral -> K Yes + K No; Yes is
 *     ask inventory), rest a few Yes bids below fair (funded by USDC) and Yes
 *     asks above fair (funded by the Yes inventory).
 *   recycle (Settled / past close): cancel_all the resting orders, settle_funds
 *     to pull freed balances back to the wallet, then redeem_pair_direct the
 *     still-matched Yes+No inventory back to USDC. Freed USDC seeds the next
 *     session's newly-created markets. (Net directional fills settle via
 *     redeem_winning — minimal on a quiet devnet; logged, not auto-redeemed.)
 *
 * State (which markets are seeded, their OpenOrders index) persists in MM_STATE
 * so a restart resumes rather than double-seeding — the wallet is long-lived on
 * devnet.
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, getAccount } from "@solana/spl-token";
import fs from "node:fs";
import * as m from "@meridian/sdk/meridian";
import * as ob from "@meridian/sdk/openbook";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const INDEXER = process.env.MM_INDEXER ?? "http://127.0.0.1:8788";
const KEYPAIR = process.env.MM_KEYPAIR ?? "mm-devnet.json";
const STATE = process.env.MM_STATE ?? ".mm-devnet-state.json";
const QUOTE_MINT = new PublicKey(process.env.QUOTE_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // Circle devnet USDC
const TICK = Number(process.env.MM_TICK ?? "30") * 1000;

// Sizing — deliberately small ("a few dollars"). Levels per side at fair ± step.
const SHARES = BigInt(process.env.MM_SHARES ?? "1");   // shares per price level
const LEVELS = Number(process.env.MM_LEVELS ?? "2");    // price points per side
const STEP = Number(process.env.MM_STEP ?? "6");        // cents between levels
const LOT = 1_000_000n;                                 // 1 share = 1e6 atoms
const SPOT_BASE: Record<string, number> = { AAPL: 231, AMZN: 241, GOOGL: 204, META: 682, MSFT: 512, NVDA: 178, TSLA: 349 };

const conn = new Connection(RPC, "confirmed");
const clampCents = (c: number) => Math.max(1, Math.min(99, Math.round(c)));
function fairCents(ticker: string, strikeUsd: number): number {
  const spot = SPOT_BASE[ticker] ?? strikeUsd;
  const prob = 0.5 + ((spot - strikeUsd) / strikeUsd) * 6;
  return clampCents(Math.max(0.1, Math.min(0.9, prob)) * 100);
}
let coid = Date.now() % 1_000_000;
const nextCoid = () => BigInt(coid++);

const getJson = async (p: string) => { const r = await fetch(`${INDEXER}${p}`); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };

interface Mkt {
  pubkey: string; ticker: string; ticker_id: number; strike_1e6: string; state_name: string; close_ts: number;
  yes_mint: string; no_mint: string; collateral_vault: string; openbook_market: string;
  bids: string; asks: string; event_heap: string; openbook_base_vault: string; openbook_quote_vault: string;
}
interface State { nextOoIndex: number; markets: Record<string, { ooIndex: number; seeded: boolean; recycled: boolean }>; }
const loadState = (): State => {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { /* no persisted state yet */ }
  if (process.env.MM_STATE_JSON) { try { return JSON.parse(process.env.MM_STATE_JSON); } catch { /* fall through */ } }
  return { nextOoIndex: 1, markets: {} };
};
const saveState = (s: State) => { try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch {} };

async function main() {
  // Keypair from MM_KEYPAIR_JSON (a cloud secret) in preference to the file, so
  // no key ships in the image.
  const mmSecret = process.env.MM_KEYPAIR_JSON ? JSON.parse(process.env.MM_KEYPAIR_JSON) : JSON.parse(fs.readFileSync(KEYPAIR, "utf8"));
  const mm = Keypair.fromSecretKey(Uint8Array.from(mmSecret));
  const usdc = getAssociatedTokenAddressSync(QUOTE_MINT, mm.publicKey);
  const state = loadState();
  const send = (ixs: TransactionInstruction[]) =>
    sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs), [mm], { commitment: "confirmed" });
  const bal = async (ata: PublicKey): Promise<bigint> => { try { return (await getAccount(conn, ata)).amount; } catch { return 0n; } };

  const sol = await conn.getBalance(mm.publicKey);
  const usdcBal = await bal(usdc);
  console.log(`[mm] wallet ${mm.publicKey.toBase58()} · ${(sol / 1e9).toFixed(3)} SOL · ${(Number(usdcBal) / 1e6).toFixed(2)} USDC · indexer ${INDEXER}`);
  if (sol < 0.2e9) console.warn("[mm] low SOL — fund the wallet for tx fees + rent");
  if (usdcBal === 0n) console.warn("[mm] no USDC — fund the wallet with devnet USDC to seed liquidity");

  // Ensure the OpenOrders indexer exists (once per wallet).
  if (!(await conn.getAccountInfo(ob.ooIndexerPda(mm.publicKey)))) {
    await send([ob.createOoIndexerIx(mm.publicKey, mm.publicKey)]);
    console.log("[mm] created OpenOrders indexer");
  }

  const seed = async (k: Mkt) => {
    const st = state.markets[k.pubkey] ?? { ooIndex: state.nextOoIndex++, seeded: false, recycled: false };
    state.markets[k.pubkey] = st;
    const yesMint = new PublicKey(k.yes_mint), noMint = new PublicKey(k.no_mint);
    const yesAta = getAssociatedTokenAddressSync(yesMint, mm.publicKey), noAta = getAssociatedTokenAddressSync(noMint, mm.publicKey);
    const oo = ob.ooAccountPda(mm.publicKey, st.ooIndex);
    if (!(await conn.getAccountInfo(oo))) await send([ob.createOoAccountIx(mm.publicKey, mm.publicKey, st.ooIndex, new PublicKey(k.openbook_market))]);
    saveState(state);

    // Mint the ask-backing Yes inventory (LEVELS*SHARES pairs) + ensure ATAs.
    const pairs = BigInt(LEVELS) * SHARES;
    await send([
      createAssociatedTokenAccountIdempotentInstruction(mm.publicKey, yesAta, mm.publicKey, yesMint),
      createAssociatedTokenAccountIdempotentInstruction(mm.publicKey, noAta, mm.publicKey, noMint),
      m.mintPairIx(mm.publicKey, new PublicKey(k.pubkey), pairs * LOT, { yesMint, noMint, collateralVault: new PublicKey(k.collateral_vault), userQuote: usdc, userYes: yesAta, userNo: noAta }),
    ]);

    const fair = fairCents(k.ticker, Number(k.strike_1e6) / 1e6);
    const order = (side: ob.Side, priceCents: number, tokenAta: PublicKey, vault: string): TransactionInstruction =>
      m.placeLimitOrderIx({
        user: mm.publicKey, market: new PublicKey(k.pubkey), ooAccount: oo, userTokenAccount: tokenAta,
        obMarket: new PublicKey(k.openbook_market), bids: new PublicKey(k.bids), asks: new PublicKey(k.asks),
        eventHeap: new PublicKey(k.event_heap), marketVault: new PublicKey(vault),
        args: { side, priceLots: BigInt(priceCents), maxBaseLots: SHARES, maxQuoteLotsIncludingFees: side === ob.Side.Bid ? BigInt(priceCents) * SHARES : 1_000_000_000n,
          clientOrderId: nextCoid(), orderType: ob.PlaceOrderType.PostOnly, expiryTimestamp: 0n, selfTradeBehavior: ob.SelfTradeBehavior.AbortTransaction, limit: 16 },
      });
    const ixs: TransactionInstruction[] = [];
    for (let i = 1; i <= LEVELS; i++) {
      ixs.push(order(ob.Side.Bid, clampCents(fair - i * STEP), usdc, k.openbook_quote_vault));       // buy Yes with USDC
      ixs.push(order(ob.Side.Ask, clampCents(fair + i * STEP), yesAta, k.openbook_base_vault));       // sell Yes inventory
    }
    for (let i = 0; i < ixs.length; i += 4) await send(ixs.slice(i, i + 4));
    st.seeded = true; st.recycled = false; saveState(state);
    console.log(`[mm] seeded ${k.ticker} $${Number(k.strike_1e6) / 1e6} — ${LEVELS} bids + ${LEVELS} asks around ${fair}c (${pairs} pairs)`);
  };

  const recycle = async (k: Mkt) => {
    const st = state.markets[k.pubkey]; if (!st || st.recycled) return;
    const yesMint = new PublicKey(k.yes_mint), noMint = new PublicKey(k.no_mint);
    const yesAta = getAssociatedTokenAddressSync(yesMint, mm.publicKey), noAta = getAssociatedTokenAddressSync(noMint, mm.publicKey);
    const oo = ob.ooAccountPda(mm.publicKey, st.ooIndex);
    try {
      await send([ob.cancelAllOrdersIx(mm.publicKey, oo, new PublicKey(k.openbook_market), new PublicKey(k.bids), new PublicKey(k.asks))]);
      await send([ob.settleFundsIx({ owner: mm.publicKey, ooAccount: oo, market: new PublicKey(k.openbook_market),
        marketBaseVault: new PublicKey(k.openbook_base_vault), marketQuoteVault: new PublicKey(k.openbook_quote_vault),
        userBaseAccount: yesAta, userQuoteAccount: usdc })]);
      const matched = ((y, n) => (y < n ? y : n))(await bal(yesAta), await bal(noAta));
      if (matched >= LOT) await send([m.redeemPairDirectIx(mm.publicKey, new PublicKey(k.pubkey), (matched / LOT) * LOT, { yesMint, noMint, collateralVault: new PublicKey(k.collateral_vault), userQuote: usdc, userYes: yesAta, userNo: noAta })]);
      const dust = ((y, n) => (y > n ? y - n : n - y))(await bal(yesAta), await bal(noAta));
      st.recycled = true; saveState(state);
      console.log(`[mm] recycled ${k.ticker} $${Number(k.strike_1e6) / 1e6} — redeemed ${(Number(matched) / 1e6).toFixed(0)} pairs to USDC${dust >= LOT ? ` · ${(Number(dust) / 1e6).toFixed(0)} directional shares left (settle via redeem_winning)` : ""}`);
    } catch (e) { console.warn(`[mm] recycle ${k.ticker} failed: ${(e as Error).message.slice(0, 100)}`); }
  };

  const SYS = "11111111111111111111111111111111";
  const tick = async () => {
    const now = Math.floor(Date.now() / 1000);
    const markets = ((await getJson("/markets")).markets as Mkt[]).filter((k) => k.openbook_market && k.openbook_market !== SYS);
    // recycle settled/closed markets we seeded (free capital first)
    for (const k of markets) if (state.markets[k.pubkey]?.seeded && (k.state_name === "Settled" || now >= k.close_ts)) await recycle(k);
    // seed fresh Active markets we haven't seeded (as capital allows)
    for (const k of markets) if (k.state_name === "Active" && now < k.close_ts && !state.markets[k.pubkey]?.seeded) {
      if ((await bal(usdc)) < BigInt(LEVELS) * SHARES * LOT * 2n) { console.warn("[mm] USDC running low — not seeding more"); break; }
      try { await seed(k); } catch (e) { console.warn(`[mm] seed ${k.ticker} failed: ${(e as Error).message.slice(0, 120)}`); }
    }
  };

  const ac = new AbortController();
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => ac.abort());
  await tick();
  const timer = setInterval(() => { if (!ac.signal.aborted) void tick(); }, TICK);
  ac.signal.addEventListener("abort", () => { clearInterval(timer); console.log("[mm] stopped"); });
}
main().catch((e) => { console.error("[mm] fatal:", e); process.exit(1); });
