"use client";
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@/lib/wallet";

export function useTokenBalance(mint?: string) {
  const { pubkey, conn } = useWallet();
  const [bal, setBal] = useState<bigint>(0n);
  useEffect(() => {
    if (!pubkey || !mint) return;
    const ata = PublicKey.findProgramAddressSync(
      [pubkey.toBuffer(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(), new PublicKey(mint).toBuffer()],
      new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))[0];
    const load = async () => {
      const info = await conn.getAccountInfo(ata);
      setBal(info ? info.data.readBigUInt64LE(64) : 0n);
    };
    load(); const t = setInterval(load, 3000); return () => clearInterval(t);
  }, [pubkey?.toBase58(), mint]);
  return bal;
}
