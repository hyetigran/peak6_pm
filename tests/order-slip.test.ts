import assert from "node:assert/strict";
import test from "node:test";

import {
  computeOrderSlip,
  normalizeOrderMode,
  resolveExpiryTimestamp,
  sanitizeMoneyInput,
  sanitizeSharesInput,
  type OrderSlipState,
} from "../frontend/lib/orderSlip.ts";

const baseState: OrderSlipState = {
  side: "Buy",
  mode: "Market",
  outcome: "YES",
  amount: "",
  shares: "",
  limitPrice: "50",
  expiry: "close",
};

const book = {
  bestAsk: 25,
  bestBid: 23,
  yesMark: 24,
};

const market = {
  closeTs: 2_000,
  connected: true,
  quoteReady: true,
  tradeable: true,
  now: 1_000,
};

test("market buy converts dollar amount into whole shares at the executable price", () => {
  const result = computeOrderSlip({
    state: { ...baseState, amount: "10" },
    book,
    balances: { usdc: 50, yesShares: 0, noShares: 0 },
    market,
  });

  assert.equal(result.inputKind, "amount");
  assert.equal(result.priceCents, 25);
  assert.equal(result.shares, 40);
  assert.equal(result.total, 10);
  assert.equal(result.disabled, false);
});

test("buy NO market mirrors the YES bid and validates the gross USDC needed to mint pairs", () => {
  const result = computeOrderSlip({
    state: { ...baseState, outcome: "NO", amount: "10" },
    book,
    balances: { usdc: 12, yesShares: 0, noShares: 0 },
    market,
  });

  assert.equal(result.priceCents, 77);
  assert.equal(result.shares, 12);
  assert.equal(result.total, 9.24);
  assert.equal(result.fundingRequired, 12);
  assert.equal(result.disabled, false);
});

test("limit buy NO disables when pair collateral exceeds available USDC", () => {
  const result = computeOrderSlip({
    state: { ...baseState, mode: "Limit", outcome: "NO", shares: "20", limitPrice: "35" },
    book,
    balances: { usdc: 12, yesShares: 0, noShares: 0 },
    market,
  });

  assert.equal(result.total, 7);
  assert.equal(result.fundingRequired, 20);
  assert.equal(result.disabled, true);
  assert.match(result.reason, /Insufficient USDC/);
});

test("connected wallet with zero SOL is blocked before trade submission", () => {
  const result = computeOrderSlip({
    state: { ...baseState, amount: "10" },
    book,
    balances: { usdc: 50, yesShares: 0, noShares: 0 },
    market: { ...market, solBalance: 0 },
  });

  assert.equal(result.disabled, true);
  assert.equal(result.tone, "danger");
  assert.match(result.reason, /Add SOL/);
});

test("sell flows validate against available outcome shares", () => {
  const result = computeOrderSlip({
    state: { ...baseState, side: "Sell", mode: "Market", shares: "6" },
    book,
    balances: { usdc: 100, yesShares: 5, noShares: 0 },
    market,
  });

  assert.equal(result.disabled, true);
  assert.match(result.reason, /Only 5 YES shares/);
});

test("sell flows wait for the quote account because fills receive USDC", () => {
  const result = computeOrderSlip({
    state: { ...baseState, side: "Sell", mode: "Market", shares: "4" },
    book,
    balances: { usdc: 0, yesShares: 5, noShares: 0 },
    market: { ...market, quoteReady: false },
  });

  assert.equal(result.disabled, true);
  assert.match(result.reason, /USDC account is still loading/);
});

test("sell NO normalizes to market mode because V1 has no sell-NO limit", () => {
  assert.equal(normalizeOrderMode({ side: "Sell", outcome: "NO", mode: "Limit" }), "Market");
});

test("limit expiry clamps before the market close", () => {
  assert.equal(resolveExpiryTimestamp("1h", 2_000, 1_000), 1_999);
  assert.equal(resolveExpiryTimestamp("30m", 5_000, 1_000), 2_800);
});

test("money input caps whole-dollar entry at nine digits", () => {
  assert.equal(sanitizeMoneyInput("1111111111"), "111111111");
  assert.equal(sanitizeMoneyInput("$123,456,789.45"), "123456789.45");
});

test("shares input caps entry at nine digits", () => {
  assert.equal(sanitizeSharesInput("1234567890"), "123456789");
  assert.equal(sanitizeSharesInput("12,345 shares"), "12345");
});
