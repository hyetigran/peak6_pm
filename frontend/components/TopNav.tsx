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
  const { pubkey, sol, connect } = useWallet();
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    const t = setInterval(() => getHealth().then(setHealth).catch(() => setHealth(null)), 4000);
    getHealth().then(setHealth).catch(() => {});
    return () => clearInterval(t);
  }, []);
  const recovery = health && !health.complete;
  return (
    <>
      <nav className="nav">
        <div className="wrap nav-inner">
          <Link href="/" className="brand">Meridian</Link>
          <span className="badge">Devnet</span>
          <div className="nav-links">
            {LINKS.map(([href, label]) => (
              <Link key={href} href={href} className={path.startsWith(href) ? "active" : ""}>{label}</Link>
            ))}
          </div>
          <div className="nav-right">
            {pubkey ? (
              <>
                <button className="wallet-chip" onClick={() => faucet(pubkey.toBase58())} title="Mint 1000 test USDC (localnet)">+1000 USDC</button>
                <span className="wallet-chip"><span className="bal mono">{sol.toFixed(2)} SOL</span><span className="mono">{short(pubkey.toBase58())}</span></span>
              </>
            ) : (
              <button className="wallet-chip" onClick={connect}>Connect wallet</button>
            )}
          </div>
        </div>
      </nav>
      {recovery && (
        <div className="banner"><div className="wrap">
          Recovery-only Mode — indexed state is behind the chain (lag {health!.lag} slots). Exits stay open; new orders are held until state is fresh.
        </div></div>
      )}
    </>
  );
}
