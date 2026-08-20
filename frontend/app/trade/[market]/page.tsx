"use client";
import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { getMarket, marketPhase, type Market } from "@/lib/api";
import { strikeUsd, usd, countdown } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import { useTokenBalance } from "@/components/useBalances";
import * as mx from "@/lib/meridian";

export default function Trade() {
  const { market: pk } = useParams<{ market: string }>();
  const { pubkey, connect, send, conn } = useWallet();
  const [m, setM] = useState<Market | null>(null);
  const [quoteMint, setQuoteMint] = useState<PublicKey | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [amount, setAmount] = useState("10");
  const [, force] = useState(0);

  useEffect(() => {
    const load = () => getMarket(pk).then(setM).catch(() => {});
    load(); const t = setInterval(() => { load(); force((x) => x + 1); }, 1000); return () => clearInterval(t);
  }, [pk]);

  useEffect(() => {
    conn.getAccountInfo(mx.configPda()).then((info) => {
      if (info) setQuoteMint(new PublicKey(info.data.subarray(8 + 2 + 32 * 8, 8 + 2 + 32 * 8 + 32)));
    }).catch(() => {});
  }, []);

  const yesBal = useTokenBalance(m?.yes_mint);
  const noBal = useTokenBalance(m?.no_mint);

  const guard = useCallback(async (fn: () => Promise<void>, label: string) => {
    if (!pubkey) return connect();
    setBusy(label); setMsg(null);
    try { await fn(); setMsg("Confirmed ✓"); }
    catch (e: any) { setMsg(e.message?.slice(0, 180) ?? "failed"); }
    finally { setBusy(""); }
  }, [pubkey, connect]);

  const ataIxsIfMissing = async (mints: PublicKey[]) => {
    const ixs = [] as any[];
    for (const mint of mints) {
      const ata = mx.ataFor(mint, pubkey!);
      if (!(await conn.getAccountInfo(ata))) ixs.push(mx.createAtaIx(pubkey!, pubkey!, mint));
    }
    return ixs;
  };

  if (!m) return <div className="wrap sub" style={{ padding: 40 }}>Loading market…</div>;
  const phase = marketPhase(m);
  const settled = phase === "Settled";
  const q = () => BigInt(Math.round(Number(amount || "0") * 1e6));
  const usdcAta = () => quoteMint ? mx.ataFor(quoteMint, pubkey!) : null;

  const mint = () => guard(async () => {
    const yesM = new PublicKey(m.yes_mint), noM = new PublicKey(m.no_mint);
    const pre = await ataIxsIfMissing([yesM, noM]);
    await send([...pre, mx.mintPairIx(pubkey!, new PublicKey(pk), q(), {
      yesMint: yesM, noMint: noM, collateralVault: new PublicKey(m.collateral_vault),
      userQuote: usdcAta()!, userYes: mx.ataFor(yesM, pubkey!), userNo: mx.ataFor(noM, pubkey!),
    })]);
  }, "mint");

  const redeemPair = () => guard(async () => {
    const yesM = new PublicKey(m.yes_mint), noM = new PublicKey(m.no_mint);
    await send([mx.redeemPairDirectIx(pubkey!, new PublicKey(pk), q(), {
      yesMint: yesM, noMint: noM, collateralVault: new PublicKey(m.collateral_vault),
      userQuote: usdcAta()!, userYes: mx.ataFor(yesM, pubkey!), userNo: mx.ataFor(noM, pubkey!),
    })]);
  }, "redeem");

  const redeemWin = () => guard(async () => {
    const winMint = new PublicKey(m.outcome_name === "Yes" ? m.yes_mint : m.no_mint);
    const bal = m.outcome_name === "Yes" ? yesBal : noBal;
    await send([mx.redeemWinningIx(pubkey!, new PublicKey(pk), winMint, {
      collateralVault: new PublicKey(m.collateral_vault), userWinning: mx.ataFor(winMint, pubkey!),
      userQuote: usdcAta()!, amount: bal,
    })]);
  }, "claim");

  const winBal = m.outcome_name === "Yes" ? yesBal : noBal;
  return (
    <div className="wrap" style={{ padding: "36px 24px", display: "grid", gridTemplateColumns: "1fr 380px", gap: 24 }}>
      <div>
        <div className="eyebrow">{m.ticker} · {m.trading_day}</div>
        <h1 style={{ marginTop: 8 }}>Will {m.ticker} close at or above ${strikeUsd(m.strike_1e6)}?</h1>
        <p className="sub" style={{ fontSize: 15 }}>
          One share pays <b>$1.00</b> if {m.ticker}&rsquo;s official close is at or above ${strikeUsd(m.strike_1e6)}, otherwise $0.
        </p>
        <div style={{ display: "flex", gap: 24, marginTop: 18 }}>
          <Stat label="Phase" value={phase} />
          {!settled && <Stat label="Settles in" value={countdown(m.close_ts)} mono />}
          {settled && <Stat label="Outcome" value={`${m.outcome_name} won`} accent={m.outcome_name === "Yes" ? "yes" : "no"} />}
          {settled && <Stat label="Official close" value={`$${(Number(BigInt(m.settlement_price_1e6)) / 1e6).toFixed(2)}`} mono />}
          <Stat label="Open interest" value={`$${usd(m.collateral_liability_atoms, 0)}`} mono />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 26 }}>
          <Perspective side="YES" bal={yesBal} accent="yes" strike={m.strike_1e6} above />
          <Perspective side="NO" bal={noBal} accent="no" strike={m.strike_1e6} />
        </div>
      </div>

      <div className="card" style={{ padding: 20, height: "fit-content", position: "sticky", top: 84 }}>
        <div className="eyebrow" style={{ marginBottom: 12 }}>Actions</div>
        <label className="sub" style={{ fontSize: 12 }}>Shares (whole tokens)</label>
        <input className="mono" value={amount} onChange={(e) => setAmount(e.target.value)} style={inp} />
        {!settled ? (
          <>
            <button className="btn btn-yes" style={full} disabled={!!busy} onClick={mint}>{busy === "mint" ? "…" : `Mint ${amount || 0} pairs · $${amount || 0}`}</button>
            <div className="sub" style={{ fontSize: 12, margin: "4px 0 10px" }}>{amount || 0} YES + {amount || 0} NO for ${amount || 0} — worth exactly $1 together.</div>
            <button className="btn btn-ghost" style={full} disabled={!!busy} onClick={redeemPair}>{busy === "redeem" ? "…" : `Redeem ${amount || 0} pairs → $${amount || 0}`}</button>
          </>
        ) : (
          <button className="btn btn-yes" style={full} disabled={!!busy || winBal === 0n} onClick={redeemWin}>{busy === "claim" ? "…" : `Claim ${usd(winBal.toString(), 0)} winning ${m.outcome_name} → USDC`}</button>
        )}
        {msg && <div className="mono" style={{ fontSize: 11.5, marginTop: 12, color: msg.includes("✓") ? "var(--pos)" : "var(--no)" }}>{msg}</div>}
        {!pubkey && <div className="sub" style={{ fontSize: 12, marginTop: 10 }}>Connect a wallet to trade.</div>}
      </div>
    </div>
  );
}

const inp: React.CSSProperties = { width: "100%", padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 8, margin: "6px 0 14px", fontSize: 15, fontFamily: "var(--mono)" };
const full: React.CSSProperties = { width: "100%", marginBottom: 8 };

function Stat({ label, value, mono, accent }: { label: string; value: string; mono?: boolean; accent?: "yes" | "no" }) {
  return <div><div className="eyebrow">{label}</div><div className={mono ? "mono" : ""} style={{ fontSize: 18, fontWeight: 600, marginTop: 3, color: accent ? `var(--${accent})` : undefined }}>{value}</div></div>;
}
function Perspective({ side, bal, accent, strike, above }: { side: string; bal: bigint; accent: "yes" | "no"; strike: string; above?: boolean }) {
  return (
    <div className="card" style={{ padding: 18, borderTop: `3px solid var(--${accent})` }}>
      <div className="hd"><h2 style={{ color: `var(--${accent})` }}>{side}</h2><span className={`pos-tag tag-${accent}`}>pays $1 if {above ? "≥" : "<"} ${strikeUsd(strike)}</span></div>
      <div style={{ marginTop: 14 }}>
        <div className="eyebrow">Your position</div>
        <div className="mono" style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>{usd(bal.toString(), 0)}<span className="sub" style={{ fontSize: 13, fontWeight: 400 }}> {side} shares</span></div>
      </div>
    </div>
  );
}
