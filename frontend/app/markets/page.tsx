"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getMarkets, marketPhase, type Market } from "@/lib/api";
import { strikeUsd, usd, countdown } from "@/lib/format";

// Reference spot + intraday % change per ticker. Demo data (no live price feed
// on localnet); the real values come from the oracle on devnet.
const REF: Record<string, { name: string; px: number; chg: number }> = {
  AAPL: { name: "Apple", px: 231.08, chg: -0.42 },
  AMZN: { name: "Amazon", px: 241.19, chg: -0.68 },
  GOOGL: { name: "Alphabet", px: 204.77, chg: 0.12 },
  META: { name: "Meta Platforms", px: 682.40, chg: 0.91 },
  MSFT: { name: "Microsoft", px: 512.34, chg: 0.33 },
  NVDA: { name: "Nvidia", px: 178.62, chg: 1.84 },
  TSLA: { name: "Tesla", px: 349.86, chg: 2.41 },
};

// Deterministic little intraday sparkline per ticker, trending with the change.
function sparkPath(ticker: string, chg: number, w = 200, h = 40): string {
  let seed = [...ticker].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const n = 24, pts: number[] = [];
  let v = 0.5;
  for (let i = 0; i < n; i++) { v += (rnd() - 0.5) * 0.16 + (chg / 100) * 0.5 / n; pts.push(v); }
  const lo = Math.min(...pts), hi = Math.max(...pts), rng = hi - lo || 1;
  return pts.map((p, i) => `${i === 0 ? "M" : "L"} ${(i / (n - 1) * w).toFixed(1)} ${(h - ((p - lo) / rng) * (h - 6) - 3).toFixed(1)}`).join(" ");
}

function Spark({ ticker, chg }: { ticker: string; chg: number }) {
  const d = useMemo(() => sparkPath(ticker, chg), [ticker, chg]);
  const color = chg >= 0 ? "var(--pos)" : "var(--neg)";
  return (
    <svg viewBox="0 0 200 40" preserveAspectRatio="none" style={{ width: "100%", height: 40, display: "block" }}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
    </svg>
  );
}

export default function Markets() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const load = () => getMarkets().then((d) => { setMarkets(d.markets); setErr(null); }).catch((e) => setErr(e.message));
    load(); const t = setInterval(load, 3000); const c = setInterval(() => tick((x) => x + 1), 1000);
    return () => { clearInterval(t); clearInterval(c); };
  }, []);

  const byTicker = new Map<string, Market[]>();
  for (const m of markets) { (byTicker.get(m.ticker) ?? byTicker.set(m.ticker, []).get(m.ticker)!).push(m); }

  const live = markets.filter((m) => marketPhase(m) === "Trading");
  const openInterest = markets.reduce((a, m) => a + BigInt(m.collateral_liability_atoms), 0n);
  const nextClose = markets.filter((m) => !m.settled_ts && m.close_ts > Date.now() / 1000)
    .map((m) => m.close_ts).sort((a, b) => a - b)[0];
  const session = live.length > 0 ? "Trading open" : markets.length ? "Minting / pre-market" : "—";

  return (
    <div className="wrap" style={{ padding: "26px 28px 48px" }}>
      <div className="hd" style={{ alignItems: "flex-end", marginBottom: 22 }}>
        <div>
          <h1>Today&rsquo;s markets</h1>
          <p className="sub" style={{ marginTop: 2 }}>Binary contracts on MAG7 daily closes. Every contract pays $1.00 or nothing.</p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div className="statpill"><div className="k">Session</div><div className="v">{session}</div></div>
          {nextClose && <div className="statpill"><div className="k">Settles in</div><div className="v mono">{countdown(nextClose)}</div></div>}
          <div className="statpill"><div className="k">Open interest</div><div className="v mono">${usd(openInterest, 0)}</div></div>
        </div>
      </div>

      {err && <div className="card" style={{ padding: 20, color: "var(--no)" }}>Indexer offline ({err}). Start it with <code className="mono">make demo</code>.</div>}
      {!err && markets.length === 0 && <div className="card sub" style={{ padding: 20 }}>No markets yet — the operator hasn&rsquo;t created today&rsquo;s strikes.</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(360px,1fr))", gap: 14 }}>
        {[...byTicker.entries()].map(([ticker, ms]) => {
          const ref = REF[ticker] ?? { name: "MAG7", px: 0, chg: 0 };
          const sorted = ms.slice().sort((a, b) => Number(BigInt(a.strike_1e6) - BigInt(b.strike_1e6)));
          return (
            <div key={ticker} className="card" style={{ padding: 20 }}>
              <div className="hd" style={{ alignItems: "flex-start" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
                    <h2 style={{ fontSize: 20 }}>{ticker}</h2>
                    <span className="sub" style={{ fontSize: 13 }}>{ref.name}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 24, fontWeight: 500, marginTop: 4, letterSpacing: "-0.5px" }}>{ref.px.toFixed(2)}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 13, color: ref.chg >= 0 ? "var(--pos)" : "var(--neg)" }}>{ref.chg >= 0 ? "+" : ""}{ref.chg.toFixed(2)}%</div>
                  <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>{ms.length} active strike{ms.length > 1 ? "s" : ""}</div>
                </div>
              </div>

              <div style={{ margin: "12px 0 6px", height: 40, borderRadius: 8, overflow: "hidden" }}><Spark ticker={ticker} chg={ref.chg} /></div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                {sorted.map((m) => {
                  const yes = m.mark != null ? Math.round(m.mark) : null;
                  const yesColor = yes == null ? "var(--ink-60)" : yes >= 50 ? "var(--yes-hi)" : "var(--no-hi)";
                  return (
                    <Link key={m.pubkey} href={`/trade/${m.pubkey}`} className="chip" style={{ display: "flex", alignItems: "baseline", gap: 8, flex: "1 1 auto" }}>
                      <span className="mono" style={{ fontSize: 13, color: "var(--ink-60)" }}>&gt; {strikeUsd(m.strike_1e6)}</span>
                      <span className="mono" style={{ fontSize: 15, marginLeft: "auto", color: yesColor }}>{yes != null ? `${yes}¢` : "—"}</span>
                    </Link>
                  );
                })}
              </div>

              <div className="sub" style={{ fontSize: 12.5, marginTop: 12 }}>Trading · ${usd(ms.reduce((a, m) => a + BigInt(m.collateral_liability_atoms), 0n), 0)} open interest</div>
            </div>
          );
        })}
      </div>

      {markets.length > 0 && (
        <div className="card" style={{ marginTop: 16, padding: "16px 20px", display: "flex", alignItems: "center", gap: 20 }}>
          <div className="sub" style={{ maxWidth: 560, lineHeight: 1.5, fontSize: 14 }}>
            Strikes are generated each morning at ±3%, ±6% and ±9% from yesterday&rsquo;s close, rounded to the nearest $10. Duplicates are removed.
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {["08:00 strikes", "09:00 minting", "09:30 trading", "16:00 settle"].map((s, i) => (
              <span key={s} className="mono" style={{ fontSize: 12, padding: "6px 10px", borderRadius: 7, background: i === 2 ? "var(--accent-soft)" : "var(--chip-2)", color: "var(--ink-60)" }}>{s}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
