"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { getMarkets, getBook, getFills, getOrders, marketPhase, parseEventSlug, eventUrl, type Market, type Book, type MarketFill, type OpenOrder } from "@/lib/api";
import { usd, countdown } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import * as mx from "@/lib/meridian";
import { OrderPanel, type Outcome, type Side } from "@/components/trade/OrderPanel";
import { Chart } from "@/components/trade/Chart";
import { OrderBook } from "@/components/trade/OrderBook";
import { FillsPanel } from "@/components/trade/FillsPanel";

type RowTab = "graph" | "book";

// company names per ticker (demo data — no reference feed on localnet)
const NAMES: Record<string, string> = { AAPL: "Apple", AMZN: "Amazon", GOOGL: "Alphabet", META: "Meta Platforms", MSFT: "Microsoft", NVDA: "Nvidia", TSLA: "Tesla" };

const fmtStrike = (s: string) => (Number(BigInt(s)) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
const fmtCents = (c: number) => (c % 1 ? c.toFixed(1) : String(c));

export default function EventPage() {
  const { slug } = useParams<{ slug: string }>();
  const parsed = useMemo(() => parseEventSlug(slug), [slug]);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sel, setSel] = useState<string | null>(null);       // order-slip target
  const [expanded, setExpanded] = useState<string | null>(null); // row with the drill-down open
  const [tab, setTab] = useState<RowTab>("graph");
  const [outcome, setOutcome] = useState<Outcome>("YES");
  const [side, setSide] = useState<Side>("Buy");
  const [book, setBook] = useState<Book | null>(null);
  const [bookView, setBookView] = useState<Outcome>("YES");
  const [expBook, setExpBook] = useState<Book | null>(null);
  const [expFills, setExpFills] = useState<MarketFill[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const { pubkey } = useWallet();
  const [, force] = useState(0);

  const byTicker = useMemo(() => markets.filter((m) => m.ticker.toLowerCase() === parsed.ticker), [markets, parsed.ticker]);
  // the event is one trading day; a bare /event/aapl resolves to the latest day
  const eventDay = useMemo(() => {
    if (parsed.trading_day) return parsed.trading_day;
    return byTicker.reduce((a, m) => Math.max(a, m.trading_day), 0) || null;
  }, [parsed.trading_day, byTicker]);
  const mine = useMemo(() => byTicker.filter((m) => m.trading_day === eventDay), [byTicker, eventDay]);
  const active = useMemo(() => mine.filter((m) => m.state_name !== "Settled" && m.state_name !== "Abandoned")
    .sort((a, b) => Number(BigInt(a.strike_1e6) - BigInt(b.strike_1e6))), [mine]);
  const resolved = useMemo(() => mine.filter((m) => m.state_name === "Settled" || m.state_name === "Abandoned")
    .sort((a, b) => Number(BigInt(a.strike_1e6) - BigInt(b.strike_1e6))), [mine]);
  const ticker = mine[0]?.ticker ?? parsed.ticker.toUpperCase();
  const selMarket = mine.find((m) => m.pubkey === sel) ?? null;

  useEffect(() => {
    const load = () => getMarkets().then((d) => { setMarkets(d.markets); setLoaded(true); }).catch(() => {});
    load(); const t = setInterval(load, 3000); const c = setInterval(() => force((x) => x + 1), 1000);
    return () => { clearInterval(t); clearInterval(c); };
  }, []);

  // canonicalize shorthand slugs (/event/aapl → /event/aapl-close-above-on-…)
  useEffect(() => {
    if (!eventDay || mine.length === 0) return;
    const canonical = eventUrl({ ticker, trading_day: eventDay });
    if (window.location.pathname !== canonical) window.history.replaceState(null, "", canonical);
  }, [eventDay, ticker, mine.length]);

  // default order-slip target: the at-the-money strike
  useEffect(() => {
    if (sel || active.length === 0) return;
    const atm = [...active].sort((a, b) => Math.abs((a.mark ?? 50) - 50) - Math.abs((b.mark ?? 50) - 50))[0];
    setSel(atm.pubkey);
  }, [active, sel]);

  // book for the order slip's market
  useEffect(() => {
    if (!sel) return;
    setBook(null);
    const load = () => getBook(sel).then(setBook).catch(() => {});
    load(); const t = setInterval(load, 1500); return () => clearInterval(t);
  }, [sel]);

  // book + fills + your orders for the expanded row's drill-down
  useEffect(() => {
    if (!expanded) return;
    setExpBook(null); setExpFills([]);
    const load = () => { getBook(expanded).then(setExpBook).catch(() => {}); getFills(expanded).then((d) => setExpFills(d.fills)).catch(() => {}); };
    load(); const t = setInterval(load, 1500); return () => clearInterval(t);
  }, [expanded]);
  useEffect(() => {
    if (!expanded || !pubkey) { setOpenOrders([]); return; }
    const oo = mx.ooAccountPda(pubkey, 1).toBase58();
    const load = () => getOrders(expanded, oo).then((d) => setOpenOrders(d.orders)).catch(() => {});
    load(); const t = setInterval(load, 2000); return () => clearInterval(t);
  }, [expanded, pubkey?.toBase58()]);
  useEffect(() => setBookView(outcome), [outcome]);

  const toggleRow = (m: Market) => { setSel(m.pubkey); setExpanded((e) => (e === m.pubkey ? null : m.pubkey)); };
  const pickBuy = (m: Market, o: Outcome) => { setSel(m.pubkey); setOutcome(o); setSide("Buy"); };

  if (loaded && mine.length === 0) return <div className="wrap sub" style={{ padding: 40 }}>No markets found for {ticker}.</div>;
  if (!loaded) return <div className="wrap sub" style={{ padding: 40 }}>Loading event…</div>;

  const totalVol = mine.reduce((a, m) => a + BigInt(m.volume_atoms ?? m.collateral_liability_atoms), 0n);
  const nextClose = active[0]?.close_ts;
  const settledEvent = active.length === 0;

  return (
    <div className="event-layout">
      {/* ---------- EVENT ---------- */}
      <div style={{ minWidth: 0 }}>
        <div className="hd event-header" style={{ alignItems: "flex-start", gap: 20 }}>
          <div style={{ minWidth: 0 }}>
            <div className="sub" style={{ fontSize: 14 }}>Equities · {NAMES[ticker] ?? "MAG7"} · 0DTE</div>
            <h1 style={{ fontSize: 28, marginTop: 4 }}>{ticker} closes above __ today?</h1>
          </div>
          <div className="statpill" style={{ textAlign: "right" }}>
            <div className="k">{settledEvent ? "Status" : "Time to close"}</div>
            <div className="v mono" style={{ fontSize: settledEvent ? 18 : 24 }}>{settledEvent ? "Settled" : countdown(nextClose!)}</div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "16px 0 6px", fontSize: 14 }} className="sub">
          <span className="mono" style={{ color: "var(--ink-70)" }}>${usd(totalVol, 0)} Vol.</span>
          <span style={{ width: 1, height: 16, background: "var(--line)" }} />
          <span>settles 4:00 PM ET</span>
        </div>

        {/* outcome rows */}
        <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 8 }}>
          {active.map((m, i) => {
            const isOpen = m.pubkey === expanded;
            const isSel = m.pubkey === sel;
            const yes = m.mark ?? null;
            const no = yes != null ? 100 - yes : null;
            const chg = m.change_24h ?? null;
            const phase = marketPhase(m);
            return (
              <div key={m.pubkey} style={{ borderTop: i === 0 ? "none" : "1px solid var(--line-2)" }}>
                <div className="event-row" onClick={() => toggleRow(m)}
                  style={{ background: isOpen ? "var(--chip)" : "transparent" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>${fmtStrike(m.strike_1e6)}</div>
                    <div className="sub mono" style={{ fontSize: 12.5, marginTop: 3 }}>
                      ${usd(m.volume_atoms ?? m.collateral_liability_atoms, 0)} Vol.
                      {phase !== "Trading" && <span style={{ marginLeft: 8, color: "var(--ink-40)" }}>· {phase}</span>}
                    </div>
                  </div>
                  {/* table-form columns: % right-aligns in a fixed slot, change sits in its own slot */}
                  <div className="event-row-prob">
                    <span className="mono" style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.5px", textAlign: "right" }}>{yes != null ? `${Math.round(yes)}%` : "—"}</span>
                    <span className="mono" style={{ fontSize: 12.5, color: chg != null && chg > 0 ? "var(--pos)" : "var(--neg)" }}>
                      {chg != null && chg !== 0 ? `${chg > 0 ? "▲" : "▼"} ${Math.abs(chg)}%` : ""}
                    </span>
                  </div>
                  <div className="event-row-actions">
                    <button onClick={(e) => { e.stopPropagation(); pickBuy(m, "YES"); }}
                      className="event-row-button" style={rowBtn("yes", isSel && outcome === "YES")}>Buy Yes {yes != null ? `${fmtCents(yes)}¢` : ""}</button>
                    <button onClick={(e) => { e.stopPropagation(); pickBuy(m, "NO"); }}
                      className="event-row-button" style={rowBtn("no", isSel && outcome === "NO")}>Buy No {no != null ? `${fmtCents(no)}¢` : ""}</button>
                  </div>
                </div>
                {/* expanded drill-down: Graph | Order Book (order book ⅔ + recent fills ⅓) */}
                {isOpen && (
                  <div style={{ padding: "4px 18px 18px", background: "var(--chip)" }}>
                    <div style={{ display: "flex", gap: 18, padding: "6px 2px 12px", fontSize: 14 }}>
                      {([["graph", "Graph"], ["book", "Order Book"]] as [RowTab, string][]).map(([id, label]) => (
                        <div key={id} onClick={() => setTab(id)}
                          style={{ cursor: "pointer", fontWeight: 600, color: tab === id ? "var(--ink)" : "var(--ink-60)" }}>{label}</div>
                      ))}
                    </div>
                    {tab === "graph" ? (
                      <Chart pk={m.pubkey} mark={m.mark ?? null} openTs={m.trade_open_ts} />
                    ) : (
                      <div className="event-book-layout">
                        <OrderBook book={expBook} view={bookView} setView={setBookView} last={expFills[0]?.price ?? null} />
                        <div>
                          <FillsPanel fills={expFills} orders={openOrders} connected={!!pubkey} style={{ height: "100%" }} />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {settledEvent && <div className="sub" style={{ padding: "18px 18px" }}>All of this day&rsquo;s strikes are settled.</div>}
        </div>

        {/* resolved strikes */}
        {resolved.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <button onClick={() => setShowResolved((s) => !s)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-60)", fontSize: 14, padding: "4px 2px", display: "flex", alignItems: "center", gap: 6 }}>
              View resolved <span style={{ fontSize: 11, transform: showResolved ? "rotate(180deg)" : "none", display: "inline-block" }}>▼</span>
            </button>
            {showResolved && (
              <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 8 }}>
                {resolved.map((m, i) => (
                  <div key={m.pubkey} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto", gap: 14, alignItems: "center", padding: "13px 18px", borderTop: i === 0 ? "none" : "1px solid var(--line-2)" }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink-70)" }}>${fmtStrike(m.strike_1e6)}</div>
                      <div className="sub mono" style={{ fontSize: 12, marginTop: 2 }}>closed ${(Number(BigInt(m.settlement_price_1e6)) / 1e6).toFixed(2)}</div>
                    </div>
                    <span className={`pos-tag ${m.outcome_name === "Yes" ? "tag-yes" : "tag-no"}`}>{m.outcome_name} won</span>
                    <span className="sub mono" style={{ fontSize: 12.5 }}>${usd(m.volume_atoms ?? m.collateral_liability_atoms, 0)} Vol.</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---------- ORDER SLIP ---------- */}
      {selMarket ? (
        <OrderPanel m={selMarket} book={book} outcome={outcome} setOutcome={setOutcome} side={side} setSide={setSide} />
      ) : <div />}
    </div>
  );
}

// fixed width so the Yes/No buttons form two clean columns across rows
const rowBtn = (c: "yes" | "no", on: boolean): React.CSSProperties => ({
  padding: "10px 0", textAlign: "center", borderRadius: 9, fontSize: 14, fontWeight: 600, cursor: "pointer",
  background: on ? `var(--${c})` : `var(--${c}-soft)`,
  border: `1px solid ${on ? `var(--${c})` : `var(--${c}-border)`}`,
  color: on ? "var(--bg)" : `var(--${c}-hi)`,
});
