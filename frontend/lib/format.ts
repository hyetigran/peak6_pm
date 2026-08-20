export const cents = (priceLots: number) => `${priceLots}¢`;
export const usd = (atoms: bigint | string, dp = 2) => {
  const n = Number(BigInt(atoms)) / 1e6;
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
};
export const strikeUsd = (strike1e6: string) =>
  (Number(BigInt(strike1e6)) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
export const short = (pk: string) => `${pk.slice(0, 4)}…${pk.slice(-4)}`;
export function countdown(ts: number): string {
  const s = Math.max(0, ts - Math.floor(Date.now() / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
