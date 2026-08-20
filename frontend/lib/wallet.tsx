"use client";
/**
 * Localnet burner wallet — the demo generates and persists a keypair, airdrops
 * SOL, and signs transactions directly. On a real deployment this is where a
 * wallet-adapter provider goes; for the localnet demo a burner makes the flow
 * work with zero external setup.
 */
import React, { createContext, useContext, useEffect, useState } from "react";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

const RPC = process.env.NEXT_PUBLIC_RPC ?? "http://127.0.0.1:8899";

interface WalletCtx {
  pubkey: PublicKey | null;
  sol: number;
  connect: () => void;
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

function loadKeypair(): Keypair | null {
  if (typeof window === "undefined") return null;
  const s = localStorage.getItem("meridian_burner");
  if (s) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
  return null;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const conn = new Connection(RPC, "confirmed");
  const [kp, setKp] = useState<Keypair | null>(null);
  const [sol, setSol] = useState(0);

  useEffect(() => { setKp(loadKeypair()); }, []);

  const refresh = async () => {
    if (!kp) return;
    try { setSol((await conn.getBalance(kp.publicKey)) / 1e9); } catch {}
  };
  useEffect(() => { if (kp) { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); } }, [kp?.publicKey.toBase58()]);

  const connect = async () => {
    let k = loadKeypair();
    if (!k) {
      k = Keypair.generate();
      localStorage.setItem("meridian_burner", JSON.stringify([...k.secretKey]));
    }
    setKp(k);
    try {
      const bal = await conn.getBalance(k.publicKey);
      if (bal < 1e9) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 5e9), "confirmed");
    } catch {}
    refresh();
  };

  const send = async (ixs: TransactionInstruction[], extra: Keypair[] = []) => {
    if (!kp) throw new Error("connect first");
    const tx = new Transaction().add(...ixs);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash; tx.feePayer = kp.publicKey;
    tx.sign(kp, ...extra);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    refresh();
    return sig;
  };

  return <Ctx.Provider value={{ pubkey: kp?.publicKey ?? null, sol, connect, send, conn, refresh }}>{children}</Ctx.Provider>;
}
