"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getPortfolio, getMarkets, marketPhase, eventUrl, type Market } from "@/lib/api";
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
  const isClaimable = (p: any) => {
    const m = mById.get(p.pubkey); return m && m.state_name === "Settled" &&
      ((m.outcome_name === "Yes" && BigInt(p.yes) > 0n) || (m.outcome_name === "No" && BigInt(p.no) > 0n));
  };
  const claimable = positions.filter(isClaimable);
  const active = positions.filter((p) => !isClaimable(p) && (BigInt(p.yes) > 0n || BigInt(p.no) > 0n));
  const claimTotal = claimable.reduce((a, p) => {
    const m = mById.get(p.pubkey)!; return a + BigInt(m.outcome_name === "Yes" ? p.yes : p.no);
  }, 0n);
  const yesExp = positions.reduce((a, p) => a + BigInt(p.yes), 0n);
  const noExp = positions.reduce((a, p) => a + BigInt(p.no), 0n);

  if (!pubkey) return <Empty onConnect={connect} />;

  return (
    <div className="wrap" style={{ padding: "26px 28px 48px" }}>
      <div className="hd" style={{ alignItems: "flex-end", marginBottom: 20 }}>
        <div>
          <h1>Portfolio</h1>
          <p className="sub" style={{ marginTop: 2 }}>Positions, settled outcomes and everything waiting to be claimed.</p>
        </div>
        {claimTotal > 0n && (
          <div style={{ padding: "12px 16px", borderRadius: 11, background: "var(--yes-soft)", border: "1px solid var(--yes-border)", display: "flex", alignItems: "center", gap: 14 }}>
            <div><div className="k" style={{ fontSize: 12, letterSpacing: ".05em", color: "var(--yes-hi)", textTransform: "uppercase" }}>Ready to claim</div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 600, marginTop: 2 }}>${usd(claimTotal)}</div></div>
            <span className="sub" style={{ fontSize: 12, maxWidth: 180 }}>Winning tokens never expire — claim from each market.</span>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 22 }}>
        <Metric k="Open positions" v={String(active.length)} />
        <Metric k="YES exposure" v={`$${usd(yesExp, 0)}`} accent="yes" />
        <Metric k="NO exposure" v={`$${usd(noExp, 0)}`} accent="no" />
        <Metric k="Ready to claim" v={`$${usd(claimTotal, 0)}`} accent={claimTotal > 0n ? "yes" : undefined} />
      </div>

      <div className="card" style={{ overflow: "hidden", marginBottom: 22 }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", fontWeight: 600 }}>Active positions</div>
        <table>
          <thead><tr><th>Contract</th><th>Phase</th><th>YES</th><th>NO</th><th>Position</th><th></th></tr></thead>
          <tbody>
            {active.length === 0 && <tr><td colSpan={6} className="sub" style={{ textAlign: "center", padding: 30 }}>No open positions. Mint a Pair to get started.</td></tr>}
            {active.map((p) => {
              const m = mById.get(p.pubkey);
              return (
                <tr key={p.pubkey}>
                  <td><b>{p.ticker}</b> <span className="sub">&gt; ${strikeUsd(p.strike_1e6)}</span></td>
                  <td className="sub">{m ? marketPhase(m) : p.state_name}</td>
                  <td className="mono">{usd(p.yes, 0)}</td>
                  <td className="mono">{usd(p.no, 0)}</td>
                  <td><span className={`pos-tag ${p.position === "Yes-sided" ? "tag-yes" : p.position === "No-sided" ? "tag-no" : "tag-neutral"}`}>{p.position}</span></td>
                  <td style={{ textAlign: "right" }}><Link href={eventUrl(mById.get(p.pubkey) ?? p)} style={{ color: "var(--accent)", fontWeight: 600 }}>Open →</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)", fontWeight: 600 }}>Settled — redeemable</div>
        <table>
          <thead><tr><th>Contract</th><th>Outcome</th><th>Winning tokens</th><th></th></tr></thead>
          <tbody>
            {claimable.length === 0 && <tr><td colSpan={4} className="sub" style={{ textAlign: "center", padding: 30 }}>Nothing settled in your favor yet.</td></tr>}
            {claimable.map((p) => {
              const m = mById.get(p.pubkey)!;
              const win = m.outcome_name === "Yes" ? p.yes : p.no;
              return (
                <tr key={p.pubkey}>
                  <td><b>{p.ticker}</b> <span className="sub">&gt; ${strikeUsd(p.strike_1e6)}</span></td>
                  <td><span className={`pos-tag ${m.outcome_name === "Yes" ? "tag-yes" : "tag-no"}`}>{m.outcome_name} won</span></td>
                  <td className="mono">${usd(win)}</td>
                  <td style={{ textAlign: "right" }}><Link href={eventUrl(m)} style={{ color: "var(--accent)", fontWeight: 600 }}>Claim →</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Metric({ k, v, accent }: { k: string; v: string; accent?: "yes" | "no" }) {
  return <div className="metric"><div className="k">{k}</div><div className="v" style={{ color: accent ? `var(--${accent})` : undefined }}>{v}</div></div>;
}

function Empty({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="wrap" style={{ padding: "80px 24px", textAlign: "center" }}>
      <h1>Connect to see your portfolio</h1>
      <p className="sub">Your positions, settled outcomes, and claims live here.</p>
      <button className="addr-chip" style={{ marginTop: 18 }} onClick={onConnect}>Connect wallet</button>
    </div>
  );
}
