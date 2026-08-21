export const INDEXER = process.env.NEXT_PUBLIC_INDEXER ?? "http://127.0.0.1:8787";

export interface Market {
  pubkey: string; ticker: string; ticker_id: number; trading_day: number;
  strike_1e6: string; mint_open_ts: number; trade_open_ts: number; close_ts: number;
  state: number; state_name: string; activity_started: number; paused: number;
  emergency_expired: number; settlement_price_1e6: string; outcome: number; outcome_name: string;
  settled_ts: number; yes_mint: string; no_mint: string; collateral_vault: string;
  openbook_market: string; bids: string; asks: string; event_heap: string;
  openbook_base_vault: string; openbook_quote_vault: string; collateral_liability_atoms: string;
}
export interface Health { indexed_slot: number; chain_slot: number; lag: number; complete: boolean; }

async function j<T>(path: string): Promise<T> {
  const r = await fetch(`${INDEXER}${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}
export const getMarkets = () => j<{ markets: Market[]; meta: Health }>("/markets");
export const getMarket = (pk: string) => j<Market>(`/markets/${pk}`);
export interface Book {
  bids: { price: number; shares: number }[]; asks: { price: number; shares: number }[];
  best_bid: number | null; best_ask: number | null; mark: number | null;
  yes_prob: number | null; no_prob: number | null;
  bid_owners: string[]; ask_owners: string[]; note?: string;
}
export const getBook = (pk: string) => j<Book>(`/book/${pk}`);
export const faucet = (address: string) =>
  fetch(`${INDEXER}/faucet/${address}`).then((r) => r.json());
export const getHealth = () => j<Health & { ok: boolean }>("/health");
export const getPortfolio = (wallet: string) =>
  j<{ owner: string; positions: any[] }>(`/portfolio/${wallet}`);

// --- Admin / Ops console ---
async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${INDEXER}${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? `${path} -> ${r.status}`);
  return d;
}
export const getAdminState = () => j<{ paused: boolean; error?: string }>("/admin/state");
export const setPause = (paused: boolean) => post<{ ok: boolean; paused: boolean; sig: string }>("/admin/pause", { paused });
export const settleMarket = (pk: string, price?: number) =>
  post<{ ok: boolean; sig: string; finalized: boolean; close_1e6: string }>(`/admin/settle/${pk}`, price != null ? { price } : {});
export const overrideSettle = (pk: string, price: number, reason = 1) =>
  post<{ ok: boolean; sig: string; finalized: boolean; close_1e6: string }>(`/admin/override/${pk}`, { price, reason });
export const settleAll = () =>
  post<{ ok: boolean; eligible: number; settled: number; errors: { market: string; error: string }[] }>("/admin/settle-all");

/** Market Phase — the user-visible projection (PRD), not raw MarketState. */
export function marketPhase(m: Market, now = Math.floor(Date.now() / 1000)): string {
  if (m.state_name === "Abandoned") return "Abandoned";
  if (m.state_name === "Settled") return "Settled";
  if (m.emergency_expired) return "Emergency expired";
  if (now >= m.close_ts) return m.settled_ts ? "Settled" : "Closed — awaiting settlement";
  if (m.paused) return "Paused";
  if (m.state_name === "Created" && now < m.mint_open_ts) return "Preparing";
  if (now < m.trade_open_ts) return "Minting";
  return "Trading";
}
