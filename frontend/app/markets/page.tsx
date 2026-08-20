"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getMarkets, marketPhase, type Market } from "@/lib/api";
import { strikeUsd, usd } from "@/lib/format";

export default function Markets() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const load = () => getMarkets().then((d) => { setMarkets(d.markets); setErr(null); }).catch((e) => setErr(e.message));
    load(); const t = setInterval(load, 3000); return () => clearInterval(t);
  }, []);

  const byTicker = new Map<string, Market[]>();
  for (const m of markets) { (byTicker.get(m.ticker) ?? byTicker.set(m.ticker, []).get(m.ticker)!).push(m); }

  return (
    <div className="wrap" style={{ padding: "40px 24px" }}>
      <div className="hd" style={{ marginBottom: 6 }}>
        <div>
          <div className="eyebrow">Today&rsquo;s markets</div>
          <h1 style={{ marginTop: 6 }}>Binary contracts on MAG7 daily closes</h1>
        </div>
      </div>
      <p className="sub">Every contract pays $1.00 or nothing.</p>

      {err && <div className="card" style={{ padding: 20, marginTop: 20, color: "var(--no)" }}>Indexer offline ({err}). Start it with <code className="mono">make demo</code>.</div>}
      {!err && markets.length === 0 && <div className="card sub" style={{ padding: 20, marginTop: 20 }}>No markets yet — the operator hasn&rsquo;t created today&rsquo;s strikes.</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(340px,1fr))", gap: 16, marginTop: 24 }}>
        {[...byTicker.entries()].map(([ticker, ms]) => (
          <div key={ticker} className="card" style={{ padding: 18 }}>
            <div className="hd">
              <h2>{ticker}</h2>
              <span className="pos-tag tag-neutral">{ms.length} active strike{ms.length > 1 ? "s" : ""}</span>
            </div>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              {ms.sort((a, b) => Number(BigInt(a.strike_1e6) - BigInt(b.strike_1e6))).map((m) => (
                <Link key={m.pubkey} href={`/trade/${m.pubkey}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 12px", borderRadius: 8, background: "var(--paper)" }}>
                  <span className="mono" style={{ fontWeight: 600 }}>${strikeUsd(m.strike_1e6)}</span>
                  <span className="sub" style={{ fontSize: 12 }}>{marketPhase(m)}</span>
                  <span className="pos-tag tag-neutral mono">{usd(m.collateral_liability_atoms, 0)} open</span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
