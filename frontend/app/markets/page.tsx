"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getMarkets, marketPhase, type Market } from "@/lib/api";
import { strikeUsd, usd, countdown } from "@/lib/format";

const NAMES: Record<string, string> = {
  AAPL: "Apple", MSFT: "Microsoft", NVDA: "Nvidia", AMZN: "Amazon",
  GOOGL: "Alphabet", META: "Meta Platforms", TSLA: "Tesla",
};

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
        {[...byTicker.entries()].map(([ticker, ms]) => (
          <div key={ticker} className="card" style={{ padding: 20 }}>
            <div className="hd" style={{ alignItems: "baseline" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <h2 style={{ fontSize: 22 }}>{ticker}</h2>
                <span className="sub" style={{ fontSize: 13 }}>{NAMES[ticker] ?? "MAG7"}</span>
              </div>
              <span className="sub" style={{ fontSize: 13 }}>{ms.length} active strike{ms.length > 1 ? "s" : ""}</span>
            </div>
            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
              {ms.sort((a, b) => Number(BigInt(a.strike_1e6) - BigInt(b.strike_1e6))).map((m) => {
                const ph = marketPhase(m);
                return (
                  <Link key={m.pubkey} href={`/trade/${m.pubkey}`} className="chip" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span className="mono" style={{ fontSize: 15, color: "var(--ink)" }}>&gt; {strikeUsd(m.strike_1e6)}</span>
                    <span className="sub" style={{ fontSize: 12.5 }}>{ph}</span>
                    <span className="mono" style={{ fontSize: 13, color: "var(--ink-60)" }}>${usd(m.collateral_liability_atoms, 0)} OI</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
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
