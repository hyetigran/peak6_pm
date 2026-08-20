"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getMarkets, marketPhase, type Market } from "@/lib/api";
import { strikeUsd, usd } from "@/lib/format";

const NAMES: Record<string, string> = {
  AAPL: "Apple", MSFT: "Microsoft", NVDA: "Nvidia", AMZN: "Amazon",
  GOOGL: "Alphabet", META: "Meta Platforms", TSLA: "Tesla",
};

/** The "Trade" nav destination: pick the best live market, or let the user choose. */
export default function TradeIndex() {
  const router = useRouter();
  const [markets, setMarkets] = useState<Market[] | null>(null);
  useEffect(() => {
    getMarkets().then((d) => {
      const ms = d.markets;
      const live = ms.filter((m) => marketPhase(m) === "Trading");
      if (live.length === 1) router.replace(`/trade/${live[0].pubkey}`);
      else setMarkets(ms);
    }).catch(() => setMarkets([]));
  }, []);

  if (markets === null) return <div className="wrap sub" style={{ padding: 40 }}>Loading markets…</div>;
  if (markets.length === 0) return (
    <div className="wrap" style={{ padding: "80px 28px", textAlign: "center" }}>
      <h1>No markets to trade yet</h1>
      <p className="sub">Today&rsquo;s strikes haven&rsquo;t been created.</p>
      <Link href="/markets"><button className="addr-chip" style={{ marginTop: 18 }}>Back to markets</button></Link>
    </div>
  );

  const byTicker = new Map<string, Market[]>();
  for (const m of markets) { (byTicker.get(m.ticker) ?? byTicker.set(m.ticker, []).get(m.ticker)!).push(m); }

  return (
    <div className="wrap" style={{ padding: "26px 28px 48px" }}>
      <h1>Choose a market to trade</h1>
      <p className="sub" style={{ marginTop: 2, marginBottom: 22 }}>Each strike has its own order book. Pick one to open the trading view.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(360px,1fr))", gap: 14 }}>
        {[...byTicker.entries()].map(([ticker, ms]) => (
          <div key={ticker} className="card" style={{ padding: 20 }}>
            <div className="hd" style={{ alignItems: "baseline" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <h2 style={{ fontSize: 22 }}>{ticker}</h2>
                <span className="sub" style={{ fontSize: 13 }}>{NAMES[ticker] ?? "MAG7"}</span>
              </div>
              <span className="sub" style={{ fontSize: 13 }}>{ms.length} strike{ms.length > 1 ? "s" : ""}</span>
            </div>
            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
              {ms.sort((a, b) => Number(BigInt(a.strike_1e6) - BigInt(b.strike_1e6))).map((m) => (
                <Link key={m.pubkey} href={`/trade/${m.pubkey}`} className="chip" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="mono" style={{ fontSize: 15, color: "var(--ink)" }}>&gt; {strikeUsd(m.strike_1e6)}</span>
                  <span className="sub" style={{ fontSize: 12.5 }}>{marketPhase(m)}</span>
                  <span className="mono" style={{ fontSize: 13, color: "var(--ink-60)" }}>${usd(m.collateral_liability_atoms, 0)} OI</span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
