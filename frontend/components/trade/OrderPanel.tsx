"use client";
import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { marketPhase, type Market, type Book } from "@/lib/api";
import { strikeUsd, usd } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import { useTokenBalance } from "@/components/useBalances";
import * as mx from "@/lib/meridian";

export type Outcome = "YES" | "NO";
export type Side = "Buy" | "Sell";

/**
 * The order slip. Controlled on outcome/side so row-level Buy Yes / Buy No
 * buttons elsewhere on the page can drive it; everything else (order type,
 * price, size, wallet plumbing, submission) is internal.
 */
export function OrderPanel({ m, book, outcome, setOutcome, side, setSide }: {
  m: Market; book: Book | null;
  outcome: Outcome; setOutcome: (o: Outcome) => void;
  side: Side; setSide: (s: Side) => void;
}) {
  const { pubkey, connect, send, conn } = useWallet();
  const [quoteMint, setQuoteMint] = useState<PublicKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [market, setMarketOrder] = useState(false);
  const [price, setPrice] = useState("50");
  const [size, setSize] = useState("5");

  const pk = m.pubkey;

  // Quote (USDC) mint from the on-chain Config. Every trade references it, so a
  // one-shot fetch that swallows a transient RPC failure would leave the page
  // permanently unable to buy — poll until it lands, then stop.
  useEffect(() => {
    if (quoteMint) return;
    let stop = false;
    const load = () => conn.getAccountInfo(mx.configPda()).then((info) => {
      if (stop) return;
      if (info) setQuoteMint(new PublicKey(info.data.subarray(8 + 2 + 32 * 8, 8 + 2 + 32 * 8 + 32)));
    }).catch(() => {});
    load(); const t = setInterval(load, 3000); return () => { stop = true; clearInterval(t); };
  }, [quoteMint]);

  const yesBal = useTokenBalance(m.yes_mint);
  const noBal = useTokenBalance(m.no_mint);

  const usdcAta = () => {
    if (!quoteMint) throw new Error("quote mint not loaded — is NEXT_PUBLIC_RPC pointed at the right cluster and the market Config initialized?");
    return mx.ataFor(quoteMint, pubkey!);
  };
  const ensure = useCallback(async (mints: PublicKey[], needOo: boolean, obMarket?: PublicKey) => {
    const ixs: any[] = [];
    // always ensure the USDC (quote) ATA — every trade references it, and a
    // missing one fails with AccountNotInitialized (0xbc4)
    const all = quoteMint ? [quoteMint, ...mints] : mints;
    const seen = new Set<string>();
    for (const mint of all) {
      const key = mint.toBase58(); if (seen.has(key)) continue; seen.add(key);
      if (!(await conn.getAccountInfo(mx.ataFor(mint, pubkey!)))) ixs.push(mx.createAtaIx(pubkey!, pubkey!, mint));
    }
    if (needOo && obMarket && !(await conn.getAccountInfo(mx.ooAccountPda(pubkey!, 1)))) ixs.push(...mx.createOoIxs(pubkey!, obMarket));
    return ixs;
  }, [pubkey, quoteMint]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    if (!pubkey) return connect();
    setBusy(true); setMsg(null);
    try { await fn(); setMsg("Confirmed ✓"); }
    catch (e: any) { console.error(e); setMsg("Something went wrong"); }
    finally { setBusy(false); }
  }, [pubkey, connect]);

  const phase = marketPhase(m);
  const settled = phase === "Settled";
  const tradeable = phase === "Trading";
  const yesM = new PublicKey(m.yes_mint), noM = new PublicKey(m.no_mint);
  const obMarket = new PublicKey(m.openbook_market);
  const sz = () => BigInt(Math.max(0, Math.floor(Number(size || "0"))));
  const pxLots = () => BigInt(Math.max(1, Math.floor(Number(price || "0"))));
  const yesPx = book?.mark ?? null;

  const submit = () => guard(async () => {
    const q = sz(); if (q === 0n) throw new Error("size must be a whole number of shares");
    const oo = mx.ooAccountPda(pubkey!, 1);
    const baseVault = new PublicKey(m.openbook_base_vault), quoteVault = new PublicKey(m.openbook_quote_vault);

    if (outcome === "YES") {
      if (side === "Buy" && !market) { // rest a bid, funded by USDC
        const pre = await ensure([yesM, noM], true, obMarket);
        await send([...pre, mx.placeLimitOrderIx({ user: pubkey!, market: new PublicKey(pk), ooAccount: oo, userTokenAccount: usdcAta()!, obMarket, bids: new PublicKey(m.bids), asks: new PublicKey(m.asks), eventHeap: new PublicKey(m.event_heap), marketVault: quoteVault, side: mx.Side.Bid, priceLots: pxLots(), baseLots: q })]);
      } else if (side === "Sell" && !market) { // rest an ask, funded by YES
        const pre = await ensure([yesM], true, obMarket);
        await send([...pre, mx.placeLimitOrderIx({ user: pubkey!, market: new PublicKey(pk), ooAccount: oo, userTokenAccount: mx.ataFor(yesM, pubkey!), obMarket, bids: new PublicKey(m.bids), asks: new PublicKey(m.asks), eventHeap: new PublicKey(m.event_heap), marketVault: baseVault, side: mx.Side.Ask, priceLots: pxLots(), baseLots: q })]);
      } else { // market take
        const isBuy = side === "Buy";
        const owners = (isBuy ? book?.ask_owners : book?.bid_owners) ?? [];
        const px = isBuy ? BigInt(book?.best_ask ?? 99) : BigInt(book?.best_bid ?? 1);
        const pre = await ensure([yesM, noM], false, obMarket);
        await send([...pre, mx.placeTakeOrderIx({ user: pubkey!, market: new PublicKey(pk), obMarket, bids: new PublicKey(m.bids), asks: new PublicKey(m.asks), baseVault, quoteVault, eventHeap: new PublicKey(m.event_heap), userBase: mx.ataFor(yesM, pubkey!), userQuote: usdcAta()!, makerOos: owners.map((o) => new PublicKey(o)), side: isBuy ? mx.Side.Bid : mx.Side.Ask, priceLots: px, baseLots: q })]);
      }
    } else { // NO
      if (side === "Buy") { // mint q pairs + rest a Sell-YES ask at (100 - noPrice)
        const pre = await ensure([yesM, noM], true, obMarket);
        const yesAsk = 100n - pxLots();
        await send([...pre,
          mx.mintPairIx(pubkey!, new PublicKey(pk), q * 1_000_000n, { yesMint: yesM, noMint: noM, collateralVault: new PublicKey(m.collateral_vault), userQuote: usdcAta()!, userYes: mx.ataFor(yesM, pubkey!), userNo: mx.ataFor(noM, pubkey!) }),
          mx.placeLimitOrderIx({ user: pubkey!, market: new PublicKey(pk), ooAccount: oo, userTokenAccount: mx.ataFor(yesM, pubkey!), obMarket, bids: new PublicKey(m.bids), asks: new PublicKey(m.asks), eventHeap: new PublicKey(m.event_heap), marketVault: baseVault, side: mx.Side.Ask, priceLots: yesAsk > 0n ? yesAsk : 1n, baseLots: q }),
        ]);
      } else { // Sell NO — market-assisted: redeem_no_via_market (buys Yes from asks)
        const owners = (book?.ask_owners ?? []).map((o) => new PublicKey(o));
        const px = BigInt(book?.best_ask ?? 99);
        const pre = await ensure([yesM, noM], false, obMarket);
        await send([...pre, mx.createTradeAtaIx(pubkey!, new PublicKey(pk), yesM),
          mx.redeemNoViaMarketIx(pubkey!, { market: new PublicKey(pk), yesMint: yesM, noMint: noM, collateralVault: new PublicKey(m.collateral_vault), userQuote: usdcAta()!, userNo: mx.ataFor(noM, pubkey!), obMarket, bids: new PublicKey(m.bids), asks: new PublicKey(m.asks), baseVault, quoteVault, eventHeap: new PublicKey(m.event_heap), makerOos: owners, qLots: q, priceLots: px })]);
      }
    }
  });

  const winBal = m.outcome_name === "Yes" ? yesBal : noBal;
  const redeemWin = () => guard(async () => {
    const winMint = new PublicKey(m.outcome_name === "Yes" ? m.yes_mint : m.no_mint);
    await send([mx.redeemWinningIx(pubkey!, new PublicKey(pk), winMint, { collateralVault: new PublicKey(m.collateral_vault), userWinning: mx.ataFor(winMint, pubkey!), userQuote: usdcAta()!, amount: winBal })]);
  });

  // ---- derived UI values ----
  const noPx = yesPx != null ? 100 - yesPx : null;
  const noSellLimit = outcome === "NO" && side === "Sell"; // market-only
  const shareN = Math.max(0, Math.floor(Number(size || "0")));
  const pxNum = Math.max(0, Math.floor(Number(price || "0")));
  const buying = side === "Buy";
  const unitCents = outcome === "YES"
    ? (market ? (buying ? book?.best_ask ?? pxNum : book?.best_bid ?? pxNum) : pxNum)
    : (buying ? 100 - pxNum : noPx != null ? 100 - (book?.best_ask ?? 100 - noPx) : pxNum);
  const notional = (shareN * (unitCents || 0)) / 100;
  const winClause = outcome === "YES" ? "at or above" : "below";

  return (
    <div className="card" style={{ padding: 18, height: "fit-content", position: "sticky", top: 84, display: "flex", flexDirection: "column", gap: 14 }}>
      {!settled ? (
        <>
          <div style={{ display: "flex", gap: 3, padding: 3, borderRadius: 10, background: "var(--chip)" }}>
            {(["Buy", "Sell"] as Side[]).map((sd) => (<button key={sd} onClick={() => setSide(sd)} style={seg(side === sd)}>{sd}</button>))}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {(["YES", "NO"] as Outcome[]).map((o) => {
              const on = outcome === o, c = o === "YES" ? "yes" : "no";
              return (
                <button key={o} onClick={() => setOutcome(o)} style={{ flex: 1, textAlign: "center", padding: "12px 0", borderRadius: 10, cursor: "pointer", background: on ? `var(--${c}-soft)` : "var(--chip)", border: `1px solid ${on ? `var(--${c}-border)` : "transparent"}`, color: "var(--ink)" }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: `var(--${c}-hi)` }}>{o}</div>
                  <div className="mono" style={{ fontSize: 18, marginTop: 2 }}>{(o === "YES" ? yesPx : noPx) ?? "—"}¢</div>
                </button>
              );
            })}
          </div>
          {/* Market/Limit row always occupies the same slot so the slip never shifts. For NO the
              mode is fixed (Buy NO = limit, Sell NO = market), so the tabs show it but are inert. */}
          {(() => {
            const yes = outcome === "YES";
            const effMarket = yes ? market : noSellLimit;
            return (
              <div style={{ display: "flex", gap: 16, fontSize: 14, opacity: yes ? 1 : 0.55 }} aria-disabled={!yes}>
                {[["Market", effMarket], ["Limit", !effMarket]].map(([label, on]) => (
                  <div key={label as string} onClick={yes ? () => setMarketOrder(label === "Market") : undefined} style={{ cursor: yes ? "pointer" : "default", paddingBottom: 5, color: on ? "var(--ink)" : "var(--ink-60)", borderBottom: `2px solid ${on ? "var(--accent)" : "transparent"}` }}>{label as string}</div>
                ))}
              </div>
            );
          })()}
          {/* price / mode slot — same height in every mode so the CTA never jumps */}
          {noSellLimit ? (
            <div>
              <div className="sub" style={{ fontSize: 13, marginBottom: 6 }}>Price</div>
              <div style={{ ...slotBox, opacity: 0.6 }}><span className="sub" style={slotNote}>Sell No is market-only — buys Yes & redeems the pair.</span></div>
            </div>
          ) : (!market || outcome === "NO") ? (
            <div>
              <div className="sub" style={{ fontSize: 13, marginBottom: 6 }}>Limit price (¢)</div>
              <div style={{ gap: 8, ...slotBox }}>
                <input className="mono" value={price} onChange={(e) => setPrice(e.target.value)} style={bareInput} />
                <span className="sub" style={{ fontSize: 15 }}>¢</span>
                <span className="sub" style={{ marginLeft: "auto", fontSize: 12 }}>expires 16:00 ET</span>
              </div>
            </div>
          ) : (
            <div>
              <div className="sub" style={{ fontSize: 13, marginBottom: 6 }}>Price</div>
              <div style={{ ...slotBox, opacity: 0.6 }}><span className="sub" style={slotNote}>Market order — fills at the best available price.</span></div>
            </div>
          )}

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }} className="sub"><span>Shares</span><span>1 share pays $1.00</span></div>
            <div style={fieldBox}><input className="mono" value={size} onChange={(e) => setSize(e.target.value)} style={{ ...bareInput, fontSize: 20 }} /></div>
            <div style={{ display: "flex", gap: 7, marginTop: 8 }}>
              {["5", "25", "100", "500"].map((p) => (<div key={p} onClick={() => setSize(p)} style={{ padding: "6px 13px", borderRadius: 16, fontSize: 13, cursor: "pointer", background: "var(--chip)", color: "var(--ink-70)" }}>{p}</div>))}
            </div>
          </div>

          <div style={{ padding: 14, borderRadius: 11, background: "var(--accent-soft)", border: "1px solid var(--accent-border)", fontSize: 15, lineHeight: 1.55 }}>
            {buying ? "You pay " : "You receive ~"}<b>${notional.toFixed(2)}</b> {buying ? "for" : "from"} {shareN} {outcome}.<br />
            You win <b>${shareN.toFixed(2)}</b> if {m.ticker} closes {winClause} ${strikeUsd(m.strike_1e6)}.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "7px 8px", fontSize: 13 }} className="mono">
            <span className="sub">Avg fill price</span><span>{unitCents || "—"}¢</span>
            <span className="sub">Max profit</span><span style={{ color: "var(--pos)" }}>+${buying ? Math.max(0, shareN - notional).toFixed(2) : notional.toFixed(2)}</span>
            <span className="sub">Fees</span><span>0 bps</span>
            <span className="sub">Approvals</span><span>1 signature</span>
          </div>

          <button className={`btn ${outcome === "NO" && side === "Sell" ? "btn-no" : "btn-yes"}`} style={{ padding: 15, fontSize: 16 }} disabled={busy || !tradeable} onClick={submit}>
            {busy ? "…" : `${side} ${outcome} · ${shareN} share${shareN === 1 ? "" : "s"}`}
          </button>
          {!tradeable && <div className="sub" style={{ fontSize: 12 }}>Trading opens when the market is Active.</div>}
        </>
      ) : (
        <button className="btn btn-yes" style={{ padding: 15, fontSize: 16 }} disabled={busy || winBal === 0n} onClick={redeemWin}>Claim {usd(winBal.toString(), 0)} winning {m.outcome_name} → USDC</button>
      )}
      {msg && <div className="mono" style={{ fontSize: 11, color: msg.includes("✓") ? "var(--pos)" : "var(--no)" }}>{msg}</div>}
      {!pubkey && <div className="sub" style={{ fontSize: 12 }}>Connect a wallet to trade.</div>}

      <div style={{ padding: 12, borderRadius: 10, background: "var(--chip)" }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Your position</div>
        {yesBal > 0n || noBal > 0n ? (
          <div className="mono" style={{ fontSize: 14 }}>
            {yesBal > 0n && <div style={{ color: "var(--yes-hi)" }}>{usd(yesBal.toString(), 0)} YES</div>}
            {noBal > 0n && <div style={{ color: "var(--no-hi)" }}>{usd(noBal.toString(), 0)} NO</div>}
          </div>
        ) : <div className="sub" style={{ fontSize: 13 }}>No position on this strike.</div>}
      </div>
    </div>
  );
}

const seg = (on: boolean): React.CSSProperties => ({ flex: 1, textAlign: "center", padding: 9, borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: "pointer", border: "none", background: on ? "var(--accent)" : "transparent", color: on ? "var(--on-accent)" : "var(--ink-60)" });
const fieldBox: React.CSSProperties = { padding: "12px 14px", borderRadius: 10, background: "var(--chip)", border: "1px solid var(--line)", display: "flex", alignItems: "center" };
// price / mode slot: fixed height so swapping input <-> note never moves the rows below
const slotBox: React.CSSProperties = { ...fieldBox, height: 50, padding: "0 14px", boxSizing: "border-box" };
const slotNote: React.CSSProperties = { fontSize: 12.5, lineHeight: 1.3 };
const bareInput: React.CSSProperties = { flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "var(--ink)", fontSize: 19, fontFamily: "var(--mono)", padding: 0 };
