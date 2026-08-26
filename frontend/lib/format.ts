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

/** Label a `trading_day` integer (20260827) as "August 27".
 *
 *  timeZone: "UTC" is REQUIRED and not incidental. `day` is a bare calendar
 *  date with no time or zone; Date.UTC turns it into midnight UTC, and
 *  formatting THAT in the viewer's local zone rolls it back a day everywhere
 *  west of UTC — a 20260827 session rendered as "August 26" in New York and
 *  Chicago, i.e. a market appearing to ask about a session that already closed.
 */
export function tradingDayLabel(day: number, opts: Intl.DateTimeFormatOptions = { month: "long", day: "numeric" }) {
  const year = Math.floor(day / 10000);
  const month = Math.floor(day / 100) % 100;
  const date = day % 100;
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

/** True when `day` (a trading_day integer) is the current date in US market time. */
export function isTodayET(day: number): boolean {
  const nowET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
  return Number(nowET.replace(/-/g, "")) === day;
}
