"use client";

import { useState } from "react";
import { OrderSlip } from "@/components/OrderSlip";
import { type OrderSlipState } from "@/lib/orderSlip";

const fixtureBook = {
  bestAsk: 64,
  bestBid: 61,
  yesMark: 62,
};

const fixtureBalances = {
  usdc: 128.43,
  yesShares: 42,
  noShares: 9,
};

export default function OrderSlipPreview() {
  const [state, setState] = useState<OrderSlipState>({
    side: "Buy",
    mode: "Market",
    outcome: "YES",
    amount: "25",
    shares: "10",
    limitPrice: "62",
    expiry: "close",
  });
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="trade-layout trade-preview-layout">
      <div className="trade-center">
        <div className="hd" style={{ alignItems: "flex-start", gap: 20 }}>
          <div>
            <div className="sub" style={{ fontSize: 14, marginBottom: 6 }}>AAPL · 0DTE · settles 4:00 PM ET · 20260823</div>
            <h1 style={{ fontSize: 28, maxWidth: 560 }}>Will AAPL close at or above $230 today?</h1>
          </div>
          <div className="statpill" style={{ textAlign: "right" }}>
            <div className="k">Time to close</div>
            <div className="v mono" style={{ fontSize: 24 }}>03:42:18</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div className="card-2" style={{ padding: 18 }}>
            <div className="eyebrow">YES</div>
            <div className="mono" style={{ marginTop: 6, fontSize: 34, color: "var(--yes-hi)" }}>62¢</div>
          </div>
          <div className="card-2" style={{ padding: 18 }}>
            <div className="eyebrow">NO</div>
            <div className="mono" style={{ marginTop: 6, fontSize: 34, color: "var(--no-hi)" }}>38¢</div>
          </div>
        </div>
      </div>

      <div className="trade-slip-shell">
        <OrderSlip
          balances={fixtureBalances}
          book={fixtureBook}
          busy={false}
          connected
          market={{
            closeTs: Math.floor(Date.now() / 1000) + 13_338,
            question: "Will AAPL close at or above $230 today?",
            strikeLabel: "$230",
            ticker: "AAPL",
            tradingDay: 20260823,
          }}
          message={message}
          onChange={(patch) => setState((prev) => ({ ...prev, ...patch }))}
          onConnect={() => setMessage("Preview wallet connected")}
          onRedeem={() => setMessage("Preview redeem action")}
          onSubmit={() => setMessage("Preview trade action")}
          quoteReady
          redeemDisabled={false}
          redeemLabel="Claim 42 winning Yes → USDC"
          settled={false}
          state={state}
          tradeable
          winningOutcome="Yes"
        />
      </div>
    </div>
  );
}
