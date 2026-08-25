"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useState } from "react";
import { useTokenBalance } from "@/components/useBalances";
import { useWallet } from "@/lib/wallet";
import { getHealth, getAdminState, type Health } from "@/lib/api";
import { short, usd } from "@/lib/format";
import * as mx from "@/lib/meridian";

const LINKS = [["/markets", "Markets"], ["/portfolio", "Portfolio"], ["/history", "History"], ["/admin", "Admin"]];

export function TopNav() {
  const path = usePathname();
  const { pubkey, conn, connect, connectBurner, disconnect } = useWallet();
  const [health, setHealth] = useState<Health | null>(null);
  const [paused, setPaused] = useState(false);
  const [open, setOpen] = useState(false);
  const [quoteMint, setQuoteMint] = useState<string | null>(null);

  useEffect(() => {
    const poll = () => {
      getHealth().then(setHealth).catch(() => setHealth(null));
      getAdminState().then((s) => setPaused(s.paused)).catch(() => {});
    };
    poll(); const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (quoteMint) return;
    let stop = false;
    const load = () => conn.getAccountInfo(mx.configPda()).then((info) => {
      if (stop) return;
      if (info) setQuoteMint(new PublicKey(info.data.subarray(8 + 2 + 32 * 8, 8 + 2 + 32 * 8 + 32)).toBase58());
    }).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [conn, quoteMint]);

  const quoteBal = useTokenBalance(quoteMint ?? undefined);
  const recovery = health && !health.complete;
  // The landing page carries its own header.
  if (path === "/") return null;
  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          <Link href="/" className="brand"><span className="brand-mark" />Meridian</Link>
          <div className="nav-links">
            {LINKS.map(([href, label]) => (
              <Link key={href} href={href} className={path.startsWith(href) ? "active" : ""}>{label}</Link>
            ))}
          </div>
          <div className="nav-right">
            <span className="badge"><span className="dot" />Devnet</span>
            {pubkey ? (
              <>
                <a className="wallet-chip" href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Faucet</a>
                <div style={{ position: "relative" }}>
                  <button className="wallet-chip" onClick={() => setOpen((o) => !o)}>
                    <span className="bal mono">{quoteMint ? `${usd(quoteBal, 2)} USDC` : "USDC --"}</span>
                    <span className="mono">{short(pubkey.toBase58())}</span>
                  </button>
                  {open && (
                    <div className="card" style={{ position: "absolute", right: 0, top: 46, padding: 8, minWidth: 180, zIndex: 30 }}>
                      <button className="btn btn-ghost" style={{ width: "100%", marginBottom: 6, fontSize: 13 }} onClick={() => { setOpen(false); connect(); }}>Switch wallet</button>
                      <button className="btn btn-ghost" style={{ width: "100%", fontSize: 13 }} onClick={() => { setOpen(false); disconnect(); }}>Disconnect</button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ position: "relative" }}>
                <button className="addr-chip" onClick={() => setOpen((o) => !o)}>Connect wallet</button>
                {open && (
                  <div className="card" style={{ position: "absolute", right: 0, top: 48, padding: 8, minWidth: 220, zIndex: 30 }}>
                    <button className="btn btn-yes" style={{ width: "100%", marginBottom: 6, fontSize: 13 }} onClick={() => { setOpen(false); connect(); }}>Browser wallet (Phantom …)</button>
                    <button className="btn btn-ghost" style={{ width: "100%", fontSize: 13 }} onClick={() => { setOpen(false); connectBurner(); }}>Use a test wallet</button>
                    <div className="sub" style={{ fontSize: 11, marginTop: 8, padding: "0 2px" }}>Point your wallet at localhost:8899. The test wallet self-funds SOL.</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </nav>
      {paused && (
        <div className="banner"><div className="wrap">
          <b>Minting paused by admin.</b> Exits stay open — you can always sell, close, or redeem.
        </div></div>
      )}
      {recovery && (
        <div className="banner"><div className="wrap">
          <b>Market list may be stale</b> — the indexer hasn't updated{health!.seconds_since_ingest != null ? ` in ${Math.round(health!.seconds_since_ingest / 60)} min` : ""}. Books, marks and your positions are read live from chain; trading is unaffected.
        </div></div>
      )}
    </>
  );
}
