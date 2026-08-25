"use client";
import { useEffect } from "react";
import { useWallet } from "@/lib/wallet";

/** Token balance of the wallet's ATA for `mint`, served by the wallet
 *  provider's single batched poll (no per-hook RPC calls). */
export function useTokenBalance(mint?: string) {
  const { watchMint, balances } = useWallet();
  useEffect(() => { if (mint) watchMint(mint); }, [mint, watchMint]);
  return mint ? balances[mint] ?? 0n : 0n;
}
