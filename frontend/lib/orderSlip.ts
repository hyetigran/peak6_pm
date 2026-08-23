export type Outcome = "YES" | "NO";
export type TradeSide = "Buy" | "Sell";
export type OrderMode = "Market" | "Limit";
export type OrderExpiry = "close" | "30m" | "1h" | "4h";
export type OrderInputKind = "amount" | "shares";

export interface OrderSlipState {
  side: TradeSide;
  mode: OrderMode;
  outcome: Outcome;
  amount: string;
  shares: string;
  limitPrice: string;
  expiry: OrderExpiry;
}

export interface OrderSlipBook {
  bestAsk: number | null;
  bestBid: number | null;
  yesMark: number | null;
}

export interface OrderSlipBalances {
  usdc: number;
  yesShares: number;
  noShares: number;
}

export interface OrderSlipMarketState {
  tradeable: boolean;
  connected: boolean;
  quoteReady: boolean;
  closeTs: number;
  now?: number;
}

export interface OrderSlipComputation {
  amount: number;
  availableShares: number;
  disabled: boolean;
  expiryTimestamp: number | null;
  fundingRequired: number;
  inputKind: OrderInputKind;
  maxProfit: number;
  mode: OrderMode;
  priceCents: number | null;
  reason: string;
  receive: number;
  shares: number;
  tone: "warning" | "danger";
  total: number;
  toWin: number;
}

const EXPIRY_SECONDS: Record<Exclude<OrderExpiry, "close">, number> = {
  "30m": 30 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
};

export const DOLLAR_QUICK_ADDS = [1, 5, 10, 100] as const;
export const SHARE_QUICK_ADDS = [5, 25, 100, 500] as const;
export const TOKEN_DECIMALS = 1_000_000;

export function unitsFromAtoms(atoms: bigint): number {
  return Number(atoms) / TOKEN_DECIMALS;
}

export function wholeSharesFromAtoms(atoms: bigint): number {
  return Math.floor(unitsFromAtoms(atoms));
}

export function sanitizeMoneyInput(value: string): string {
  const cleaned = value.replace(/[^0-9.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  const decimals = rest.join("").slice(0, 2);
  return rest.length ? `${whole}.${decimals}` : whole;
}

export function sanitizeSharesInput(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

export function sanitizePriceInput(value: string): string {
  const cleaned = sanitizeSharesInput(value);
  if (cleaned === "") return "";
  return String(clamp(Number(cleaned), 0, 99));
}

export function formatInputNumber(value: number, decimals = 2): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeOrderMode(state: Pick<OrderSlipState, "side" | "outcome" | "mode">): OrderMode {
  if (state.side === "Sell" && state.outcome === "NO") return "Market";
  return state.mode;
}

export function inputKindFor(side: TradeSide, mode: OrderMode): OrderInputKind {
  return side === "Buy" && mode === "Market" ? "amount" : "shares";
}

export function marketPriceCents(side: TradeSide, outcome: Outcome, book: OrderSlipBook): number | null {
  if (outcome === "YES") return side === "Buy" ? book.bestAsk : book.bestBid;
  if (side === "Buy") return book.bestBid == null ? null : 100 - book.bestBid;
  return book.bestAsk == null ? null : 100 - book.bestAsk;
}

export function defaultLimitPrice(outcome: Outcome, book: OrderSlipBook): number | null {
  if (outcome === "YES") return book.yesMark ?? book.bestAsk ?? book.bestBid;
  const yes = book.yesMark ?? book.bestBid ?? book.bestAsk;
  return yes == null ? null : 100 - yes;
}

export function resolveExpiryTimestamp(expiry: OrderExpiry, closeTs: number, now = Math.floor(Date.now() / 1000)): number | null {
  const marketCloseExpiry = closeTs - 1;
  if (marketCloseExpiry <= now) return null;
  if (expiry === "close") return marketCloseExpiry;
  return Math.min(marketCloseExpiry, now + EXPIRY_SECONDS[expiry]);
}

export function computeOrderSlip(input: {
  state: OrderSlipState;
  book: OrderSlipBook;
  balances: OrderSlipBalances;
  market: OrderSlipMarketState;
}): OrderSlipComputation {
  const mode = normalizeOrderMode(input.state);
  const inputKind = inputKindFor(input.state.side, mode);
  const amount = readPositiveNumber(input.state.amount);
  const inputShares = Math.floor(readPositiveNumber(input.state.shares));
  const limitPrice = readPositiveNumber(input.state.limitPrice);
  const priceCents = mode === "Market"
    ? marketPriceCents(input.state.side, input.state.outcome, input.book)
    : limitPrice;
  const priceDollars = (priceCents ?? 0) / 100;
  const shares = inputKind === "amount" && priceDollars > 0
    ? Math.floor(amount / priceDollars)
    : inputShares;
  const total = input.state.side === "Buy" ? shares * priceDollars : 0;
  const receive = input.state.side === "Sell" ? shares * priceDollars : 0;
  const toWin = shares;
  const maxProfit = input.state.side === "Buy" ? Math.max(0, toWin - total) : receive;
  const availableShares = input.state.outcome === "YES" ? input.balances.yesShares : input.balances.noShares;
  const fundingRequired = input.state.side === "Buy"
    ? input.state.outcome === "NO" ? shares : total
    : 0;
  const expiryTimestamp = mode === "Limit"
    ? resolveExpiryTimestamp(input.state.expiry, input.market.closeTs, input.market.now)
    : null;
  let reason = "";
  let tone: "warning" | "danger" = "warning";

  if (!input.market.tradeable) {
    reason = "Trading opens when the market is Active.";
  } else if (mode === "Market" && (!priceCents || priceCents <= 0 || priceCents >= 100)) {
    reason = "No executable depth is available for this market order.";
  } else if (mode === "Limit" && (priceCents == null || !Number.isFinite(priceCents) || priceCents <= 0 || priceCents >= 100)) {
    reason = "Set a limit price between 1c and 99c.";
  } else if (mode === "Limit" && expiryTimestamp == null) {
    reason = "Choose an expiry before the market close.";
  } else if (inputKind === "amount" && amount <= 0) {
    reason = "Enter a dollar amount to trade.";
  } else if (shares <= 0) {
    reason = inputKind === "amount"
      ? "Amount is too small for one whole share at this price."
      : "Enter shares to trade.";
  } else if (input.market.connected && !input.market.quoteReady) {
    reason = "USDC account is still loading.";
  } else if (input.market.connected && input.state.side === "Buy" && fundingRequired > input.balances.usdc + 0.000001) {
    reason = `Insufficient USDC. Need ${formatUsd(fundingRequired)} available.`;
    tone = "danger";
  } else if (input.market.connected && input.state.side === "Sell" && shares > availableShares) {
    reason = `Only ${availableShares} ${input.state.outcome} share${availableShares === 1 ? "" : "s"} available.`;
    tone = "danger";
  }

  return {
    amount,
    availableShares,
    disabled: Boolean(reason),
    expiryTimestamp,
    fundingRequired,
    inputKind,
    maxProfit,
    mode,
    priceCents: priceCents && Number.isFinite(priceCents) ? priceCents : null,
    reason,
    receive,
    shares,
    tone,
    total,
    toWin,
  };
}

export function maxBuyShares(balance: number, outcome: Outcome, priceCents: number | null): number {
  if (balance <= 0) return 0;
  if (outcome === "NO") return Math.floor(balance);
  if (!priceCents || priceCents <= 0) return 0;
  return Math.floor(balance / (priceCents / 100));
}

export function formatUsd(value: number, maximumFractionDigits = 2): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits,
  });
}

export function formatShares(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function readPositiveNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
