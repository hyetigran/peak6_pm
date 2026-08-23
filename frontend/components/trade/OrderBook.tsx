"use client";
import type { Book } from "@/lib/api";

type Level = { price: number; shares: number };
type Row = Level & { cumShares: number; cumNotional: number };

const DEPTH_MAX = 0.42; // depth fill tops out at 42% of the row width

/** Polymarket-style ladder: cumulative depth fills behind each row, price/shares/total columns. */
export function OrderBook({ book, view, setView, last }: { book: Book | null; view: "YES" | "NO"; setView: (v: "YES" | "NO") => void; last?: number | null }) {
  const mirror = view === "NO";
  const px = (p: number) => (mirror ? 100 - p : p);
  // sellers/buyers of the viewed outcome, priced in the viewed outcome's cents
  const rawAsks = ((mirror ? book?.bids : book?.asks) ?? []).map((l) => ({ price: px(l.price), shares: l.shares }));
  const rawBids = ((mirror ? book?.asks : book?.bids) ?? []).map((l) => ({ price: px(l.price), shares: l.shares }));
  // cumulative shares + notional from the best price outward
  const cum = (arr: Level[]): Row[] => {
    let s = 0, n = 0;
    return arr.map((l) => ({ ...l, cumShares: (s += l.shares), cumNotional: (n += (l.shares * l.price) / 100) }));
  };
  const asks = cum(rawAsks.sort((a, b) => a.price - b.price).slice(0, 6)); // best (lowest) first
  const bids = cum(rawBids.sort((a, b) => b.price - a.price).slice(0, 6)); // best (highest) first
  const maxCum = Math.max(1, asks[asks.length - 1]?.cumShares ?? 0, bids[bids.length - 1]?.cumShares ?? 0);
  const spread = asks[0] && bids[0] ? +(asks[0].price - bids[0].price).toFixed(1) : null;

  const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "minmax(90px,1fr) 80px 110px 110px", alignItems: "center", gap: 8 };
  const num: React.CSSProperties = { textAlign: "right", fontSize: 13 };

  const row = (l: Row, kind: "ask" | "bid", badge: boolean) => (
    <div key={`${kind}${l.price}`} style={{ position: "relative", padding: "0 14px" }}>
      {/* stepped cumulative depth fill, anchored left, behind the row */}
      <div style={{ position: "absolute", inset: "0 auto 0 0", width: `${(l.cumShares / maxCum) * DEPTH_MAX * 100}%`, background: kind === "ask" ? "var(--no-soft)" : "var(--yes-soft)" }} />
      <div className="mono" style={{ ...grid, position: "relative", height: 34 }}>
        <span>
          {badge && (
            <span style={{ padding: "3px 10px", borderRadius: 999, fontSize: 11.5, fontWeight: 700, fontFamily: "var(--sans)", background: kind === "ask" ? "var(--no)" : "var(--yes)", color: "var(--bg)" }}>
              {kind === "ask" ? "Asks" : "Bids"}
            </span>
          )}
        </span>
        <span style={{ ...num, fontWeight: 600, color: kind === "ask" ? "var(--no-hi)" : "var(--yes-hi)" }}>{l.price}¢</span>
        <span style={{ ...num, color: "var(--ink-70)" }}>{l.shares.toLocaleString("en-US")}</span>
        <span style={{ ...num, color: "var(--ink)" }}>${l.cumNotional.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      </div>
    </div>
  );

  return (
    <div className="card-2" style={{ padding: "10px 0 6px" }}>
      {/* header: view switch + column labels */}
      <div className="mono" style={{ ...grid, padding: "4px 14px 10px", fontSize: 10.5, letterSpacing: ".05em", color: "var(--ink-40)", borderBottom: "1px solid var(--line-2)" }}>
        <span style={{ display: "flex", gap: 2, alignItems: "center" }}>
          {(["YES", "NO"] as const).map((v) => (
            <span key={v} onClick={() => setView(v)}
              style={{ padding: "3px 8px", borderRadius: 6, cursor: "pointer", background: view === v ? "var(--chip-2)" : "transparent", color: view === v ? `var(--${v === "YES" ? "yes" : "no"}-hi)` : "var(--ink-40)" }}>
              TRADE {v}
            </span>
          ))}
        </span>
        <span style={num}>PRICE</span>
        <span style={num}>SHARES</span>
        <span style={num}>TOTAL</span>
      </div>
      {/* asks: worst at top, best just above the spread */}
      <div>
        {asks.length
          ? [...asks].reverse().map((l, i, arr) => row(l, "ask", i === arr.length - 1))
          : <div className="sub" style={{ fontSize: 12, padding: "10px 14px" }}>no asks</div>}
      </div>
      <div className="mono" style={{ position: "relative", display: "flex", padding: "9px 14px", borderTop: "1px solid var(--line-2)", borderBottom: "1px solid var(--line-2)", fontSize: 12.5, color: "var(--ink-60)" }}>
        <span>Last: {last != null ? `${px(last)}¢` : "--"}</span>
        <span style={{ position: "absolute", left: 0, right: 0, textAlign: "center", pointerEvents: "none" }}>Spread: {spread != null ? `${spread}¢` : "--"}</span>
      </div>
      {/* bids: best just below the spread */}
      <div>
        {bids.length
          ? bids.map((l, i) => row(l, "bid", i === 0))
          : <div className="sub" style={{ fontSize: 12, padding: "10px 14px" }}>no bids</div>}
      </div>
    </div>
  );
}
