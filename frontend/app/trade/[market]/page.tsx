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
  const noPx = yesPx != null ? 100 - yesPx : null;
  const shareN = Math.max(0, Math.floor(Number(size || "0")));
  const pxNum = Math.max(0, Math.floor(Number(price || "0")));
  const buying = side === "Buy";
  const unitCents = outcome === "YES"
    ? (market ? (buying ? book?.best_ask ?? pxNum : book?.best_bid ?? pxNum) : pxNum)
    : (buying ? 100 - pxNum : noPx != null ? 100 - (book?.best_ask ?? 100 - noPx) : pxNum);
  const notional = (shareN * (unitCents || 0)) / 100;
  const winClause = outcome === "YES" ? "at or above" : "below";

  return (
    <div className="wrap" style={{ padding: "24px 28px", display: "grid", gridTemplateColumns: "1fr 340px", gap: 22 }}>
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>
        <div className="hd" style={{ alignItems: "flex-start", gap: 20 }}>
          <div>
            <div className="sub" style={{ fontSize: 14, marginBottom: 6 }}>{m.ticker} · 0DTE · settles 4:00 PM ET · {m.trading_day}</div>
            <h1 style={{ fontSize: 30, maxWidth: 560 }}>Will {m.ticker} close at or above ${strikeUsd(m.strike_1e6)} today?</h1>
          </div>
          <div className="statpill" style={{ textAlign: "right" }}>
            <div className="k">{settled ? "Outcome" : "Time to close"}</div>
            <div className="v mono" style={{ fontSize: settled ? 18 : 24, color: settled ? (m.outcome_name === "Yes" ? "var(--yes)" : "var(--no)") : undefined }}>
              {settled ? `${m.outcome_name} won` : countdown(m.close_ts)}
            </div>
          </div>
        </div>

        {/* YES / NO price hero */}
        <div style={{ display: "flex", gap: 14 }}>
          <PriceCard side="YES" price={yesPx} prob={book?.yes_prob} active={outcome === "YES"} onClick={() => setOutcome("YES")} />
          <PriceCard side="NO" price={noPx} prob={book?.no_prob} active={outcome === "NO"} onClick={() => setOutcome("NO")} />
        </div>

        {/* mirrored order book */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <BookCol title="YES" accent="yes" bids={book?.bids ?? []} asks={book?.asks ?? []} mark={yesPx} mirror={false} yourBal={yesBal} />
          <BookCol title="NO" accent="no" bids={book?.bids ?? []} asks={book?.asks ?? []} mark={yesPx} mirror yourBal={noBal} />
        </div>
        {book?.note && <div className="card-2" style={{ padding: "12px 16px" }}><span className="sub" style={{ fontSize: 13 }}>{book.note}</span></div>}
      </div>

      {/* action panel */}
      <div className="card" style={{ padding: 18, height: "fit-content", position: "sticky", top: 84, display: "flex", flexDirection: "column", gap: 14 }}>
        {!settled ? (
          <>
            {/* Buy / Sell segmented */}
            <div style={{ display: "flex", gap: 3, padding: 3, borderRadius: 10, background: "var(--chip)" }}>
              {(["Buy", "Sell"] as Side[]).map((sd) => (
                <button key={sd} onClick={() => setSide(sd)} style={seg(side === sd)}>{sd}</button>
              ))}
            </div>
            {/* YES / NO tabs */}
            <div style={{ display: "flex", gap: 10 }}>
              {(["YES", "NO"] as Outcome[]).map((o) => {
                const on = outcome === o, c = o === "YES" ? "yes" : "no";
                return (
                  <button key={o} onClick={() => setOutcome(o)} style={{ flex: 1, textAlign: "center", padding: "12px 0", borderRadius: 10, cursor: "pointer", background: on ? `var(--${c}-soft)` : "var(--chip)", border: `1px solid ${on ? `var(--${c}-border)` : "transparent"}`, color: "var(--ink)" }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: `var(--${c}-hi)` }}>{o}</div>
                    <div className="mono" style={{ fontSize: 18, marginTop: 2 }}>{(o === "YES" ? yesPx : noPx) ?? "—"}¢</div>
                  </button>
                );
              })}
            </div>
            {/* Market / Limit */}
            {outcome === "YES" && (
              <div style={{ display: "flex", gap: 16, fontSize: 14 }}>
                {[["Market", market], ["Limit", !market]].map(([label, on]) => (
                  <div key={label as string} onClick={() => setMarketOrder(label === "Market")} style={{ cursor: "pointer", paddingBottom: 5, color: on ? "var(--ink)" : "var(--ink-60)", borderBottom: `2px solid ${on ? "var(--accent)" : "transparent"}` }}>{label as string}</div>
                ))}
              </div>
            )}
            {noSellLimit && <div className="sub" style={{ fontSize: 12 }}>Sell No is market-only in V1 — it buys Yes and redeems the pair.</div>}

            {(!market || outcome === "NO") && !noSellLimit && (
              <div>
                <div className="sub" style={{ fontSize: 13, marginBottom: 6 }}>Limit price (¢)</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, ...fieldBox }}>
                  <input className="mono" value={price} onChange={(e) => setPrice(e.target.value)} style={bareInput} />
                  <span className="sub" style={{ fontSize: 15 }}>¢</span>
                  <span className="sub" style={{ marginLeft: "auto", fontSize: 12 }}>expires 16:00 ET</span>
                </div>
              </div>
            )}

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }} className="sub"><span>Shares</span><span>1 share pays $1.00</span></div>
              <div style={fieldBox}><input className="mono" value={size} onChange={(e) => setSize(e.target.value)} style={{ ...bareInput, fontSize: 20 }} /></div>
              <div style={{ display: "flex", gap: 7, marginTop: 8 }}>
                {["5", "25", "100", "500"].map((p) => (
                  <div key={p} onClick={() => setSize(p)} style={{ padding: "6px 13px", borderRadius: 16, fontSize: 13, cursor: "pointer", background: "var(--chip)", color: "var(--ink-70)" }}>{p}</div>
                ))}
              </div>
            </div>

            <div style={{ padding: 14, borderRadius: 11, background: "var(--accent-soft)", border: "1px solid var(--accent-border)", fontSize: 15, lineHeight: 1.55 }}>
              {buying ? "You pay " : "You receive ~"}<b>${notional.toFixed(2)}</b> {buying ? "for" : "from"} {shareN} {outcome}.<br />
              You win <b>${shareN.toFixed(2)}</b> if {m.ticker} closes {winClause} ${strikeUsd(m.strike_1e6)}.
            </div>

            <button className={`btn ${outcome === "NO" && side === "Sell" ? "btn-no" : "btn-yes"}`} style={{ padding: 15, fontSize: 16 }} disabled={busy || !tradeable} onClick={submit}>
              {busy ? "…" : `${side} ${outcome} · ${shareN} share${shareN === 1 ? "" : "s"}`}
            </button>
            {!tradeable && <div className="sub" style={{ fontSize: 12 }}>Trading opens when the market is Active.</div>}

            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Mint / redeem</div>
              <button className="btn btn-ghost" style={full} disabled={busy} onClick={mint}>Mint {shareN} pairs · ${shareN}</button>
              <button className="btn btn-ghost" style={{ ...full, marginBottom: 0 }} disabled={busy} onClick={redeemPair}>Redeem {shareN} pairs → ${shareN}</button>
            </div>
          </>
        ) : (
          <button className="btn btn-yes" style={{ padding: 15, fontSize: 16 }} disabled={busy || winBal === 0n} onClick={redeemWin}>Claim {usd(winBal.toString(), 0)} winning {m.outcome_name} → USDC</button>
        )}
        {msg && <div className="mono" style={{ fontSize: 11, color: msg.includes("✓") ? "var(--pos)" : "var(--no)" }}>{msg}</div>}
        {!pubkey && <div className="sub" style={{ fontSize: 12 }}>Connect a wallet to trade.</div>}
      </div>
    </div>
  );
}

const seg = (on: boolean): React.CSSProperties => ({ flex: 1, textAlign: "center", padding: 9, borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: "pointer", border: "none", background: on ? "var(--accent)" : "transparent", color: on ? "var(--on-accent)" : "var(--ink-60)" });
const fieldBox: React.CSSProperties = { padding: "12px 14px", borderRadius: 10, background: "var(--chip)", border: "1px solid var(--line)", display: "flex", alignItems: "center" };
const bareInput: React.CSSProperties = { flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "var(--ink)", fontSize: 19, fontFamily: "var(--mono)", padding: 0 };

function PriceCard({ side, price, prob, active, onClick }: { side: "YES" | "NO"; price: number | null; prob?: number | null; active: boolean; onClick: () => void }) {
  const c = side === "YES" ? "yes" : "no";
  return (
    <div onClick={onClick} style={{ flex: 1, padding: "18px 20px", borderRadius: 13, cursor: "pointer", background: `var(--${c}-soft)`, border: `1px solid ${active ? `var(--${c})` : `var(--${c}-border)`}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: `var(--${c}-hi)` }}>{side}</div>
        <div className="sub" style={{ fontSize: 13 }}>pays $1.00</div>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 8 }}>
        <div className="mono" style={{ fontSize: 38, fontWeight: 600, lineHeight: 1, letterSpacing: "-1px" }}>{price ?? "—"}¢</div>
        {prob != null && <div style={{ fontSize: 16, color: `var(--${c})` }}>{Math.round(prob * 100)}% implied</div>}
      </div>
    </div>
  );
}

const full: React.CSSProperties = { width: "100%", marginBottom: 8 };

function BookCol({ title, accent, bids, asks, mark, mirror, yourBal }: {
  title: string; accent: "yes" | "no"; bids: { price: number; shares: number }[]; asks: { price: number; shares: number }[]; mark: number | null; mirror: boolean; yourBal: bigint;
}) {
  // YES view: asks (sellers) above, bids (buyers) below. NO view mirrors prices (100 - p) and swaps sides.
  const px = (p: number) => (mirror ? 100 - p : p);
  const topSide = (mirror ? bids : asks).slice(0, 5);   // sellers of this outcome (ask side)
  const botSide = (mirror ? asks : bids).slice(0, 5);   // buyers of this outcome (bid side)
  const maxSize = Math.max(1, ...topSide.map((l) => l.shares), ...botSide.map((l) => l.shares));
  const row = (l: { price: number; shares: number }, i: number, kind: "ask" | "bid") => {
    const bar = kind === "ask" ? "var(--no-soft)" : "var(--yes-soft)";
    const txt = kind === "ask" ? "var(--no)" : "var(--pos)";
    return (
      <div key={`${kind}${i}`} style={{ display: "grid", gridTemplateColumns: "44px 1fr 44px", gap: 8, alignItems: "center", fontSize: 12.5, padding: "3px 0" }}>
        <span className="mono" style={{ color: txt }}>{px(l.price)}¢</span>
        <span style={{ height: 12, borderRadius: 3, background: bar, width: `${Math.round((l.shares / maxSize) * 100)}%` }} />
        <span className="mono" style={{ textAlign: "right", color: "var(--ink-70)" }}>{l.shares}</span>
      </div>
    );
  };
  return (
    <div className="card-2" style={{ padding: 14, borderTop: `2px solid var(--${accent})` }}>
      <div className="hd"><h2 style={{ color: `var(--${accent}-hi)`, fontSize: 15 }}>{title} book</h2><span className={`pos-tag tag-${accent}`}>{usd(yourBal.toString(), 0)} held</span></div>
      <div style={{ marginTop: 10 }}>
        {topSide.length ? topSide.slice().reverse().map((l, i) => row(l, i, "ask")) : <div className="sub" style={{ fontSize: 11, padding: "3px 0" }}>no asks</div>}
        <div style={{ textAlign: "center", padding: "7px 0", margin: "6px 0", borderRadius: 8, background: "var(--chip)" }}>
          <span className="mono" style={{ fontSize: 14, fontWeight: 600 }}>{mark != null ? `${mirror ? 100 - mark : mark}¢` : "—"}</span>
          <span className="sub" style={{ fontSize: 11, marginLeft: 8 }}>mark</span>
        </div>
        {botSide.length ? botSide.map((l, i) => row(l, i, "bid")) : <div className="sub" style={{ fontSize: 11, padding: "3px 0" }}>no bids</div>}
      </div>
    </div>
  );
}
