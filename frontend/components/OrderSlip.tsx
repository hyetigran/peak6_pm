"use client";

import { useState, type ReactNode } from "react";
import {
  DOLLAR_QUICK_ADDS,
  SHARE_QUICK_ADDS,
  clamp,
  computeOrderSlip,
  defaultLimitPrice,
  formatInputNumber,
  formatUsd,
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
  { value: "close", label: "Never" },
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
  const noPrice = book.yesMark == null ? null : 100 - book.yesMark;
  const validationText = connected && computed.reason !== "Enter a dollar amount to trade."
    ? computed.reason
    : "";
  const actionDisabled = busy || !tradeable || (connected && computed.disabled);
  const actionLabel = busy ? "Submitting..." : "Trade";
  const nextMode = activeMode === "Market" ? "Limit" : "Market";

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
  const setMode = (mode: OrderMode) => patch({
    mode,
    amount: "",
    shares: "",
    limitPrice: mode === "Limit" ? "" : state.limitPrice,
  });
  const isModeDisabled = (mode: OrderMode) => mode === "Limit" && state.side === "Sell" && state.outcome === "NO";
  const toggleMode = () => {
    if (isModeDisabled(nextMode)) return;
    setMode(nextMode);
  };
  const addAmount = (amount: number) => {
    const next = computed.amount + amount;
    patch({ amount: formatInputNumber(clamp(next, 0, 999_999_999)) });
  };
  const addShares = (shares: number) => {
    const next = Math.floor(Number(state.shares || "0")) + shares;
    patch({ shares: String(clamp(next, 0, 999_999_999)) });
  };

  return (
    <section className="order-slip-card" data-mode={activeMode.toLowerCase()} aria-label="Order ticket">
      <header className="order-slip-head">
        <div className="order-slip-market">
          <div className="order-slip-avatar" aria-hidden="true">{market.ticker}</div>
          <div>
            <p className="order-slip-title">{market.question}</p>
            <div className="order-slip-subtitle" data-outcome={(settled ? winningOutcome : state.outcome).toLowerCase()}>
              <span>{market.strikeLabel}</span>
              <i aria-hidden="true" />
              <strong>{settled ? winningOutcome : state.outcome}</strong>
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
            <div className="order-slip-mode-control">
              <button
                className="order-slip-mode-button"
                type="button"
                aria-label={`Switch to ${nextMode} order`}
                disabled={isModeDisabled(nextMode)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={toggleMode}
              >
                {activeMode}
                <span aria-hidden="true" />
              </button>
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
              <>
                <MarketFields
                  addAmount={addAmount}
                  addShares={addShares}
                  balances={balances}
                  computedInputKind={computed.inputKind}
                  onChange={patch}
                  state={state}
                />
                {computed.amount > 0 && computed.priceCents != null && (
                  <MarketSummary computed={computed} />
                )}
              </>
            ) : (
              <LimitFields
                addShares={addShares}
                balances={balances}
                computed={computed}
                computedPrice={computed.priceCents}
                onChange={patch}
                state={state}
              />
            )}

            <div className="order-slip-action-area">
              {validationText && (
                <div className="order-slip-validation" data-tone={computed.tone} role="status">
                  {validationText}
                </div>
              )}

              <button
                className="order-slip-primary"
                type="button"
                disabled={actionDisabled}
                onClick={connected ? onSubmit : onConnect}
              >
                {actionLabel}
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="order-slip-body">
          <div className="order-slip-settled">
            <span className="eyebrow">Settled outcome</span>
            <strong>{winningOutcome} won</strong>
            <p>Winning tokens redeem for 1.00 USDC each.</p>
          </div>
          <div className="order-slip-action-area">
            <button className="order-slip-primary" type="button" disabled={busy || redeemDisabled} onClick={onRedeem}>
              {busy ? "Submitting..." : redeemLabel}
            </button>
          </div>
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
  balances,
  computedInputKind,
  onChange,
  state,
}: {
  addAmount: (amount: number) => void;
  addShares: (shares: number) => void;
  balances: OrderSlipBalances;
  computedInputKind: "amount" | "shares";
  onChange: (patch: Partial<OrderSlipState>) => void;
  state: OrderSlipState;
}) {
  if (computedInputKind === "amount") {
    const amountDisplay = formatAmountDisplay(state.amount);
    const amountSize = amountTextSize(amountDisplay.length);

    return (
      <div className="order-slip-market-entry">
        <div className="order-slip-amount-row">
          <label htmlFor="order-slip-amount">Amount</label>
          <div
            className="order-slip-money-input"
            data-empty={state.amount === ""}
            data-size={amountSize}
          >
            <span aria-hidden="true">$</span>
            <input
              id="order-slip-amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={amountDisplay}
              placeholder="0"
              maxLength={14}
              aria-label={`Amount in dollars. Balance ${formatUsd(balances.usdc)}`}
              onChange={(event) => onChange({ amount: sanitizeMoneyInput(event.target.value) })}
            />
          </div>
        </div>
        <QuickRow className="order-slip-quick-row--right">
          {DOLLAR_QUICK_ADDS.map((amount) => (
            <button key={amount} type="button" onClick={() => addAmount(amount)}>+${amount}</button>
          ))}
        </QuickRow>
      </div>
    );
  }

  return (
    <SharesField
      addShares={addShares}
      balanceLabel={`${state.outcome === "YES" ? balances.yesShares : balances.noShares} shares`}
      onChange={onChange}
      state={state}
    />
  );
}

function formatAmountDisplay(value: string): string {
  if (!value) return "";
  const hasDecimal = value.includes(".");
  const [whole, decimals = ""] = value.split(".");
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return hasDecimal ? `${groupedWhole}.${decimals}` : groupedWhole;
}

function amountTextSize(length: number): "xl" | "lg" | "md" | "sm" | "xs" {
  if (length >= 10) return "xs";
  if (length >= 8) return "sm";
  if (length >= 6) return "md";
  if (length >= 4) return "lg";
  return "xl";
}

function LimitFields({
  addShares,
  balances,
  computed,
  computedPrice,
  onChange,
  state,
}: {
  addShares: (shares: number) => void;
  balances: OrderSlipBalances;
  computed: ReturnType<typeof computeOrderSlip>;
  computedPrice: number | null;
  onChange: (patch: Partial<OrderSlipState>) => void;
  state: OrderSlipState;
}) {
  const nudgePrice = (delta: number) => {
    const next = clamp((computedPrice ?? 0) + delta, 1, 99);
    onChange({ limitPrice: String(next) });
  };

  return (
    <div className="order-slip-limit-grid">
      <div className="order-slip-limit-row order-slip-limit-row--price">
        <label htmlFor="order-slip-price">Limit price</label>
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
        balanceLabel={state.side === "Sell"
          ? `${state.outcome === "YES" ? balances.yesShares : balances.noShares} shares`
          : `Balance ${formatUsd(balances.usdc)}`}
        onChange={onChange}
        state={state}
      />

      <LimitSummary computed={computed} onChange={onChange} state={state} />
    </div>
  );
}

function SharesField({
  addShares,
  balanceLabel,
  onChange,
  state,
}: {
  addShares: (shares: number) => void;
  balanceLabel: string;
  onChange: (patch: Partial<OrderSlipState>) => void;
  state: OrderSlipState;
}) {
  return (
    <div className="order-slip-limit-row order-slip-limit-row--shares">
      <label htmlFor="order-slip-shares">Shares</label>
      <div className="order-slip-shares-stack">
        <div className="order-slip-shares-input" data-size={sharesTextSize(state.shares.length)}>
          <input
            id="order-slip-shares"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={state.shares}
            placeholder="0"
            maxLength={9}
            aria-label={`Shares. ${balanceLabel}`}
            onChange={(event) => onChange({ shares: sanitizeSharesInput(event.target.value) })}
          />
        </div>
        <QuickRow className="order-slip-quick-row--right">
          {SHARE_QUICK_ADDS.map((shares) => (
            <button key={shares} type="button" onClick={() => addShares(shares)}>
              {shares > 0 ? `+${shares}` : shares}
            </button>
          ))}
        </QuickRow>
      </div>
    </div>
  );
}

function sharesTextSize(length: number): "md" | "sm" | "xs" {
  if (length >= 8) return "xs";
  if (length >= 6) return "sm";
  return "md";
}

function QuickRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `order-slip-quick-row ${className}` : "order-slip-quick-row"}>{children}</div>;
}

function MarketSummary({
  computed,
}: {
  computed: ReturnType<typeof computeOrderSlip>;
}) {
  const winValue = formatUsd(computed.toWin);

  return (
    <div className="order-slip-market-summary" data-size={amountTextSize(winValue.length)} aria-label="Market order summary">
      <div>
        <strong>
          To win
          <i className="order-slip-cash-mark" aria-hidden="true">$</i>
        </strong>
        <span>
          Avg. Price {computed.priceCents == null ? "—" : `${Math.round(computed.priceCents)}¢`}
          <i className="order-slip-info-mark" aria-hidden="true">i</i>
        </span>
      </div>
      <b>{winValue}</b>
    </div>
  );
}

function LimitSummary({
  computed,
  onChange,
  state,
}: {
  computed: ReturnType<typeof computeOrderSlip>;
  onChange: (patch: Partial<OrderSlipState>) => void;
  state: OrderSlipState;
}) {
  const totalLabel = state.side === "Sell" ? "Receive" : "Total";
  const totalValue = state.side === "Sell" ? computed.receive : computed.total;
  const winLabel = state.side === "Sell" ? "Position value" : "To win";
  const winValue = formatUsd(computed.toWin);

  return (
    <div className="order-slip-summary" aria-label="Order summary">
      <div className="order-slip-summary-row order-slip-summary-row--expiry">
        <span>Expires</span>
        <ExpiryDropdown
          value={state.expiry}
          onChange={(expiry) => onChange({ expiry })}
        />
      </div>
      <SummaryRow label={totalLabel} value={formatUsd(totalValue)} tone={state.side === "Sell" ? "receive" : "total"} />
      <SummaryRow label={winLabel} value={winValue} withInfo withCash tone="win" size={amountTextSize(winValue.length)} />
    </div>
  );
}

function ExpiryDropdown({
  onChange,
  value,
}: {
  onChange: (value: OrderExpiry) => void;
  value: OrderExpiry;
}) {
  const [open, setOpen] = useState(false);
  const current = EXPIRY_OPTIONS.find((option) => option.value === value) ?? EXPIRY_OPTIONS[0];
  const chooseExpiry = (nextValue: OrderExpiry) => {
    setOpen(false);
    onChange(nextValue);
  };

  return (
    <div className="order-slip-expiry-control">
      <button
        className="order-slip-expiry-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Limit order expiry"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((nextOpen) => !nextOpen)}
      >
        {current.label}
        <span aria-hidden="true" />
      </button>
      {open && (
        <div className="order-slip-expiry-menu" role="menu" aria-label="Limit order expiry options">
          {EXPIRY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={value === option.value}
              onClick={() => chooseExpiry(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryRow({
  label,
  strong = false,
  tone,
  value,
  withCash = false,
  withInfo = false,
  size,
}: {
  label: string;
  strong?: boolean;
  tone?: "receive" | "total" | "win";
  value: string;
  withCash?: boolean;
  withInfo?: boolean;
  size?: "xl" | "lg" | "md" | "sm" | "xs";
}) {
  return (
    <div className="order-slip-summary-row" data-size={size} data-strong={strong} data-tone={tone}>
      <span>
        {label}
        {withInfo && <i className="order-slip-info-mark" aria-hidden="true">i</i>}
      </span>
      <strong>
        {withCash && <i className="order-slip-cash-mark" aria-hidden="true">$</i>}
        {value}
      </strong>
    </div>
  );
}
