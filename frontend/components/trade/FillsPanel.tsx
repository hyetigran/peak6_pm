"use client";
import type { MarketFill, OpenOrder } from "@/lib/api";

export function FillsPanel({ fills, orders, connected, style }: { fills: MarketFill[]; orders: OpenOrder[]; connected: boolean; style?: React.CSSProperties }) {
  const hhmm = (ts: number) => new Date(ts * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <div className="card-2" style={{ padding: 16, display: "flex", flexDirection: "column", boxSizing: "border-box", ...style }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Recent fills</div>
      {/* the list scrolls inside the card when the panel is height-constrained */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {fills.length ? (
          <div style={{ display: "grid", gridTemplateColumns: "48px 1fr 46px", gap: "6px 8px", fontSize: 12.5 }} className="mono">
            {fills.map((f, i) => (
              <div key={i} style={{ display: "contents" }}>
                <span style={{ color: "var(--ink-40)" }}>{hhmm(f.ts)}</span>
                <span style={{ color: f.side === 0 ? "var(--pos)" : "var(--no)" }}>{f.side === 0 ? "BUY" : "SELL"} YES {f.price}¢</span>
                <span style={{ textAlign: "right", color: "var(--ink-70)" }}>{f.qty}</span>
              </div>
            ))}
          </div>
        ) : <div className="sub" style={{ fontSize: 13, lineHeight: 1.5 }}>No fills yet. Executed trades on this book appear here.</div>}
      </div>
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line-2)" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Your open orders</div>
        {!connected ? <div className="sub" style={{ fontSize: 13 }}>Connect a wallet to see your orders.</div>
          : orders.length ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 46px", gap: "5px 8px", fontSize: 13 }} className="mono">
                {orders.map((o, i) => (
                  <div key={i} style={{ display: "contents" }}>
                    <span style={{ color: o.side === "bid" ? "var(--pos)" : "var(--no)" }}>{o.side === "bid" ? "Buy YES" : "Sell YES"} {o.price}¢</span>
                    <span style={{ textAlign: "right", color: "var(--ink-70)" }}>{o.shares}</span>
                  </div>
                ))}
              </div>
              <div className="sub" style={{ fontSize: 12, marginTop: 8 }}>Orders expire automatically at 4:00 PM ET (V1 has no manual cancel).</div>
            </>
          ) : <div className="sub" style={{ fontSize: 13 }}>No open orders.</div>}
      </div>
    </div>
  );
}
