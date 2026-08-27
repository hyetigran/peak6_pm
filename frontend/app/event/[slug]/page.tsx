"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { getEvent, openEventStream, marketPhase, parseEventSlug, eventUrl, type Market, type Book, type MarketFill, type OpenOrder } from "@/lib/api";
import { usd, countdown, tradingDayLabel, isTodayET } from "@/lib/format";
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

function EventSkeleton({ ticker }: { ticker: string }) {
  return (
    <div className="event-layout event-skeleton" aria-busy="true" aria-label="Loading event">
      <div style={{ minWidth: 0 }}>
        <div className="hd event-header" style={{ alignItems: "flex-start", gap: 20 }}>
          <div className="event-skeleton-title">
            <div className="skeleton-line skeleton-line-sm" />
            <div className="skeleton-line skeleton-line-title" />
          </div>
          <div className="statpill event-skeleton-stat">
            <div className="skeleton-line skeleton-line-label" />
            <div className="skeleton-line skeleton-line-number" />
          </div>
        </div>
        <div className="event-skeleton-meta">
          <div className="skeleton-line skeleton-line-meta" />
          <div className="skeleton-line skeleton-line-meta" />
        </div>
        <div className="card event-skeleton-card">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="event-skeleton-row">
              <div>
                <div className="skeleton-line skeleton-line-strike" />
                <div className="skeleton-line skeleton-line-sub" />
              </div>
              <div className="skeleton-line skeleton-line-prob" />
              <div className="event-skeleton-actions">
                <div className="skeleton-line skeleton-line-button" />
                <div className="skeleton-line skeleton-line-button" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="event-order-panel event-skeleton-slip" data-open="false">
        <section className="order-slip-card" aria-label={`Loading ${ticker} order slip`}>
          <div className="order-slip-head">
            <div className="order-slip-market">
              <div className="skeleton-line skeleton-line-avatar" />
              <div className="event-skeleton-slip-copy">
                <div className="skeleton-line skeleton-line-slip-title" />
                <div className="skeleton-line skeleton-line-slip-subtitle" />
              </div>
            </div>
          </div>
          <div className="order-slip-tradebar">
            <div className="skeleton-line skeleton-line-tabs" />
            <div className="skeleton-line skeleton-line-mode" />
          </div>
          <div className="order-slip-body">
            <div className="order-slip-outcomes">
              <div className="skeleton-line skeleton-line-outcome" />
              <div className="skeleton-line skeleton-line-outcome" />
            </div>
            <div className="event-skeleton-slip-entry">
              <div className="skeleton-line skeleton-line-field" />
              <div className="skeleton-line skeleton-line-input" />
            </div>
            <div className="order-slip-action-area">
              <div className="skeleton-line skeleton-line-primary" />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

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
  const [mobileSlipOpen, setMobileSlipOpen] = useState(false);
  const initializedEventRef = useRef<string | null>(null);
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

  // Live data: ONE server-sent-events stream per page (the indexer holds the
  // venue subscriptions and pushes book deltas). Books/fills/orders for every
  // market of the ticker are cached client-side, so switching rows is local.
  // If the stream can't be established, fall back to the 2s /event snapshot
  // poll (skipped while a tx is in flight or the tab is hidden).
  const { pubkey, inFlight, prefetchMints } = useWallet();
  const inFlightRef = useRef(inFlight); inFlightRef.current = inFlight;
  const selRef = useRef<string | null>(null), expRef = useRef<string | null>(null);
  const cache = useRef<{ books: Record<string, Book>; fills: Record<string, MarketFill[]>; orders: Record<string, OpenOrder[]> }>({ books: {}, fills: {}, orders: {} });
  const applySel = () => { const c = cache.current; const sel = selRef.current, exp = expRef.current;
    setBook(sel ? c.books[sel] ?? null : null);
    setExpBook(exp ? c.books[exp] ?? null : null); setExpFills(exp ? c.fills[exp] ?? [] : []); setOpenOrders(exp ? c.orders[exp] ?? [] : []); };
  const applyRef = useRef(applySel); applyRef.current = applySel;
  useEffect(() => {
    const oo = pubkey ? mx.ooAccountPda(pubkey, 1).toBase58() : null;
    let cancelled = false;
    let stopPoll: (() => void) | null = null;
    const startPoll = () => {
      const load = () => {
        if (inFlightRef.current || document.visibilityState !== "visible") return;
        const sel = selRef.current, exp = expRef.current;
        getEvent(parsed.ticker, { sel, exp, oo }).then((d) => {
          if (cancelled) return;
          setMarkets(d.markets); setLoaded(true);
          const c = cache.current;
          if (sel && d.book) c.books[sel] = d.book;
          if (exp) { if (d.exp_book) c.books[exp] = d.exp_book; c.fills[exp] = d.fills; c.orders[exp] = d.orders; }
          applyRef.current();
        }).catch(() => {});
      };
      load();
      const t = setInterval(load, 2000);
      stopPoll = () => clearInterval(t);
    };
    const stopStream = openEventStream(parsed.ticker, oo, {
      onSnapshot: (snap) => {
        if (cancelled) return;
        cache.current = { books: snap.books, fills: snap.fills, orders: snap.orders };
        setMarkets(snap.markets); setLoaded(true); applyRef.current();
      },
      onBook: (d) => {
        if (cancelled) return;
        const c = cache.current;
        c.books[d.market] = d.book;
        if (d.fills.length) c.fills[d.market] = [...d.fills.slice().reverse(), ...(c.fills[d.market] ?? [])].slice(0, 25);
        if (d.orders) c.orders[d.market] = d.orders;
        setMarkets((ms) => ms.map((m) => m.pubkey === d.market ? { ...m, mark: d.book.mark, yes_prob: d.book.yes_prob } : m));
        applyRef.current();
      },
      onMarket: (m) => { if (!cancelled) setMarkets((ms) => ms.some((x) => x.pubkey === m.pubkey) ? ms.map((x) => x.pubkey === m.pubkey ? m : x) : [...ms, m]); },
      onError: () => { if (cancelled) return; startPoll(); },
    });
    const c = setInterval(() => force((x) => x + 1), 1000);
    return () => { cancelled = true; stopStream(); stopPoll?.(); clearInterval(c); };
  }, [parsed.ticker, pubkey?.toBase58()]);

  // canonicalize shorthand slugs (/event/aapl → /event/aapl-close-above-on-…)
  useEffect(() => {
    if (!eventDay || mine.length === 0) return;
    const canonical = eventUrl({ ticker, trading_day: eventDay });
    if (window.location.pathname !== canonical) window.history.replaceState(null, "", canonical);
  }, [eventDay, ticker, mine.length]);

  const eventKey = eventDay ? `${ticker}:${eventDay}` : null;

  // default event view: first row expanded on the chart
  useEffect(() => {
    if (!eventKey || active.length === 0 || initializedEventRef.current === eventKey) return;
    const first = active[0];
    setSel(first.pubkey);
    setExpanded(first.pubkey);
    setTab("graph");
    setMobileSlipOpen(false);
    initializedEventRef.current = eventKey;
  }, [active, eventKey]);

  // selection changes are served from the client-side cache
  useEffect(() => { selRef.current = sel; applyRef.current(); }, [sel]);
  useEffect(() => { expRef.current = expanded; applyRef.current(); }, [expanded]);
  useEffect(() => setBookView(outcome), [outcome]);

  // Warm every YES/NO ATA for this event in one (or, above 100 accounts, a few)
  // batched reads. Selecting a strike then needs no account lookup just to show
  // its balance or build the order ticket.
  useEffect(() => {
    if (!pubkey || mine.length === 0) return;
    void prefetchMints(mine.flatMap((m) => [m.yes_mint, m.no_mint]));
  }, [pubkey?.toBase58(), mine, prefetchMints]);

  const toggleRow = (m: Market) => { setSel(m.pubkey); setExpanded((e) => (e === m.pubkey ? null : m.pubkey)); };
  const pickBuy = (m: Market, o: Outcome) => {
    const sameTicket = sel === m.pubkey && outcome === o && side === "Buy";
    setSel(m.pubkey);
    setOutcome(o);
    setSide("Buy");
    setMobileSlipOpen((open) => (sameTicket ? !open : true));
  };

  if (loaded && mine.length === 0) return <div className="wrap sub" style={{ padding: 40 }}>No markets found for {ticker}.</div>;
  if (!loaded) return <EventSkeleton ticker={parsed.ticker.toUpperCase()} />;

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
            {/* Never hardcode "today": market-open creates the NEXT session
                minutes after the current one settles, so an event opened after
                4pm ET is asking about tomorrow. Say which session it is. */}
            <h1 style={{ fontSize: 28, marginTop: 4 }}>
              {ticker} closes above __ {eventDay ? (isTodayET(eventDay) ? "today" : `on ${tradingDayLabel(eventDay)}`) : ""}?
            </h1>
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
        <OrderPanel
          m={selMarket}
          book={book}
          mobileOpen={mobileSlipOpen}
          onMobileClose={() => setMobileSlipOpen(false)}
          outcome={outcome}
          setOutcome={setOutcome}
          side={side}
          setSide={setSide}
        />
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
