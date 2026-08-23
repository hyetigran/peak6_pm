"use client";

import type { ReactNode } from "react";
import {
  DOLLAR_QUICK_ADDS,
  SHARE_QUICK_ADDS,
  clamp,
  computeOrderSlip,
  defaultLimitPrice,
  formatInputNumber,
  formatShares,
  formatUsd,
  marketPriceCents,
  maxBuyShares,
  normalizeOrderMode,
  sanitizeMoneyInput,
  sanitizePriceInput,
  sanitizeSharesInput,
  type OrderExpiry,
  type OrderMode,
  type OrderSlipBalances,
  type OrderSlipBook,
  type OrderSlipMarketState,
  type OrderSlipState,
  type Outcome,
  type TradeSide,
} from "@/lib/orderSlip";

const EXPIRY_OPTIONS: { value: OrderExpiry; label: string }[] = [
  { value: "close", label: "Market close" },
  { value: "30m", label: "30 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "4h", label: "4 hours" },
];

export interface OrderSlipProps {
  balances: OrderSlipBalances;
  book: OrderSlipBook;
  busy: boolean;
  connected: boolean;
  market: {
    closeTs: number;
    question: string;
    strikeLabel: string;
    ticker: string;
    tradingDay: number;
  };
  message: string | null;
  onChange: (patch: Partial<OrderSlipState>) => void;
  onConnect: () => void;
  onRedeem: () => void;
  onSubmit: () => void;
  quoteReady: boolean;
  redeemDisabled: boolean;
  redeemLabel: string;
  settled: boolean;
  state: OrderSlipState;
  tradeable: boolean;
  winningOutcome: string;
}

export function OrderSlip({
  balances,
  book,
  busy,
  connected,
  market,
  message,
  onChange,
  onConnect,
  onRedeem,
  onSubmit,
  quoteReady,
  redeemDisabled,
  redeemLabel,
  settled,
  state,
  tradeable,
  winningOutcome,
}: OrderSlipProps) {
  const marketState: OrderSlipMarketState = {
    closeTs: market.closeTs,
    connected,
    quoteReady,
    tradeable,
  };
  const computed = computeOrderSlip({ state, book, balances, market: marketState });
  const activeMode = computed.mode;
  const activePrice = activeMode === "Market"
    ? marketPriceCents(state.side, state.outcome, book)
    : computed.priceCents;
  const noPrice = book.yesMark == null ? null : 100 - book.yesMark;
  const validationText = connected ? computed.reason : "Connect a wallet to trade with live balances.";
  const actionDisabled = busy || (connected ? computed.disabled : !tradeable);
  const actionLabel = !connected
    ? "Connect wallet to trade"
    : busy
      ? "Submitting..."
      : `${state.side} ${state.outcome} · ${computed.shares} share${computed.shares === 1 ? "" : "s"}`;

  const patch = (nextPatch: Partial<OrderSlipState>) => {
    const next = { ...state, ...nextPatch };
    onChange({ ...nextPatch, mode: normalizeOrderMode(next) });
  };
  const setOutcome = (outcome: Outcome) => {
    const suggested = defaultLimitPrice(outcome, book);
    patch({
      outcome,
      limitPrice: suggested == null ? state.limitPrice : String(Math.round(suggested)),
    });
  };
  const setSide = (side: TradeSide) => patch({ side, amount: "", shares: "" });
  const setMode = (mode: OrderMode) => patch({ mode, amount: "", shares: "" });
  const addAmount = (amount: number) => {
    const next = computed.amount + amount;
    patch({ amount: formatInputNumber(clamp(next, 0, 999_999)) });
  };
  const addShares = (shares: number) => {
    const next = Math.floor(Number(state.shares || "0")) + shares;
    patch({ shares: String(clamp(next, 0, 999_999)) });
  };
  const applyMax = () => {
    if (state.side === "Sell") {
      patch({ shares: String(computed.availableShares) });
      return;
    }

    if (computed.inputKind === "amount") {
      patch({ amount: formatInputNumber(balances.usdc) });
      return;
    }

    patch({ shares: String(maxBuyShares(balances.usdc, state.outcome, computed.priceCents)) });
  };

  return (
    <section className="order-slip-card" aria-label="Order ticket">
      <header className="order-slip-head">
        <div className="order-slip-market">
          <div className="order-slip-avatar" aria-hidden="true">{market.ticker}</div>
          <div>
            <p className="order-slip-title">{market.question}</p>
            <div className="order-slip-subtitle" data-outcome={(settled ? winningOutcome : state.outcome).toLowerCase()}>
              <span>{market.strikeLabel}</span>
              <i aria-hidden="true" />
              <strong>{settled ? winningOutcome : state.outcome}</strong>
              {!settled && activePrice != null && <em>{Math.round(activePrice)}¢</em>}
            </div>
          </div>
        </div>
      </header>

      {!settled ? (
        <>
          <div className="order-slip-tradebar">
            <div className="order-slip-side-tabs" role="group" aria-label="Side">
              {(["Buy", "Sell"] as TradeSide[]).map((side) => (
                <button
                  key={side}
                  type="button"
                  className="order-slip-tab"
                  aria-pressed={state.side === side}
                  onClick={() => setSide(side)}
                >
                  {side}
                </button>
              ))}
            </div>
            <div className="order-slip-mode-tabs" role="group" aria-label="Order type">
              {(["Market", "Limit"] as OrderMode[]).map((mode) => {
                const disabled = mode === "Limit" && state.side === "Sell" && state.outcome === "NO";
                return (
                  <button
                    key={mode}
                    type="button"
                    disabled={disabled}
                    aria-pressed={activeMode === mode}
                    title={disabled ? "Sell NO uses market-assisted pair redemption in V1." : undefined}
                    onClick={() => setMode(mode)}
                  >
                    {mode}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="order-slip-body">
            <OutcomeSelector
              noPrice={noPrice}
              outcome={state.outcome}
              setOutcome={setOutcome}
              yesPrice={book.yesMark}
            />

            {activeMode === "Market" ? (
              <MarketFields
                addAmount={addAmount}
                addShares={addShares}
                applyMax={applyMax}
                balances={balances}
                computedInputKind={computed.inputKind}
                onChange={patch}
                state={state}
              />
            ) : (
              <LimitFields
                addShares={addShares}
                applyMax={applyMax}
                balances={balances}
                book={book}
                computedPrice={computed.priceCents}
                onChange={patch}
                state={state}
              />
            )}

            <OrderSummary computed={computed} state={state} />

            <div className="order-slip-validation" data-tone={computed.tone} role="status">
              {validationText}
            </div>

            <button
              className="order-slip-primary"
              type="button"
              disabled={actionDisabled}
              onClick={connected ? onSubmit : onConnect}
            >
              {actionLabel}
            </button>
          </div>
        </>
      ) : (
        <div className="order-slip-body">
          <div className="order-slip-settled">
            <span className="eyebrow">Settled outcome</span>
            <strong>{winningOutcome} won</strong>
            <p>Winning tokens redeem for 1.00 USDC each.</p>
          </div>
          <button className="order-slip-primary" type="button" disabled={busy || redeemDisabled} onClick={onRedeem}>
            {busy ? "Submitting..." : redeemLabel}
          </button>
        </div>
      )}

      {message && (
        <div className="order-slip-message" data-ok={message.includes("✓")}>
          {message}
        </div>
      )}
    </section>
  );
}

function OutcomeSelector({
  noPrice,
  outcome,
  setOutcome,
  yesPrice,
}: {
  noPrice: number | null;
  outcome: Outcome;
  setOutcome: (outcome: Outcome) => void;
  yesPrice: number | null;
}) {
  return (
    <div className="order-slip-outcomes" role="group" aria-label="Outcome">
      {([
        ["YES", yesPrice],
        ["NO", noPrice],
      ] as const).map(([value, price]) => (
        <button
          key={value}
          type="button"
          data-outcome={value.toLowerCase()}
          aria-pressed={outcome === value}
          onClick={() => setOutcome(value)}
        >
          <span>{value === "YES" ? "Yes" : "No"}</span>
          <strong>{price == null ? "—" : `${Math.round(price)}¢`}</strong>
        </button>
      ))}
    </div>
  );
}

function MarketFields({
  addAmount,
  addShares,
  applyMax,
  balances,
  computedInputKind,
  onChange,
  state,
}: {
  addAmount: (amount: number) => void;
  addShares: (shares: number) => void;
  applyMax: () => void;
  balances: OrderSlipBalances;
  computedInputKind: "amount" | "shares";
  onChange: (patch: Partial<OrderSlipState>) => void;
  state: OrderSlipState;
}) {
  if (computedInputKind === "amount") {
    return (
      <div className="order-slip-field">
        <div className="order-slip-field-row">
          <label htmlFor="order-slip-amount">Amount</label>
          <span>Balance {formatUsd(balances.usdc)}</span>
        </div>
        <div className="order-slip-money-input">
          <span aria-hidden="true">$</span>
          <input
            id="order-slip-amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={state.amount}
            placeholder="0"
            aria-label="Amount in dollars"
            onChange={(event) => onChange({ amount: sanitizeMoneyInput(event.target.value) })}
          />
        </div>
        <QuickRow>
          {DOLLAR_QUICK_ADDS.map((amount) => (
            <button key={amount} type="button" onClick={() => addAmount(amount)}>+${amount}</button>
          ))}
          <button type="button" onClick={applyMax}>Max</button>
        </QuickRow>
      </div>
    );
  }

  return (
    <SharesField
      addShares={addShares}
      applyMax={applyMax}
      balanceLabel={`${state.outcome === "YES" ? balances.yesShares : balances.noShares} shares`}
      onChange={onChange}
      state={state}
    />
  );
}

function LimitFields({
  addShares,
  applyMax,
  balances,
  book,
  computedPrice,
  onChange,
  state,
}: {
  addShares: (shares: number) => void;
  applyMax: () => void;
  balances: OrderSlipBalances;
  book: OrderSlipBook;
  computedPrice: number | null;
  onChange: (patch: Partial<OrderSlipState>) => void;
  state: OrderSlipState;
}) {
  const bestLabel = state.side === "Buy"
    ? state.outcome === "YES"
      ? book.bestAsk == null ? "No best ask" : `Best ask ${book.bestAsk}¢`
      : book.bestBid == null ? "No YES bid" : `Best NO ${100 - book.bestBid}¢`
    : state.outcome === "YES"
      ? book.bestBid == null ? "No best bid" : `Best bid ${book.bestBid}¢`
      : "Market only";
  const nudgePrice = (delta: number) => {
    const next = clamp((computedPrice ?? 0) + delta, 1, 99);
    onChange({ limitPrice: String(next) });
  };

  return (
    <div className="order-slip-limit-grid">
      <div className="order-slip-field">
        <div className="order-slip-field-row">
          <label htmlFor="order-slip-price">Limit price</label>
          <span>{bestLabel}</span>
        </div>
        <div className="order-slip-stepper">
          <button type="button" aria-label="Decrease limit price" onClick={() => nudgePrice(-1)}>-</button>
          <div>
            <input
              id="order-slip-price"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={state.limitPrice}
              placeholder="0"
              aria-label="Limit price in cents"
              onChange={(event) => onChange({ limitPrice: sanitizePriceInput(event.target.value) })}
            />
            <span>¢</span>
          </div>
          <button type="button" aria-label="Increase limit price" onClick={() => nudgePrice(1)}>+</button>
        </div>
      </div>

      <SharesField
        addShares={addShares}
        applyMax={applyMax}
        balanceLabel={state.side === "Sell"
          ? `${state.outcome === "YES" ? balances.yesShares : balances.noShares} shares`
          : `Balance ${formatUsd(balances.usdc)}`}
        onChange={onChange}
        state={state}
      />

      <div className="order-slip-expiry">
        <label htmlFor="order-slip-expiry">Expires</label>
        <select
          id="order-slip-expiry"
          value={state.expiry}
          aria-label="Limit order expiry"
          onChange={(event) => onChange({ expiry: event.target.value as OrderExpiry })}
        >
          {EXPIRY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

function SharesField({
  addShares,
  applyMax,
  balanceLabel,
  onChange,
  state,
}: {
  addShares: (shares: number) => void;
  applyMax: () => void;
  balanceLabel: string;
  onChange: (patch: Partial<OrderSlipState>) => void;
  state: OrderSlipState;
}) {
  return (
    <div className="order-slip-field">
      <div className="order-slip-field-row">
        <label htmlFor="order-slip-shares">Shares</label>
        <span>{balanceLabel}</span>
      </div>
      <div className="order-slip-shares-input">
        <input
          id="order-slip-shares"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={state.shares}
          placeholder="0"
          aria-label="Shares"
          onChange={(event) => onChange({ shares: sanitizeSharesInput(event.target.value) })}
        />
      </div>
      <QuickRow>
        {SHARE_QUICK_ADDS.map((shares) => (
          <button key={shares} type="button" onClick={() => addShares(shares)}>+{shares}</button>
        ))}
        <button type="button" onClick={applyMax}>Max</button>
      </QuickRow>
    </div>
  );
}

function QuickRow({ children }: { children: ReactNode }) {
  return <div className="order-slip-quick-row">{children}</div>;
}

function OrderSummary({
  computed,
  state,
}: {
  computed: ReturnType<typeof computeOrderSlip>;
  state: OrderSlipState;
}) {
  const totalLabel = state.side === "Sell" ? "Receive" : "Total";
  const totalValue = state.side === "Sell" ? computed.receive : computed.total;
  const winLabel = state.side === "Sell" ? "Position value" : "To win";
  const hasExtraFunding = state.side === "Buy" && computed.fundingRequired > computed.total + 0.005;

  return (
    <div className="order-slip-summary" aria-label="Order summary">
      <SummaryRow label="Avg price" value={computed.priceCents == null ? "—" : `${Math.round(computed.priceCents)}¢`} />
      <SummaryRow label="Shares" value={formatShares(computed.shares)} />
      <SummaryRow label={totalLabel} value={formatUsd(totalValue)} strong tone={state.side === "Sell" ? "receive" : undefined} />
      {hasExtraFunding && <SummaryRow label="USDC needed" value={formatUsd(computed.fundingRequired)} />}
      <SummaryRow label={winLabel} value={formatUsd(computed.toWin)} strong tone="win" />
      {state.side === "Buy" && <SummaryRow label="Max profit" value={`+${formatUsd(computed.maxProfit)}`} />}
      <SummaryRow label="Fees" value="0 bps" />
    </div>
  );
}

function SummaryRow({
  label,
  strong = false,
  tone,
  value,
}: {
  label: string;
  strong?: boolean;
  tone?: "receive" | "win";
  value: string;
}) {
  return (
    <div className="order-slip-summary-row" data-strong={strong} data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
