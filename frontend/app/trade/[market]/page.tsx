"use client";
import { useEffect, useMemo, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { getMarket, getMarkets, getBook, marketPhase, type Market, type Book } from "@/lib/api";
import { strikeUsd, usd, countdown } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import { useTokenBalance } from "@/components/useBalances";
import * as mx from "@/lib/meridian";

type Outcome = "YES" | "NO";
type Side = "Buy" | "Sell";
type Level = { price: number; shares: number };

// reference spot per ticker (demo data — no live feed on localnet)
const SPOT: Record<string, number> = { AAPL: 231.08, AMZN: 241.19, GOOGL: 204.77, META: 682.40, MSFT: 512.34, NVDA: 178.62, TSLA: 349.86 };

export default function Trade() {
  const { market: pk } = useParams<{ market: string }>();
  const router = useRouter();
  const { pubkey, connect, send, conn } = useWallet();
  const [m, setM] = useState<Market | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [siblings, setSiblings] = useState<Market[]>([]);
  const [quoteMint, setQuoteMint] = useState<PublicKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [bookView, setBookView] = useState<Outcome>("YES");
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
  useEffect(() => { if (m) getMarkets().then((d) => setSiblings(d.markets.filter((x) => x.ticker === m.ticker))).catch(() => {}); }, [m?.ticker]);
  useEffect(() => setBookView(outcome), [outcome]);

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

  // ---- derived UI values ----
  const noPx = yesPx != null ? 100 - yesPx : null;
  const noSellLimit = outcome === "NO" && side === "Sell"; // market-only
  const shareN = Math.max(0, Math.floor(Number(size || "0")));
  const pxNum = Math.max(0, Math.floor(Number(price || "0")));
  const buying = side === "Buy";
  const unitCents = outcome === "YES"
    ? (market ? (buying ? book?.best_ask ?? pxNum : book?.best_bid ?? pxNum) : pxNum)
    : (buying ? 100 - pxNum : noPx != null ? 100 - (book?.best_ask ?? 100 - noPx) : pxNum);
  const notional = (shareN * (unitCents || 0)) / 100;
  const winClause = outcome === "YES" ? "at or above" : "below";
  const myOo = pubkey ? mx.ooAccountPda(pubkey, 1).toBase58() : null;
  const myBids = myOo && book?.bid_owners?.includes(myOo);
  const myAsks = myOo && book?.ask_owners?.includes(myOo);

  return (
    <div style={{ maxWidth: 1440, margin: "0 auto", padding: "22px 24px", display: "grid", gridTemplateColumns: "230px minmax(0,1fr) 336px", gap: 18, alignItems: "start" }}>
      {/* ---------- LEFT RAIL ---------- */}
      <div className="card" style={{ padding: 0, overflow: "hidden", position: "sticky", top: 84 }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--line-2)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontWeight: 600 }}>{m.ticker}</div>
          <div className="mono" style={{ fontSize: 14, color: "var(--yes-hi)" }}>{(SPOT[m.ticker] ?? 0).toFixed(2)}</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 44px 44px", padding: "8px 16px 4px", gap: 6 }} className="mono">
          <span style={{ fontSize: 10.5, letterSpacing: ".05em", color: "var(--ink-40)" }}>STRIKE</span>
          <span style={{ fontSize: 10.5, textAlign: "right", color: "var(--ink-40)" }}>YES</span>
          <span style={{ fontSize: 10.5, textAlign: "right", color: "var(--ink-40)" }}>NO</span>
        </div>
        {siblings.slice().sort((a, b) => Number(BigInt(a.strike_1e6) - BigInt(b.strike_1e6))).map((s) => {
          const active = s.pubkey === pk;
          const yes = s.mark != null ? Math.round(s.mark) : null;
          return (
            <div key={s.pubkey} onClick={() => !active && router.push(`/trade/${s.pubkey}`)}
              style={{ display: "grid", gridTemplateColumns: "1fr 44px 44px", gap: 6, padding: "9px 16px", cursor: active ? "default" : "pointer", background: active ? "var(--chip)" : "transparent", borderLeft: `2px solid ${active ? "var(--accent)" : "transparent"}` }}>
              <span className="mono" style={{ fontSize: 13, color: active ? "var(--ink)" : "var(--ink-70)" }}>&gt; {strikeUsd(s.strike_1e6)}</span>
              <span className="mono" style={{ fontSize: 13, textAlign: "right", color: "var(--yes-hi)" }}>{yes != null ? `${yes}¢` : "—"}</span>
              <span className="mono" style={{ fontSize: 13, textAlign: "right", color: "var(--no-hi)" }}>{yes != null ? `${100 - yes}¢` : "—"}</span>
            </div>
          );
        })}
        <div style={{ padding: 14 }}>
          <div style={{ padding: 12, borderRadius: 10, background: "var(--chip)" }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Your position</div>
            {yesBal > 0n || noBal > 0n ? (
              <div className="mono" style={{ fontSize: 14 }}>
                {yesBal > 0n && <div style={{ color: "var(--yes-hi)" }}>{usd(yesBal.toString(), 0)} YES</div>}
                {noBal > 0n && <div style={{ color: "var(--no-hi)" }}>{usd(noBal.toString(), 0)} NO</div>}
              </div>
            ) : <div className="sub" style={{ fontSize: 13 }}>No position on this strike.</div>}
          </div>
          <div style={{ padding: 12, borderRadius: 10, background: "var(--chip)", marginTop: 10 }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Venue</div>
            <div className="sub" style={{ fontSize: 13, lineHeight: 1.5 }}>OpenBook V2 · one Yes/USDC book per strike. Orders expire automatically at 4:00 PM ET.</div>
          </div>
        </div>
      </div>

      {/* ---------- CENTER ---------- */}
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="hd" style={{ alignItems: "flex-start", gap: 20 }}>
          <div>
            <div className="sub" style={{ fontSize: 14, marginBottom: 6 }}>{m.ticker} · 0DTE · settles 4:00 PM ET · {m.trading_day}</div>
            <h1 style={{ fontSize: 28, maxWidth: 520 }}>Will {m.ticker} close at or above ${strikeUsd(m.strike_1e6)} today?</h1>
          </div>
          <div className="statpill" style={{ textAlign: "right" }}>
            <div className="k">{settled ? "Outcome" : "Time to close"}</div>
            <div className="v mono" style={{ fontSize: settled ? 18 : 24, color: settled ? (m.outcome_name === "Yes" ? "var(--yes)" : "var(--no)") : undefined }}>
              {settled ? `${m.outcome_name} won` : countdown(m.close_ts)}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 14 }}>
          <PriceCard side="YES" price={yesPx} prob={book?.yes_prob} active={outcome === "YES"} onClick={() => setOutcome("YES")} />
          <PriceCard side="NO" price={noPx} prob={book?.no_prob} active={outcome === "NO"} onClick={() => setOutcome("NO")} />
        </div>

        <Chart pk={pk} mark={yesPx} />

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 288px", gap: 16 }}>
          <OrderBook book={book} view={bookView} setView={setBookView} />
          <FillsPanel myBids={!!myBids} myAsks={!!myAsks} />
        </div>
      </div>

      {/* ---------- RIGHT RAIL — action panel ---------- */}
      <div className="card" style={{ padding: 18, height: "fit-content", position: "sticky", top: 84, display: "flex", flexDirection: "column", gap: 14 }}>
        {!settled ? (
          <>
            <div style={{ display: "flex", gap: 3, padding: 3, borderRadius: 10, background: "var(--chip)" }}>
              {(["Buy", "Sell"] as Side[]).map((sd) => (<button key={sd} onClick={() => setSide(sd)} style={seg(side === sd)}>{sd}</button>))}
            </div>
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
                {["5", "25", "100", "500"].map((p) => (<div key={p} onClick={() => setSize(p)} style={{ padding: "6px 13px", borderRadius: 16, fontSize: 13, cursor: "pointer", background: "var(--chip)", color: "var(--ink-70)" }}>{p}</div>))}
              </div>
            </div>

            <div style={{ padding: 14, borderRadius: 11, background: "var(--accent-soft)", border: "1px solid var(--accent-border)", fontSize: 15, lineHeight: 1.55 }}>
              {buying ? "You pay " : "You receive ~"}<b>${notional.toFixed(2)}</b> {buying ? "for" : "from"} {shareN} {outcome}.<br />
              You win <b>${shareN.toFixed(2)}</b> if {m.ticker} closes {winClause} ${strikeUsd(m.strike_1e6)}.
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "7px 8px", fontSize: 13 }} className="mono">
              <span className="sub">Avg fill price</span><span>{unitCents || "—"}¢</span>
              <span className="sub">Max profit</span><span style={{ color: "var(--pos)" }}>+${buying ? Math.max(0, shareN - notional).toFixed(2) : notional.toFixed(2)}</span>
              <span className="sub">Fees</span><span>0 bps</span>
              <span className="sub">Approvals</span><span>1 signature</span>
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
const full: React.CSSProperties = { width: "100%", marginBottom: 8 };

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

function Chart({ pk, mark }: { pk: string; mark: number | null }) {
  const d = useMemo(() => {
    let seed = [...pk].reduce((a, c) => a + c.charCodeAt(0), 0);
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const target = (mark ?? 50) / 100, n = 60, pts: number[] = []; let v = 0.5;
    for (let i = 0; i < n; i++) { v += (rnd() - 0.5) * 0.06 + (target - v) * 0.03; pts.push(v); }
    const lo = Math.min(...pts), hi = Math.max(...pts), rng = hi - lo || 1;
    return pts.map((p, i) => `${i === 0 ? "M" : "L"} ${(i / (n - 1) * 600).toFixed(1)} ${(150 - ((p - lo) / rng) * 132 - 9).toFixed(1)}`).join(" ");
  }, [pk, mark]);
  return (
    <div className="card-2" style={{ padding: 14 }}>
      <div className="hd" style={{ marginBottom: 8 }}><div style={{ fontSize: 14, fontWeight: 600 }}>YES price today</div><div className="sub mono" style={{ fontSize: 11 }}>09:30 → 16:00 ET</div></div>
      <svg viewBox="0 0 600 150" preserveAspectRatio="none" style={{ width: "100%", height: 150, display: "block" }}>
        <path d={`${d} L 600 150 L 0 150 Z`} fill="var(--yes-soft)" opacity={0.5} stroke="none" />
        <path d={d} fill="none" stroke="var(--yes)" strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function OrderBook({ book, view, setView }: { book: Book | null; view: "YES" | "NO"; setView: (v: "YES" | "NO") => void }) {
  const mirror = view === "NO";
  const px = (p: number) => (mirror ? 100 - p : p);
  // sellers/buyers of the viewed outcome, priced in the viewed outcome's cents
  const rawAsks = ((mirror ? book?.bids : book?.asks) ?? []).map((l) => ({ price: px(l.price), shares: l.shares }));
  const rawBids = ((mirror ? book?.asks : book?.bids) ?? []).map((l) => ({ price: px(l.price), shares: l.shares }));
  const asks = rawAsks.sort((a, b) => a.price - b.price).slice(0, 6); // ascending (best/lowest first)
  const bids = rawBids.sort((a, b) => b.price - a.price).slice(0, 6); // descending (best/highest first)
  const maxSize = Math.max(1, ...asks.map((l) => l.shares), ...bids.map((l) => l.shares));
  const mark = book?.mark != null ? px(book.mark) : null;
  const spread = asks[0] && bids[0] ? asks[0].price - bids[0].price : null;
  // cumulative TOTAL from the best price outward, on each side
  const cum = (arr: Level[]) => { let s = 0; return arr.map((l) => (s += l.shares)); };
  const askCum = cum(asks), bidCum = cum(bids);

  const row = (l: Level, i: number, kind: "ask" | "bid", total: number) => (
    <div key={`${kind}${i}`} style={{ display: "grid", gridTemplateColumns: "50px 1fr 52px 56px", gap: 8, alignItems: "center", fontSize: 12.5, padding: "3px 0" }} className="mono">
      <span style={{ color: kind === "ask" ? "var(--no)" : "var(--pos)" }}>{l.price}¢</span>
      <span style={{ height: 12, borderRadius: 3, background: kind === "ask" ? "var(--no-soft)" : "var(--yes-soft)", width: `${Math.round((l.shares / maxSize) * 100)}%` }} />
      <span style={{ textAlign: "right", color: "var(--ink-70)" }}>{l.shares}</span>
      <span style={{ textAlign: "right", color: "var(--ink-40)" }}>{total}</span>
    </div>
  );
  return (
    <div className="card-2" style={{ padding: 16 }}>
      <div className="hd" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Order book</div>
        <div style={{ display: "flex", gap: 2, padding: 3, borderRadius: 9, background: "var(--chip)", fontSize: 12.5 }}>
          {(["YES", "NO"] as const).map((v) => (
            <div key={v} onClick={() => setView(v)} style={{ padding: "4px 11px", borderRadius: 7, cursor: "pointer", background: view === v ? "var(--chip-2)" : "transparent", color: view === v ? `var(--${v === "YES" ? "yes" : "no"}-hi)` : "var(--ink-60)" }}>{v} view</div>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "50px 1fr 52px 56px", gap: 8, fontSize: 10.5, letterSpacing: ".04em", color: "var(--ink-40)", paddingBottom: 6 }} className="mono">
        <span>PRICE</span><span>DEPTH</span><span style={{ textAlign: "right" }}>SIZE</span><span style={{ textAlign: "right" }}>TOTAL</span>
      </div>
      {/* asks: highest price at top, best (lowest) just above the spread */}
      {asks.length ? asks.map((l, i) => ({ l, i, t: askCum[i] })).reverse().map(({ l, i, t }) => row(l, i, "ask", t)) : <div className="sub" style={{ fontSize: 11, padding: "3px 0" }}>no asks</div>}
      <div style={{ display: "flex", justifyContent: "space-between", margin: "9px 0", padding: "7px 10px", borderRadius: 8, background: "var(--chip)", fontSize: 12.5 }} className="mono">
        <span className="sub">spread {spread != null ? `${spread}¢` : "—"}</span>
        <span className="sub">mark {mark != null ? `${mark}¢` : "—"}</span>
      </div>
      {bids.length ? bids.map((l, i) => row(l, i, "bid", bidCum[i])) : <div className="sub" style={{ fontSize: 11, padding: "3px 0" }}>no bids</div>}
    </div>
  );
}

function FillsPanel({ myBids, myAsks }: { myBids: boolean; myAsks: boolean }) {
  const has = myBids || myAsks;
  return (
    <div className="card-2" style={{ padding: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Recent fills</div>
      <div className="sub" style={{ fontSize: 13, lineHeight: 1.5 }}>No fills yet on this book. Executed trades will appear here.</div>
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line-2)" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Your open orders</div>
        {has ? (
          <>
            <div className="mono" style={{ fontSize: 13, color: "var(--ink-70)" }}>
              {myBids && <div style={{ color: "var(--pos)" }}>resting bid(s) on this book</div>}
              {myAsks && <div style={{ color: "var(--no)" }}>resting ask(s) on this book</div>}
            </div>
            <div className="sub" style={{ fontSize: 12, marginTop: 8 }}>Orders expire automatically at 4:00 PM ET (V1 has no manual cancel).</div>
          </>
        ) : <div className="sub" style={{ fontSize: 13 }}>No open orders.</div>}
      </div>
    </div>
  );
}
