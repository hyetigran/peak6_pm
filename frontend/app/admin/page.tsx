"use client";
import { useEffect, useState } from "react";
import { getMarkets, getHealth, getAdminState, getKeeper, getMarketMaker, setPause, settleMarket, overrideSettle, settleAll, marketPhase, type Market, type Health, type Keeper, type MarketMaker } from "@/lib/api";
import { strikeUsd, usd, countdown } from "@/lib/format";

type Stage = { time: string; label: string; status: string; state: "done" | "live" | "queued" };

export default function Admin() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [health, setHealth] = useState<(Health & { ok?: boolean }) | null>(null);
  const [paused, setPaused] = useState(false);
  const [keeper, setKeeper] = useState<Keeper | null>(null);
  const [mm, setMm] = useState<MarketMaker | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [settleTarget, setSettleTarget] = useState<Market | null>(null);
  const [settlePrice, setSettlePrice] = useState("");
  const [mode, setMode] = useState<"normal" | "override">("normal");
  const [, tick] = useState(0);
  useEffect(() => {
    const load = () => {
      getMarkets().then((d) => setMarkets(d.markets)).catch(() => {});
      getHealth().then(setHealth).catch(() => setHealth(null));
      getAdminState().then((s) => setPaused(s.paused)).catch(() => {});
      getKeeper().then(setKeeper).catch(() => setKeeper(null));
      getMarketMaker().then(setMm).catch(() => setMm(null));
    };
    load(); const t = setInterval(load, 3000); const c = setInterval(() => tick((x) => x + 1), 1000);
    return () => { clearInterval(t); clearInterval(c); };
  }, []);

  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); setMsg(r?.msg ?? `${label} ✓${r?.sig ? " · " + String(r.sig).slice(0, 8) : ""}`); }
    catch (e: any) { console.error(e); setMsg(`${label}: Something went wrong`); }
    finally { setBusy(false); }
  };
  const togglePause = () => run(paused ? "Resume" : "Pause minting", async () => {
    const r = await setPause(!paused); setPaused(r.paused); return r;
  });
  const openSettle = (m: Market) => { setSettleTarget(m); setSettlePrice(strikeUsd(m.strike_1e6)); setMode("normal"); setMsg(null); };
  const confirmSettle = () => run(mode === "override" ? "Override settle" : "Settle", async () => {
    const r = mode === "override"
      ? await overrideSettle(settleTarget!.pubkey, Number(settlePrice))
      : await settleMarket(settleTarget!.pubkey, Number(settlePrice));
    setSettleTarget(null); return r;
  });
  const settleEverything = () => run("Settle all closed", async () => {
    const r = await settleAll();
    return { msg: `Settled ${r.settled}/${r.eligible} closed market${r.eligible === 1 ? "" : "s"} ✓${r.errors.length ? ` · ${r.errors.length} failed` : ""}` };
  });

  const now = Date.now() / 1000;
  const n = markets.length;
  const minted = markets.filter((m) => now >= m.mint_open_ts).length;
  const trading = markets.filter((m) => marketPhase(m) === "Trading").length;
  const settled = markets.filter((m) => m.state_name === "Settled").length;
  const nextClose = markets.filter((m) => !m.settled_ts && m.close_ts > now).map((m) => m.close_ts).sort((a, b) => a - b)[0];
  const closeableMarkets = markets.filter((m) => !m.settled_ts && now >= m.close_ts && m.state_name !== "Abandoned");
  const openOverride = () => { const m = closeableMarkets[0]; if (!m) return; setSettleTarget(m); setSettlePrice(strikeUsd(m.strike_1e6)); setMode("override"); setMsg(null); };

  const stages: Stage[] = [
    { time: "roll", label: "strikes rolled out (+30m after close)", status: n ? `Done · ${n} strikes` : "Waiting", state: n ? "done" : "queued" },
    { time: "create", label: "markets created", status: n ? `Done · ${n} books attached` : "Waiting", state: n ? "done" : "queued" },
    { time: "open", label: "mint + trade open at creation", status: minted ? "Done" : "Queued", state: minted ? "done" : "queued" },
    { time: "live", label: "trading live", status: trading ? `In progress · ${nextClose ? countdown(nextClose) : "—"} to close` : settled === n && n ? "Closed" : "Queued", state: trading ? "live" : settled === n && n ? "done" : "queued" },
    { time: "16:00", label: "close, settle +20m", status: settled ? `${settled} / ${n} settled` : `Queued · ${n} markets`, state: settled === n && n ? "done" : settled ? "live" : "queued" },
    { time: "+5m", label: "next strikes roll", status: "Queued · continuous roll", state: "queued" },
  ];
  const stageColor = (s: Stage["state"]) => s === "done" ? "var(--yes)" : s === "live" ? "var(--accent)" : "var(--line)";

  return (
    <div className="wrap" style={{ padding: "26px 28px 48px" }}>
      <div className="hd" style={{ alignItems: "flex-end", marginBottom: 20 }}>
        <div>
          <h1>Ops console</h1>
          <p className="sub" style={{ marginTop: 2 }}>Daily lifecycle, oracle health, fee switches and the settlement override path.</p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {msg && <span className="mono" style={{ fontSize: 12, color: msg.includes("✓") ? "var(--pos)" : "var(--no)", maxWidth: 280, textAlign: "right" }}>{msg}</span>}
          <button className="btn btn-ghost" disabled={busy || closeableMarkets.length === 0} onClick={settleEverything} title={closeableMarkets.length ? "" : "No markets past close"}>Settle all closed{closeableMarkets.length ? ` (${closeableMarkets.length})` : ""}</button>
          <button className="btn" disabled={busy} onClick={togglePause} style={{ background: paused ? "var(--yes-soft)" : "oklch(0.30 0.09 60)", border: `1px solid ${paused ? "var(--yes-border)" : "oklch(0.45 0.12 60)"}`, color: "var(--ink)" }}>{busy ? "…" : paused ? "Resume minting" : "Pause minting"}</button>
        </div>
      </div>

      {paused && (
        <div style={{ padding: "11px 16px", borderRadius: 10, background: "oklch(0.30 0.09 60)", border: "1px solid oklch(0.45 0.12 60)", marginBottom: 16, fontSize: 14 }}>
          <b>Minting is paused.</b> <span className="sub" style={{ color: "oklch(0.88 0.04 60)" }}>Exits stay open — users can still sell, close, or redeem.</span>
        </div>
      )}

      {settleTarget && (
        <div className="card" style={{ padding: 16, marginBottom: 16, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", borderColor: mode === "override" ? "oklch(0.45 0.12 60)" : "var(--line)" }}>
          <div>
            <div className="eyebrow">{mode === "override" ? "Manual settlement override" : "Settle market"}</div>
            <div style={{ fontWeight: 600, marginTop: 2 }}>{settleTarget.ticker} &gt; ${strikeUsd(settleTarget.strike_1e6)}</div>
          </div>
          <div style={{ display: "flex", gap: 3, padding: 3, borderRadius: 9, background: "var(--chip)" }}>
            {(["normal", "override"] as const).map((mm) => (
              <button key={mm} onClick={() => setMode(mm)} style={{ padding: "6px 12px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 13, background: mode === mm ? "var(--accent)" : "transparent", color: mode === mm ? "var(--on-accent)" : "var(--ink-60)" }}>{mm === "normal" ? "Oracle" : "Override"}</button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="sub" style={{ fontSize: 13 }}>{mode === "override" ? "Evidenced close $" : "Official close $"}</span>
            <input className="mono" value={settlePrice} onChange={(e) => setSettlePrice(e.target.value)} style={{ width: 110, padding: "8px 10px", borderRadius: 8, background: "var(--chip)", border: "1px solid var(--line)", color: "var(--ink)", fontFamily: "var(--mono)" }} />
          </div>
          <span className="sub" style={{ fontSize: 13 }}>→ winner is {Number(settlePrice) >= Number(strikeUsd(settleTarget.strike_1e6)) ? <b style={{ color: "var(--yes)" }}>YES</b> : <b style={{ color: "var(--no)" }}>NO</b>}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setSettleTarget(null)}>Cancel</button>
            <button className="btn btn-yes" disabled={busy || !settlePrice} onClick={confirmSettle}>{busy ? "…" : mode === "override" ? "Override & settle" : "Confirm settle"}</button>
          </div>
        </div>
      )}

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
            <thead><tr><th>Ticker</th><th style={{ textAlign: "right" }}>Strike</th><th style={{ textAlign: "right" }}>Phase</th><th style={{ textAlign: "right" }}>OI</th><th style={{ textAlign: "right" }}>Settle px</th><th style={{ textAlign: "right" }}>Action</th></tr></thead>
            <tbody>
              {markets.length === 0 && <tr><td colSpan={6} className="sub" style={{ textAlign: "center", padding: 28 }}>No markets created yet.</td></tr>}
              {markets.slice().sort((a, b) => a.ticker.localeCompare(b.ticker) || Number(BigInt(a.strike_1e6) - BigInt(b.strike_1e6))).map((m) => {
                const ph = marketPhase(m);
                const closeable = !m.settled_ts && now >= m.close_ts && m.state_name !== "Abandoned";
                return (
                  <tr key={m.pubkey}>
                    <td style={{ fontWeight: 500 }}>{m.ticker}</td>
                    <td className="mono" style={{ textAlign: "right" }}>${strikeUsd(m.strike_1e6)}</td>
                    <td style={{ textAlign: "right", color: ph === "Trading" ? "var(--accent-hi)" : ph === "Settled" ? "var(--yes)" : "var(--ink-60)" }}>{ph}</td>
                    <td className="mono" style={{ textAlign: "right" }}>${usd(m.collateral_liability_atoms, 0)}</td>
                    <td className="mono" style={{ textAlign: "right", color: m.settled_ts ? (m.outcome_name === "Yes" ? "var(--yes)" : "var(--no)") : "var(--ink-60)" }}>{m.settled_ts ? `$${(Number(BigInt(m.settlement_price_1e6)) / 1e6).toFixed(2)}` : "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      {m.settled_ts ? <span className={`pos-tag ${m.outcome_name === "Yes" ? "tag-yes" : "tag-no"}`}>{m.outcome_name} won</span>
                        : closeable ? <button className="btn btn-yes" style={{ padding: "6px 12px", fontSize: 13 }} disabled={busy} onClick={() => openSettle(m)}>Settle</button>
                        : <span className="sub mono" style={{ fontSize: 12 }}>closes {countdown(m.close_ts)}</span>}
                    </td>
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
            <div className="sub" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.5 }}>Fees are disabled at the protocol level (ADR-0001/0007) — there is no on-chain fee switch to toggle.</div>
          </div>

          <div style={{ borderRadius: 12, border: "1px solid oklch(0.40 0.10 60)", background: "oklch(0.22 0.03 60)", padding: 18 }}>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>Settlement override</div>
            <div style={{ fontSize: 14, color: "oklch(0.86 0.03 60)", lineHeight: 1.55 }}>Override Authority path for when the oracle is unavailable. Requires two equal evidenced values; guarded on-chain by a mandatory delay after close.</div>
            {closeableMarkets.length > 0 ? (
              <button className="btn" disabled={busy} onClick={openOverride} style={{ marginTop: 14, width: "100%", background: "oklch(0.55 0.12 60)", color: "oklch(0.16 0.02 60)" }}>Open override · {closeableMarkets.length} eligible</button>
            ) : (
              <div style={{ marginTop: 14, textAlign: "center", padding: 11, borderRadius: 9, border: "1px solid oklch(0.45 0.10 60)", fontSize: 14, color: "oklch(0.78 0.05 60)" }}>Locked — no markets past close</div>
            )}
          </div>

          <div className="card-2" style={{ padding: 18 }}>
            <div className="hd" style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 17, fontWeight: 600 }}>Keeper &amp; indexer</div>
              <span className="pos-tag" style={{ background: keeper?.running ? "var(--yes-soft)" : "var(--no-soft)", color: keeper?.running ? "var(--yes-hi)" : "var(--no-hi)" }}>{keeper?.running ? "keeper online" : "keeper offline"}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }} className="mono">
              {[["Last heartbeat", keeper?.running ? `${keeper.age ?? 0}s ago` : "—"],
                ["Ticks", keeper?.ticks != null ? String(keeper.ticks) : "—"],
                ["Auto-settled", keeper?.settled_total != null ? String(keeper.settled_total) : "—"],
                ["Events cranked", keeper?.events_cranked != null ? String(keeper.events_cranked) : "—"],
                ["Keeper wallet SOL", keeper?.wallet_sol != null ? keeper.wallet_sol.toFixed(2) : "—"],
                ["Market-maker", mm?.running ? `online · ${mm.markets_quoted ?? 0} quoted · ${mm.orders_posted ?? 0} orders` : "offline"],
                ["Indexed slot", health ? String(health.indexed_slot) : "—"],
                ["Chain lag", health ? `${health.lag} slots` : "—"],
                ["Indexer state", health ? (health.complete ? "fresh ✓" : "recovering") : "offline"]].map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--ink-70)" }}><span>{k}</span><span style={{ color: k === "Indexer state" && health && !health.complete ? "oklch(0.82 0.13 75)" : undefined }}>{v}</span></div>
              ))}
            </div>
            {keeper?.actions && keeper.actions.length > 0 && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line-2)" }}>
                <div className="eyebrow" style={{ marginBottom: 6 }}>Recent keeper activity</div>
                {keeper.actions.slice().reverse().map((a, i) => (
                  <div key={i} className="mono" style={{ fontSize: 11.5, color: a.includes("failed") ? "var(--no)" : "var(--ink-60)", padding: "1px 0" }}>{a}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
