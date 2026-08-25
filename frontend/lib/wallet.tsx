"use client";
/**
 * Wallet layer with two modes:
 *  - External: any Standard Wallet (Phantom / Solflare / Backpack …) via the
 *    Solana wallet-adapter. This is the primary "Connect wallet" path.
 *  - Burner: a browser-managed localnet keypair (zero setup, self-funds via
 *    airdrop) as a fallback for quick demos.
 * Consumers use the same `useWallet()` interface regardless of mode.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { configPda, ataFor } from "@/lib/meridian";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { ConnectionProvider, WalletProvider as AdapterProvider, useConnection, useWallet as useAdapter } from "@solana/wallet-adapter-react";
import { WalletModalProvider, useWalletModal } from "@solana/wallet-adapter-react-ui";

const RPC = process.env.NEXT_PUBLIC_RPC ?? "http://127.0.0.1:8899";

interface WalletCtx {
  pubkey: PublicKey | null;
  sol: number;
  external: boolean;                 // true when a real wallet is connected
  connect: () => void;               // open the wallet modal (external)
  connectBurner: () => void;         // create/fund the localnet test wallet
  disconnect: () => void;
  send: (ixs: TransactionInstruction[], extraSigners?: Keypair[]) => Promise<string>;
  conn: Connection;
  refresh: () => Promise<void>;
  /** true while a transaction is being sent/confirmed — pollers back off */
  inFlight: boolean;
  /** quote (USDC) mint pinned in the on-chain Config; fetched once, shared */
  quoteMint: PublicKey | null;
  /** token balance of the wallet's ATA for `mint` (registers it with the shared poller) */
  watchMint: (mint: string) => void;
  balances: Record<string, bigint>;
}
const Ctx = createContext<WalletCtx | null>(null);
export const useWallet = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("WalletProvider missing");
  return c;
};

function loadBurner(): Keypair | null {
  if (typeof window === "undefined") return null;
  const s = localStorage.getItem("meridian_burner");
  return s ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s))) : null;
}

function Bridge({ children }: { children: React.ReactNode }) {
  const { connection } = useConnection();
  const adapter = useAdapter();
  const { setVisible } = useWalletModal();
  const [burner, setBurner] = useState<Keypair | null>(null);
  const [sol, setSol] = useState(0);
  const [inFlight, setInFlight] = useState(false);
  const [quoteMint, setQuoteMint] = useState<PublicKey | null>(null);
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const watched = useRef<Set<string>>(new Set());
  const [watchedVersion, bumpWatched] = useState(0);

  useEffect(() => { if (!adapter.connected) setBurner(loadBurner()); }, [adapter.connected]);

  const external = adapter.connected && !!adapter.publicKey;
  const pubkey = external ? adapter.publicKey! : burner?.publicKey ?? null;

  // Quote mint from Config: one read, shared by every component (retried until it lands).
  useEffect(() => {
    if (quoteMint) return;
    let stop = false;
    const load = () => connection.getAccountInfo(configPda()).then((info) => {
      if (stop) return;
      if (info) setQuoteMint(new PublicKey(info.data.subarray(8 + 2 + 32 * 8, 8 + 2 + 32 * 8 + 32)));
    }).catch(() => {});
    load(); const t = setInterval(load, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [connection, quoteMint]);

  // ONE batched read for SOL + every watched token ATA. Balances only move on
  // our own transactions (refresh() after send) or on fills against resting
  // orders, so a slow 10s cadence is plenty; hidden tabs and in-flight sends skip.
  const refresh = useCallback(async () => {
    if (!pubkey) return;
    const mints = [...watched.current];
    const keys = [pubkey, ...mints.map((m) => ataFor(new PublicKey(m), pubkey))];
    try {
      const infos = await connection.getMultipleAccountsInfo(keys);
      setSol((infos[0]?.lamports ?? 0) / 1e9);
      const next: Record<string, bigint> = {};
      mints.forEach((m, i) => { const info = infos[i + 1]; next[m] = info ? info.data.readBigUInt64LE(64) : 0n; });
      setBalances(next);
    } catch {}
  }, [pubkey?.toBase58(), connection, watchedVersion]);
  useEffect(() => {
    if (!pubkey) return;
    refresh();
    const t = setInterval(() => { if (document.visibilityState === "visible" && !inFlightRef.current) refresh(); }, 10_000);
    return () => clearInterval(t);
  }, [pubkey?.toBase58(), refresh]);
  const inFlightRef = useRef(false);
  const watchMint = useCallback((mint: string) => {
    if (watched.current.has(mint)) return;
    watched.current.add(mint); bumpWatched((v) => v + 1);
  }, []);

  const connect = useCallback(() => { setBurner(null); setVisible(true); }, [setVisible]);
  const connectBurner = useCallback(async () => {
    if (adapter.connected) await adapter.disconnect().catch(() => {});
    let k = loadBurner();
    if (!k) { k = Keypair.generate(); localStorage.setItem("meridian_burner", JSON.stringify([...k.secretKey])); }
    setBurner(k);
    try {
      if ((await connection.getBalance(k.publicKey)) < 1e9)
        await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, 5e9), "confirmed");
    } catch {}
    refresh();
  }, [adapter, connection, refresh]);
  const disconnect = useCallback(() => {
    if (adapter.connected) adapter.disconnect().catch(() => {});
    setBurner(null); setSol(0);
  }, [adapter]);

  const send = useCallback(async (ixs: TransactionInstruction[], extras: Keypair[] = []) => {
    if (!pubkey) throw new Error("connect a wallet first");
    inFlightRef.current = true; setInFlight(true);
    try {
    const tx = new Transaction().add(...ixs);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash; tx.feePayer = pubkey;
    if (extras.length) tx.partialSign(...extras);
    let raw: Buffer;
    if (external) {
      if (!adapter.signTransaction) throw new Error("wallet cannot sign");
      const signed = await adapter.signTransaction(tx);
      raw = signed.serialize();
    } else {
      tx.sign(burner!, ...extras);
      raw = tx.serialize();
    }
    // "fast"/load-balanced RPC endpoints route reads and preflight to different
    // backend nodes, so a just-issued blockhash can be momentarily unknown to
    // the preflight node ("Blockhash not found"). The signed bytes are reusable,
    // so resend the same tx — skipping preflight after the first clean
    // blockhash-only failure — until the hash propagates. Any other error (e.g.
    // insufficient funds) surfaces immediately from the first preflight.
    let sig: string | undefined, lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try { sig = await connection.sendRawTransaction(raw, { skipPreflight: attempt > 0 }); break; }
      catch (e: any) {
        lastErr = e;
        if (!/Blockhash not found/i.test(e?.message ?? "")) throw e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    if (!sig) throw lastErr;
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return sig;
    } finally {
      inFlightRef.current = false; setInFlight(false);
      refresh();
    }
  }, [pubkey?.toBase58(), external, adapter, connection, burner, refresh]);

  const value = useMemo<WalletCtx>(() => ({
    pubkey, sol, external, connect, connectBurner, disconnect, send, conn: connection, refresh,
    inFlight, quoteMint, watchMint, balances,
  }), [pubkey?.toBase58(), sol, external, connect, connectBurner, disconnect, send, connection, refresh, inFlight, quoteMint?.toBase58(), watchMint, balances]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// Cast around the @types/react FC-JSX mismatch between adapter deps.
const CP = ConnectionProvider as unknown as React.FC<any>;
const AP = AdapterProvider as unknown as React.FC<any>;
const WMP = WalletModalProvider as unknown as React.FC<any>;

export function WalletProvider({ children }: { children: React.ReactNode }) {
  return (
    <CP endpoint={RPC}>
      <AP wallets={[]} autoConnect>
        <WMP>
          <Bridge>{children}</Bridge>
        </WMP>
      </AP>
    </CP>
  );
}
