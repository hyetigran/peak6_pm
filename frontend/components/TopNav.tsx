"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useWallet } from "@/lib/wallet";
import { getHealth, faucet, type Health } from "@/lib/api";
import { short } from "@/lib/format";

const LINKS = [["/markets", "Markets"], ["/portfolio", "Portfolio"], ["/history", "History"]];

export function TopNav() {
  const path = usePathname();
  const { pubkey, sol, external, connect, connectBurner, disconnect } = useWallet();
  const [health, setHealth] = useState<Health | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const t = setInterval(() => getHealth().then(setHealth).catch(() => setHealth(null)), 4000);
    getHealth().then(setHealth).catch(() => {});
    return () => clearInterval(t);
  }, []);
  const recovery = health && !health.complete;
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
                <button className="wallet-chip" onClick={() => faucet(pubkey.toBase58())} title="Mint 1000 test USDC (localnet)">+1000 USDC</button>
                <div style={{ position: "relative" }}>
                  <button className="wallet-chip" onClick={() => setOpen((o) => !o)}>
                    <span className="badge sm" style={{ background: external ? "var(--yes-soft)" : "var(--chip-2)", color: external ? "var(--yes-hi)" : "var(--ink-60)" }}>{external ? "Wallet" : "Test"}</span>
                    <span className="bal mono">{sol.toFixed(2)} SOL</span>
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
      {recovery && (
        <div className="banner"><div className="wrap">
          <b>Recovery-only Mode</b> — indexed state is behind the chain (lag {health!.lag} slots). Exits stay open; new orders are held until state is fresh.
        </div></div>
      )}
    </>
  );
}
