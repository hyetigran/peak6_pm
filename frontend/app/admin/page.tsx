"use client";
import { useEffect, useState } from "react";
import { getMarkets, getHealth, marketPhase, type Market, type Health } from "@/lib/api";
import { strikeUsd, usd, countdown } from "@/lib/format";

type Stage = { time: string; label: string; status: string; state: "done" | "live" | "queued" };

export default function Admin() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [health, setHealth] = useState<(Health & { ok?: boolean }) | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const load = () => {
      getMarkets().then((d) => setMarkets(d.markets)).catch(() => {});
      getHealth().then(setHealth).catch(() => setHealth(null));
    };
    load(); const t = setInterval(load, 3000); const c = setInterval(() => tick((x) => x + 1), 1000);
    return () => { clearInterval(t); clearInterval(c); };
  }, []);

  const now = Date.now() / 1000;
  const n = markets.length;
  const minted = markets.filter((m) => now >= m.mint_open_ts).length;
  const trading = markets.filter((m) => marketPhase(m) === "Trading").length;
  const settled = markets.filter((m) => m.state_name === "Settled").length;
  const paused = markets.some((m) => m.paused);
  const nextClose = markets.filter((m) => !m.settled_ts && m.close_ts > now).map((m) => m.close_ts).sort((a, b) => a - b)[0];

  const stages: Stage[] = [
    { time: "08:00", label: "strikes generated", status: n ? `Done · ${n} strikes` : "Waiting", state: n ? "done" : "queued" },
    { time: "08:30", label: "markets created", status: n ? `Done · ${n} books attached` : "Waiting", state: n ? "done" : "queued" },
    { time: "09:00", label: "minting open", status: minted ? "Done" : "Queued", state: minted ? "done" : "queued" },
    { time: "09:30", label: "trading live", status: trading ? `In progress · ${nextClose ? countdown(nextClose) : "—"} to close` : settled === n && n ? "Closed" : "Queued", state: trading ? "live" : settled === n && n ? "done" : "queued" },
    { time: "16:00", label: "close & settle", status: settled ? `${settled} / ${n} settled` : `Queued · ${n} markets`, state: settled === n && n ? "done" : settled ? "live" : "queued" },
    { time: "16:20", label: "collect fees", status: "Queued · no-op at 0 bps", state: "queued" },
  ];
  const stageColor = (s: Stage["state"]) => s === "done" ? "var(--yes)" : s === "live" ? "var(--accent)" : "var(--line)";

  return (
    <div className="wrap" style={{ padding: "26px 28px 48px" }}>
      <div className="hd" style={{ alignItems: "flex-end", marginBottom: 20 }}>
        <div>
          <h1>Ops console</h1>
          <p className="sub" style={{ marginTop: 2 }}>Daily lifecycle, oracle health, fee switches and the settlement override path.</p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-ghost" disabled title="Requires operator multisig">Run settle now</button>
          <button className="btn" disabled title="Requires operator multisig" style={{ background: "oklch(0.30 0.09 60)", border: "1px solid oklch(0.45 0.12 60)", color: "var(--ink)" }}>{paused ? "Resume minting" : "Pause minting"}</button>
        </div>
      </div>

      {/* Lifecycle timeline */}
      <div className="card-2" style={{ padding: 18, marginBottom: 16 }}>
        <div className="hd" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 17, fontWeight: 600 }}>Today · lifecycle</div>
          <div className="sub" style={{ fontSize: 13 }}>All times ET · NYSE calendar, regular close</div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {stages.map((s) => (
            <div key={s.time} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ height: 6, borderRadius: 3, background: stageColor(s.state) }} />
              <div className="mono" style={{ fontSize: 12, color: "var(--ink-70)" }}>{s.time} {s.label}</div>
              <div style={{ fontSize: 13, color: s.state === "done" ? "var(--yes)" : s.state === "live" ? "var(--accent-hi)" : "var(--ink-40)" }}>{s.status}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        {/* Markets & books */}
        <div className="card-2" style={{ flex: 1.3, overflow: "hidden" }}>
          <div className="hd" style={{ padding: "14px 18px", borderBottom: "1px solid var(--line-2)" }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>Markets &amp; books</div>
            <div className="sub" style={{ fontSize: 13 }}>OpenBook V2 · one book per strike</div>
          </div>
          <table>
            <thead><tr><th>Ticker</th><th style={{ textAlign: "right" }}>Strike</th><th style={{ textAlign: "right" }}>Phase</th><th style={{ textAlign: "right" }}>Open interest</th><th style={{ textAlign: "right" }}>Settle px</th></tr></thead>
            <tbody>
              {markets.length === 0 && <tr><td colSpan={5} className="sub" style={{ textAlign: "center", padding: 28 }}>No markets created yet.</td></tr>}
              {markets.slice().sort((a, b) => a.ticker.localeCompare(b.ticker) || Number(BigInt(a.strike_1e6) - BigInt(b.strike_1e6))).map((m) => {
                const ph = marketPhase(m);
                return (
                  <tr key={m.pubkey}>
                    <td style={{ fontWeight: 500 }}>{m.ticker}</td>
                    <td className="mono" style={{ textAlign: "right" }}>${strikeUsd(m.strike_1e6)}</td>
                    <td style={{ textAlign: "right", color: ph === "Trading" ? "var(--accent-hi)" : ph === "Settled" ? "var(--yes)" : "var(--ink-60)" }}>{ph}</td>
                    <td className="mono" style={{ textAlign: "right" }}>${usd(m.collateral_liability_atoms, 0)}</td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--ink-60)" }}>{m.settled_ts ? `$${(Number(BigInt(m.settlement_price_1e6)) / 1e6).toFixed(2)}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* right column */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card-2" style={{ padding: 18 }}>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 14 }}>Fee switches</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[["Taker fee", "applies to next day's books", false], ["Claim fee", "charged on redemption", false], ["Maker fee", "dormant on this venue", true]].map(([k, d, dim]) => (
                <div key={k as string} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 13px", borderRadius: 9, background: "var(--chip)", opacity: dim ? 0.65 : 1 }}>
                  <div><div style={{ fontSize: 14 }}>{k as string}</div><div className="sub" style={{ fontSize: 12 }}>{d as string}</div></div>
                  <div className="mono" style={{ fontSize: 16 }}>0 bps</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between" }} className="mono sub"><span>Treasury balance</span><span>$0.00</span></div>
          </div>

          <div style={{ borderRadius: 12, border: "1px solid oklch(0.40 0.10 60)", background: "oklch(0.22 0.03 60)", padding: 18 }}>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>Settlement override</div>
            <div style={{ fontSize: 14, color: "oklch(0.86 0.03 60)", lineHeight: 1.55 }}>Available only if the oracle still fails after the retry window. Guarded by a mandatory delay.</div>
            <div style={{ marginTop: 14, textAlign: "center", padding: 11, borderRadius: 9, border: "1px solid oklch(0.45 0.10 60)", fontSize: 14, color: "oklch(0.78 0.05 60)" }}>Locked</div>
          </div>

          <div className="card-2" style={{ padding: 18 }}>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 12 }}>Indexer &amp; automation</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }} className="mono">
              {[["Indexed slot", health ? String(health.indexed_slot) : "—"],
                ["Chain slot", health ? String(health.chain_slot) : "—"],
                ["Lag", health ? `${health.lag} slots` : "—"],
                ["State", health ? (health.complete ? "fresh ✓" : "recovering") : "offline"]].map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--ink-70)" }}><span>{k}</span><span style={{ color: k === "State" && health && !health.complete ? "oklch(0.82 0.13 75)" : undefined }}>{v}</span></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
