"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getPortfolio, getMarkets, marketPhase, type Market } from "@/lib/api";
import { usd, strikeUsd } from "@/lib/format";
import { useWallet } from "@/lib/wallet";

export default function Portfolio() {
  const { pubkey, connect } = useWallet();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [positions, setPositions] = useState<any[]>([]);
  useEffect(() => {
    getMarkets().then((d) => setMarkets(d.markets)).catch(() => {});
    if (!pubkey) return;
    const load = () => getPortfolio(pubkey.toBase58()).then((d) => setPositions(d.positions)).catch(() => {});
    load(); const t = setInterval(load, 3000); return () => clearInterval(t);
  }, [pubkey?.toBase58()]);

  const mById = new Map(markets.map((m) => [m.pubkey, m]));
  const claimable = positions.filter((p) => {
    const m = mById.get(p.pubkey); return m && m.state_name === "Settled" &&
      ((m.outcome_name === "Yes" && BigInt(p.yes) > 0n) || (m.outcome_name === "No" && BigInt(p.no) > 0n));
  });
  const claimTotal = claimable.reduce((a, p) => {
    const m = mById.get(p.pubkey)!; return a + BigInt(m.outcome_name === "Yes" ? p.yes : p.no);
  }, 0n);

  if (!pubkey) return <Empty onConnect={connect} />;

  return (
    <div className="wrap" style={{ padding: "40px 24px" }}>
      <div className="eyebrow">Portfolio</div>
      <h1 style={{ marginTop: 6 }}>Positions, settled outcomes and everything waiting to be claimed</h1>

      {claimTotal > 0n && (
        <div className="card" style={{ padding: 18, marginTop: 20, borderLeft: "3px solid var(--pos)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div><div className="eyebrow">Ready to claim</div><div className="mono" style={{ fontSize: 26, fontWeight: 700, color: "var(--pos)" }}>${usd(claimTotal.toString())}</div></div>
          <div className="sub" style={{ fontSize: 13 }}>Winning tokens never expire — claim any time from each market.</div>
        </div>
      )}

      <div className="card" style={{ marginTop: 22, overflow: "hidden" }}>
        <table>
          <thead><tr><th>Contract</th><th>Phase</th><th>YES</th><th>NO</th><th>Position</th><th></th></tr></thead>
          <tbody>
            {positions.length === 0 && <tr><td colSpan={6} className="sub" style={{ textAlign: "center", padding: 30 }}>No open positions. Mint a Pair to get started.</td></tr>}
            {positions.map((p) => {
              const m = mById.get(p.pubkey);
              return (
                <tr key={p.pubkey}>
                  <td><b>{p.ticker}</b> <span className="sub">${strikeUsd(p.strike_1e6)}</span></td>
                  <td className="sub">{m ? marketPhase(m) : p.state_name}</td>
                  <td className="mono">{usd(p.yes, 0)}</td>
                  <td className="mono">{usd(p.no, 0)}</td>
                  <td><span className={`pos-tag ${p.position === "Yes-sided" ? "tag-yes" : p.position === "No-sided" ? "tag-no" : "tag-neutral"}`}>{p.position}</span></td>
                  <td style={{ textAlign: "right" }}><Link href={`/trade/${p.pubkey}`} style={{ color: "var(--yes)", fontWeight: 600 }}>Open →</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Empty({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="wrap" style={{ padding: "80px 24px", textAlign: "center" }}>
      <h1>Connect to see your portfolio</h1>
      <p className="sub">Your positions, settled outcomes, and claims live here.</p>
      <button className="btn btn-yes" style={{ marginTop: 18 }} onClick={onConnect}>Connect wallet</button>
    </div>
  );
}
