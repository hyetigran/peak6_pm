"use client";
import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { getMarket, getBook, marketPhase, type Market, type Book } from "@/lib/api";
import { strikeUsd, usd, countdown } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import { useTokenBalance } from "@/components/useBalances";
import * as mx from "@/lib/meridian";

type Outcome = "YES" | "NO";
type Side = "Buy" | "Sell";

export default function Trade() {
  const { market: pk } = useParams<{ market: string }>();
  const { pubkey, connect, send, conn } = useWallet();
  const [m, setM] = useState<Market | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [quoteMint, setQuoteMint] = useState<PublicKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [, force] = useState(0);
  // order form
  const [outcome, setOutcome] = useState<Outcome>("YES");
  const [side, setSide] = useState<Side>("Buy");
  const [market, setMarketOrder] = useState(false);
  const [price, setPrice] = useState("50");
  const [size, setSize] = useState("5");

  useEffect(() => {
    const load = () => { getMarket(pk).then(setM).catch(() => {}); getBook(pk).then(setBook).catch(() => {}); };
    load(); const t = setInterval(() => { load(); force((x) => x + 1); }, 1500); return () => clearInterval(t);
  }, [pk]);
  useEffect(() => {
    conn.getAccountInfo(mx.configPda()).then((info) => {
      if (info) setQuoteMint(new PublicKey(info.data.subarray(8 + 2 + 32 * 8, 8 + 2 + 32 * 8 + 32)));
    }).catch(() => {});
  }, []);

  const yesBal = useTokenBalance(m?.yes_mint);
  const noBal = useTokenBalance(m?.no_mint);

  const usdcAta = () => quoteMint ? mx.ataFor(quoteMint, pubkey!) : null;
  const ensure = useCallback(async (mints: PublicKey[], needOo: boolean, obMarket?: PublicKey) => {
    const ixs: any[] = [];
    for (const mint of mints) if (!(await conn.getAccountInfo(mx.ataFor(mint, pubkey!)))) ixs.push(mx.createAtaIx(pubkey!, pubkey!, mint));
    if (needOo && obMarket && !(await conn.getAccountInfo(mx.ooAccountPda(pubkey!, 1)))) ixs.push(...mx.createOoIxs(pubkey!, obMarket));
    return ixs;
  }, [pubkey]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    if (!pubkey) return connect();
    setBusy(true); setMsg(null);
    try { await fn(); setMsg("Confirmed ✓"); }
    catch (e: any) { setMsg((e.message ?? "failed").slice(0, 200)); }
    finally { setBusy(false); }
  }, [pubkey, connect]);

  if (!m) return <div className="wrap sub" style={{ padding: 40 }}>Loading market…</div>;
  const phase = marketPhase(m);
  const settled = phase === "Settled";
  const tradeable = phase === "Trading";
  const yesM = new PublicKey(m.yes_mint), noM = new PublicKey(m.no_mint);
  const obMarket = new PublicKey(m.openbook_market);
  const sz = () => BigInt(Math.max(0, Math.floor(Number(size || "0"))));
  const pxLots = () => BigInt(Math.max(1, Math.floor(Number(price || "0"))));
  const yesPx = book?.mark ?? null;

  const submit = () => guard(async () => {
    const q = sz(); if (q === 0n) throw new Error("size must be a whole number of shares");
    const oo = mx.ooAccountPda(pubkey!, 1);
    const baseVault = new PublicKey(m.openbook_base_vault), quoteVault = new PublicKey(m.openbook_quote_vault);

    if (outcome === "YES") {
      if (side === "Buy" && !market) { // rest a bid, funded by USDC
        const pre = await ensure([yesM, noM], true, obMarket);
        await send([...pre, mx.placeLimitOrderIx({ user: pubkey!, market: new PublicKey(pk), ooAccount: oo, userTokenAccount: usdcAta()!, obMarket, bids: new PublicKey(m.bids), asks: new PublicKey(m.asks), eventHeap: new PublicKey(m.event_heap), marketVault: quoteVault, side: mx.Side.Bid, priceLots: pxLots(), baseLots: q })]);
      } else if (side === "Sell" && !market) { // rest an ask, funded by YES
        const pre = await ensure([yesM], true, obMarket);
        await send([...pre, mx.placeLimitOrderIx({ user: pubkey!, market: new PublicKey(pk), ooAccount: oo, userTokenAccount: mx.ataFor(yesM, pubkey!), obMarket, bids: new PublicKey(m.bids), asks: new PublicKey(m.asks), eventHeap: new PublicKey(m.event_heap), marketVault: baseVault, side: mx.Side.Ask, priceLots: pxLots(), baseLots: q })]);
      } else { // market take
        const isBuy = side === "Buy";
        const owners = (isBuy ? book?.ask_owners : book?.bid_owners) ?? [];
        const px = isBuy ? BigInt(book?.best_ask ?? 99) : BigInt(book?.best_bid ?? 1);
        const pre = await ensure([yesM, noM], false, obMarket);
        await send([...pre, mx.placeTakeOrderIx({ user: pubkey!, market: new PublicKey(pk), obMarket, bids: new PublicKey(m.bids), asks: new PublicKey(m.asks), baseVault, quoteVault, eventHeap: new PublicKey(m.event_heap), userBase: mx.ataFor(yesM, pubkey!), userQuote: usdcAta()!, makerOos: owners.map((o) => new PublicKey(o)), side: isBuy ? mx.Side.Bid : mx.Side.Ask, priceLots: px, baseLots: q })]);
      }
    } else { // NO
      if (side === "Buy") { // mint q pairs + rest a Sell-YES ask at (100 - noPrice)
        const pre = await ensure([yesM, noM], true, obMarket);
        const yesAsk = 100n - pxLots();
        await send([...pre,
          mx.mintPairIx(pubkey!, new PublicKey(pk), q * 1_000_000n, { yesMint: yesM, noMint: noM, collateralVault: new PublicKey(m.collateral_vault), userQuote: usdcAta()!, userYes: mx.ataFor(yesM, pubkey!), userNo: mx.ataFor(noM, pubkey!) }),
          mx.placeLimitOrderIx({ user: pubkey!, market: new PublicKey(pk), ooAccount: oo, userTokenAccount: mx.ataFor(yesM, pubkey!), obMarket, bids: new PublicKey(m.bids), asks: new PublicKey(m.asks), eventHeap: new PublicKey(m.event_heap), marketVault: baseVault, side: mx.Side.Ask, priceLots: yesAsk > 0n ? yesAsk : 1n, baseLots: q }),
        ]);
      } else { // Sell NO — market-assisted: redeem_no_via_market (buys Yes from asks)
        const owners = (book?.ask_owners ?? []).map((o) => new PublicKey(o));
        const px = BigInt(book?.best_ask ?? 99);
        const pre = await ensure([yesM, noM], false, obMarket);
        await send([...pre, mx.createTradeAtaIx(pubkey!, new PublicKey(pk), yesM),
          mx.redeemNoViaMarketIx(pubkey!, { market: new PublicKey(pk), yesMint: yesM, noMint: noM, collateralVault: new PublicKey(m.collateral_vault), userQuote: usdcAta()!, userNo: mx.ataFor(noM, pubkey!), obMarket, bids: new PublicKey(m.bids), asks: new PublicKey(m.asks), baseVault, quoteVault, eventHeap: new PublicKey(m.event_heap), makerOos: owners, qLots: q, priceLots: px })]);
      }
    }
  });

  const mint = () => guard(async () => {
    const q = sz() * 1_000_000n; const pre = await ensure([yesM, noM], false);
    await send([...pre, mx.mintPairIx(pubkey!, new PublicKey(pk), q, { yesMint: yesM, noMint: noM, collateralVault: new PublicKey(m.collateral_vault), userQuote: usdcAta()!, userYes: mx.ataFor(yesM, pubkey!), userNo: mx.ataFor(noM, pubkey!) })]);
  });
  const redeemPair = () => guard(async () => {
    const q = sz() * 1_000_000n;
    await send([mx.redeemPairDirectIx(pubkey!, new PublicKey(pk), q, { yesMint: yesM, noMint: noM, collateralVault: new PublicKey(m.collateral_vault), userQuote: usdcAta()!, userYes: mx.ataFor(yesM, pubkey!), userNo: mx.ataFor(noM, pubkey!) })]);
  });
  const winBal = m.outcome_name === "Yes" ? yesBal : noBal;
  const redeemWin = () => guard(async () => {
    const winMint = new PublicKey(m.outcome_name === "Yes" ? m.yes_mint : m.no_mint);
    await send([mx.redeemWinningIx(pubkey!, new PublicKey(pk), winMint, { collateralVault: new PublicKey(m.collateral_vault), userWinning: mx.ataFor(winMint, pubkey!), userQuote: usdcAta()!, amount: winBal })]);
  });

  const noSellLimit = outcome === "NO" && side === "Sell"; // market-only
  return (
    <div className="wrap" style={{ padding: "28px 24px", display: "grid", gridTemplateColumns: "1fr 360px", gap: 24 }}>
      <div>
        <div className="eyebrow">{m.ticker} · {m.trading_day}</div>
        <h1 style={{ marginTop: 6 }}>Will {m.ticker} close at or above ${strikeUsd(m.strike_1e6)}?</h1>
        <p className="sub">One share pays <b>$1.00</b> if the official close is at or above ${strikeUsd(m.strike_1e6)}, otherwise $0.</p>
        <div style={{ display: "flex", gap: 24, marginTop: 14, flexWrap: "wrap" }}>
          <Stat label="Phase" value={phase} />
          {!settled && <Stat label="Settles in" value={countdown(m.close_ts)} mono />}
          {yesPx != null && <Stat label="YES mark" value={`${yesPx}¢`} mono accent="yes" />}
          {book?.no_prob != null && <Stat label="Implied prob" value={`${Math.round(book.yes_prob! * 100)}% / ${Math.round(book.no_prob! * 100)}%`} mono />}
          {settled && <Stat label="Outcome" value={`${m.outcome_name} won`} accent={m.outcome_name === "Yes" ? "yes" : "no"} />}
        </div>

        {/* mirrored order book */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 22 }}>
          <BookCol title="YES" accent="yes" bids={book?.bids ?? []} asks={book?.asks ?? []} mark={yesPx} mirror={false} yourBal={yesBal} />
          <BookCol title="NO" accent="no" bids={book?.bids ?? []} asks={book?.asks ?? []} mark={yesPx} mirror yourBal={noBal} />
        </div>
      </div>

      {/* action panel */}
      <div className="card" style={{ padding: 18, height: "fit-content", position: "sticky", top: 76 }}>
        {!settled ? (
          <>
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              {(["YES", "NO"] as Outcome[]).map((o) => (
                <button key={o} onClick={() => setOutcome(o)} className="btn" style={{ flex: 1, padding: "8px", background: outcome === o ? `var(--${o === "YES" ? "yes" : "no"})` : "var(--card)", color: outcome === o ? "#fff" : "var(--ink-60)", border: "1px solid var(--line)" }}>{o}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              {(["Buy", "Sell"] as Side[]).map((sd) => (
                <button key={sd} onClick={() => setSide(sd)} className="btn btn-ghost" style={{ flex: 1, padding: "7px", borderColor: side === sd ? "var(--ink)" : "var(--line)", fontWeight: side === sd ? 700 : 500 }}>{sd}</button>
              ))}
            </div>
            {!noSellLimit && outcome === "YES" && (
              <label className="sub" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
                <input type="checkbox" checked={market} onChange={(e) => setMarketOrder(e.target.checked)} /> Market order (take best price)
              </label>
            )}
            {noSellLimit && <div className="sub" style={{ fontSize: 12, marginBottom: 10 }}>Sell No is market-only in V1 — it buys Yes and redeems the pair.</div>}
            {(!market || outcome === "NO") && !(outcome === "NO" && side === "Sell") && (
              <>
                <label className="sub" style={{ fontSize: 12 }}>Limit price (¢)</label>
                <input className="mono" value={price} onChange={(e) => setPrice(e.target.value)} style={inp} />
              </>
            )}
            <label className="sub" style={{ fontSize: 12 }}>Size (shares)</label>
            <input className="mono" value={size} onChange={(e) => setSize(e.target.value)} style={inp} />
            <button className={`btn ${outcome === "YES" ? "btn-yes" : "btn-no"}`} style={full} disabled={busy || !tradeable} onClick={submit}>
              {busy ? "…" : `${side} ${outcome} · ${size || 0} share${size === "1" ? "" : "s"}`}
            </button>
            {!tradeable && <div className="sub" style={{ fontSize: 12, marginBottom: 8 }}>Trading opens when the market is Active.</div>}
            <div style={{ borderTop: "1px solid var(--line)", margin: "10px 0", paddingTop: 10 }}>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Mint / redeem</div>
              <button className="btn btn-ghost" style={full} disabled={busy} onClick={mint}>Mint {size || 0} pairs · ${size || 0}</button>
              <button className="btn btn-ghost" style={full} disabled={busy} onClick={redeemPair}>Redeem {size || 0} pairs → ${size || 0}</button>
            </div>
          </>
        ) : (
          <button className="btn btn-yes" style={full} disabled={busy || winBal === 0n} onClick={redeemWin}>Claim {usd(winBal.toString(), 0)} winning {m.outcome_name} → USDC</button>
        )}
        {msg && <div className="mono" style={{ fontSize: 11, marginTop: 10, color: msg.includes("✓") ? "var(--pos)" : "var(--no)" }}>{msg}</div>}
        {!pubkey && <div className="sub" style={{ fontSize: 12, marginTop: 8 }}>Connect a wallet to trade.</div>}
      </div>
    </div>
  );
}

const inp: React.CSSProperties = { width: "100%", padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 8, margin: "5px 0 12px", fontSize: 15, fontFamily: "var(--mono)" };
const full: React.CSSProperties = { width: "100%", marginBottom: 8 };

function Stat({ label, value, mono, accent }: { label: string; value: string; mono?: boolean; accent?: "yes" | "no" }) {
  return <div><div className="eyebrow">{label}</div><div className={mono ? "mono" : ""} style={{ fontSize: 17, fontWeight: 600, marginTop: 3, color: accent ? `var(--${accent})` : undefined }}>{value}</div></div>;
}

function BookCol({ title, accent, bids, asks, mark, mirror, yourBal }: {
  title: string; accent: "yes" | "no"; bids: { price: number; shares: number }[]; asks: { price: number; shares: number }[]; mark: number | null; mirror: boolean; yourBal: bigint;
}) {
  // YES view: asks (sellers) above, bids (buyers) below. NO view: mirror prices (100 - p) and swap sides.
  const px = (p: number) => (mirror ? 100 - p : p);
  const rows = (arr: { price: number; shares: number }[], kind: "ask" | "bid") =>
    arr.slice(0, 5).map((l, i) => (
      <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0", color: kind === "ask" ? "var(--no)" : "var(--pos)" }}>
        <span className="mono">{px(l.price)}¢</span><span className="mono sub">{l.shares}</span>
      </div>
    ));
  // for NO, a YES ask becomes a NO bid and vice versa
  const topSide = mirror ? bids : asks;   // sellers of this outcome
  const botSide = mirror ? asks : bids;   // buyers of this outcome
  return (
    <div className="card" style={{ padding: 14, borderTop: `3px solid var(--${accent})` }}>
      <div className="hd"><h2 style={{ color: `var(--${accent})`, fontSize: 16 }}>{title}</h2><span className={`pos-tag tag-${accent}`}>{usd(yourBal.toString(), 0)} held</span></div>
      <div style={{ marginTop: 10 }}>
        <div className="eyebrow" style={{ fontSize: 9 }}>Asks</div>
        {topSide.length ? rows(topSide, mirror ? "bid" : "ask").reverse() : <div className="sub" style={{ fontSize: 11 }}>—</div>}
        <div style={{ textAlign: "center", padding: "6px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)", margin: "6px 0" }}>
          <span className="mono" style={{ fontSize: 15, fontWeight: 700 }}>{mark != null ? `${mirror ? 100 - mark : mark}¢` : "—"}</span>
        </div>
        <div className="eyebrow" style={{ fontSize: 9 }}>Bids</div>
        {botSide.length ? rows(botSide, mirror ? "ask" : "bid") : <div className="sub" style={{ fontSize: 11 }}>—</div>}
      </div>
    </div>
  );
}
