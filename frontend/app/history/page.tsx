"use client";
import { useEffect, useState } from "react";
import { getMarkets, type Market } from "@/lib/api";
import { strikeUsd, usd } from "@/lib/format";

export default function History() {
  const [markets, setMarkets] = useState<Market[]>([]);
  useEffect(() => { getMarkets().then((d) => setMarkets(d.markets)).catch(() => {}); }, []);
  const settled = markets.filter((m) => m.state_name === "Settled");
  return (
    <div className="wrap" style={{ padding: "40px 24px" }}>
      <div className="eyebrow">History</div>
      <h1 style={{ marginTop: 6 }}>Settled markets, reconstructed from on-chain state</h1>
      <p className="sub">Every mint, trade, and redemption is on-chain. This view lists resolved outcomes; a full fill-level feed is served by the indexer&rsquo;s event stream.</p>
      <div className="card" style={{ marginTop: 22, overflow: "hidden" }}>
        <table>
          <thead><tr><th>Contract</th><th>Day</th><th>Official close</th><th>Winner</th><th>Open interest at settle</th></tr></thead>
          <tbody>
            {settled.length === 0 && <tr><td colSpan={5} className="sub" style={{ textAlign: "center", padding: 30 }}>No settled markets yet today.</td></tr>}
            {settled.map((m) => (
              <tr key={m.pubkey}>
                <td><b>{m.ticker}</b> <span className="sub">${strikeUsd(m.strike_1e6)}</span></td>
                <td className="mono">{m.trading_day}</td>
                <td className="mono">${(Number(BigInt(m.settlement_price_1e6)) / 1e6).toFixed(2)}</td>
                <td><span className={`pos-tag ${m.outcome_name === "Yes" ? "tag-yes" : "tag-no"}`}>{m.outcome_name} won</span></td>
                <td className="mono">${usd(m.collateral_liability_atoms, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
