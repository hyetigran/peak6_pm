"use client";
/**
 * Wallet layer with two modes:
 *  - External: any Standard Wallet (Phantom / Solflare / Backpack …) via the
 *    Solana wallet-adapter. This is the primary "Connect wallet" path.
 *  - Burner: a browser-managed localnet keypair (zero setup, self-funds via
 *    airdrop) as a fallback for quick demos.
 * Consumers use the same `useWallet()` interface regardless of mode.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
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

  useEffect(() => { if (!adapter.connected) setBurner(loadBurner()); }, [adapter.connected]);

  const external = adapter.connected && !!adapter.publicKey;
  const pubkey = external ? adapter.publicKey! : burner?.publicKey ?? null;

  const refresh = useCallback(async () => {
    if (!pubkey) return;
    try { setSol((await connection.getBalance(pubkey)) / 1e9); } catch {}
  }, [pubkey?.toBase58()]);
  useEffect(() => { if (pubkey) { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); } }, [pubkey?.toBase58()]);

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
    refresh();
    return sig;
  }, [pubkey?.toBase58(), external, adapter, connection, burner, refresh]);

  const value = useMemo<WalletCtx>(() => ({
    pubkey, sol, external, connect, connectBurner, disconnect, send, conn: connection, refresh,
  }), [pubkey?.toBase58(), sol, external, connect, connectBurner, disconnect, send, connection, refresh]);
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
