"use client";
import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { marketPhase, type Market, type Book } from "@/lib/api";
import { strikeUsd, usd } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import { useTokenBalance } from "@/components/useBalances";
import { OrderSlip } from "@/components/OrderSlip";
import {
  computeOrderSlip,
  defaultLimitPrice,
  normalizeOrderMode,
  unitsFromAtoms,
  wholeSharesFromAtoms,
  type OrderSlipState,
  type Outcome,
  type TradeSide,
} from "@/lib/orderSlip";
import * as mx from "@/lib/meridian";

export type { Outcome };
// wallets whose OpenOrders account is known to exist (module-scoped, survives remounts)
const ooKnown = new Set<string>();
export type Side = TradeSide;

/**
 * The order slip. Controlled on outcome/side so row-level Buy Yes / Buy No
 * buttons elsewhere on the page can drive it; trade details and wallet plumbing
 * stay local to the slip.
 */
export function OrderPanel({ m, book, mobileOpen = false, onMobileClose, outcome, setOutcome, side, setSide }: {
  m: Market; book: Book | null;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  outcome: Outcome; setOutcome: (o: Outcome) => void;
  side: Side; setSide: (s: Side) => void;
}) {
  const { pubkey, connect, send, conn, sol, quoteMint } = useWallet();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [slip, setSlip] = useState<OrderSlipState>({
    outcome,
    side,
    mode: "Market",
    amount: "",
    shares: "5",
    limitPrice: "50",
    expiry: "close",
  });

  const pk = m.pubkey;
  const phase = marketPhase(m);
  const settled = phase === "Settled";
  const tradeable = phase === "Trading";
  const yesM = new PublicKey(m.yes_mint);
  const noM = new PublicKey(m.no_mint);
  const obMarket = new PublicKey(m.openbook_market);
  const yesPx = book?.mark ?? null;
  const orderBook = { bestAsk: book?.best_ask ?? null, bestBid: book?.best_bid ?? null, yesMark: yesPx };

  useEffect(() => {
    setSlip((prev) => {
      const next = { ...prev, outcome, side };
      const suggested = prev.outcome === outcome ? null : defaultLimitPrice(outcome, orderBook);
      return {
        ...next,
        mode: normalizeOrderMode(next),
        limitPrice: suggested == null ? prev.limitPrice : String(Math.round(suggested)),
      };
    });
  }, [outcome, side]);

  const yesBal = useTokenBalance(m.yes_mint);
  const noBal = useTokenBalance(m.no_mint);
  const quoteBal = useTokenBalance(quoteMint?.toBase58());

  const orderBalances = {
    usdc: unitsFromAtoms(quoteBal),
    yesShares: wholeSharesFromAtoms(yesBal),
    noShares: wholeSharesFromAtoms(noBal),
  };
  const slipComputed = computeOrderSlip({
    state: slip,
    book: orderBook,
    balances: orderBalances,
    market: { closeTs: m.close_ts, connected: !!pubkey, quoteReady: !!quoteMint, solBalance: sol, tradeable },
  });

  const usdcAta = () => {
    if (!quoteMint) throw new Error("quote mint not loaded — is NEXT_PUBLIC_RPC pointed at the right cluster and the market Config initialized?");
    return mx.ataFor(quoteMint, pubkey!);
  };
  const ensure = useCallback(async (mints: PublicKey[], needOo: boolean, obMarket?: PublicKey) => {
    const ixs: any[] = [];
    // ATAs: CreateIdempotent is a no-op when the account exists, so no
    // existence reads sit in front of the send. The USDC (quote) ATA is always
    // included — every trade references it (missing => AccountNotInitialized).
    const all = quoteMint ? [quoteMint, ...mints] : mints;
    const seen = new Set<string>();
    for (const mint of all) {
      const key = mint.toBase58();
      if (seen.has(key)) continue;
      seen.add(key);
      ixs.push(mx.createAtaIdempotentIx(pubkey!, pubkey!, mint));
    }
    // OpenOrders: created once per wallet; remember it so only the first order
    // pays the read.
    if (needOo && obMarket) {
      const ooKey = pubkey!.toBase58();
      if (!ooKnown.has(ooKey)) {
        if (await conn.getAccountInfo(mx.ooAccountPda(pubkey!, 1))) ooKnown.add(ooKey);
        else ixs.push(...mx.createOoIxs(pubkey!, obMarket));
      }
    }
    return ixs;
  }, [conn, pubkey, quoteMint]);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    if (!pubkey) return connect();
    setBusy(true);
    const ooKey = pubkey.toBase58();
    setMsg(null);
    try {
      await fn();
      ooKnown.add(ooKey); // any confirmed trade implies the OpenOrders account now exists
      setMsg("Confirmed ✓");
    } catch (e: any) {
      console.error(e);
      setMsg("Something went wrong");
    } finally {
      setBusy(false);
    }
  }, [pubkey, connect]);

  const setSlipPatch = useCallback((patch: Partial<OrderSlipState>) => {
    if (patch.outcome && patch.outcome !== outcome) setOutcome(patch.outcome);
    if (patch.side && patch.side !== side) setSide(patch.side);
    setSlip((prev) => {
      const next = { ...prev, ...patch };
      return { ...next, mode: normalizeOrderMode(next) };
    });
  }, [outcome, setOutcome, side, setSide]);

  const qLots = () => BigInt(slipComputed.shares);
  const priceLots = () => BigInt(Math.max(1, Math.min(99, Math.floor(slipComputed.priceCents ?? 0))));
  const expiryLots = () => BigInt(slipComputed.expiryTimestamp ?? 0);

  const submit = () => guard(async () => {
    if (slipComputed.disabled) throw new Error(slipComputed.reason || "order is not ready");
    const q = qLots();
    if (q === 0n) throw new Error("size must be a whole number of shares");

    const oo = mx.ooAccountPda(pubkey!, 1);
    const marketPk = new PublicKey(pk);
    const baseVault = new PublicKey(m.openbook_base_vault);
    const quoteVault = new PublicKey(m.openbook_quote_vault);
    const { outcome: selectedOutcome, side: selectedSide } = slip;
    const mode = slipComputed.mode;

    if (selectedOutcome === "YES") {
      if (selectedSide === "Buy" && mode === "Limit") {
        const pre = await ensure([yesM, noM], true, obMarket);
        await send([...pre, mx.placeLimitOrderIx({
          user: pubkey!, market: marketPk, ooAccount: oo, userTokenAccount: usdcAta()!, obMarket,
          bids: new PublicKey(m.bids), asks: new PublicKey(m.asks), eventHeap: new PublicKey(m.event_heap),
          marketVault: quoteVault, side: mx.Side.Bid, priceLots: priceLots(), baseLots: q, expiryTimestamp: expiryLots(),
        })]);
      } else if (selectedSide === "Sell" && mode === "Limit") {
        const pre = await ensure([yesM], true, obMarket);
        await send([...pre, mx.placeLimitOrderIx({
          user: pubkey!, market: marketPk, ooAccount: oo, userTokenAccount: mx.ataFor(yesM, pubkey!), obMarket,
          bids: new PublicKey(m.bids), asks: new PublicKey(m.asks), eventHeap: new PublicKey(m.event_heap),
          marketVault: baseVault, side: mx.Side.Ask, priceLots: priceLots(), baseLots: q, expiryTimestamp: expiryLots(),
        })]);
      } else {
        const isBuy = selectedSide === "Buy";
        const owners = (isBuy ? book?.ask_owners : book?.bid_owners) ?? [];
        const px = isBuy ? BigInt(book?.best_ask ?? 99) : BigInt(book?.best_bid ?? 1);
        const pre = await ensure([yesM, noM], false, obMarket);
        await send([...pre, mx.placeTakeOrderIx({
          user: pubkey!, market: marketPk, obMarket, bids: new PublicKey(m.bids), asks: new PublicKey(m.asks),
          baseVault, quoteVault, eventHeap: new PublicKey(m.event_heap), userBase: mx.ataFor(yesM, pubkey!),
          userQuote: usdcAta()!, makerOos: owners.map((o) => new PublicKey(o)),
          side: isBuy ? mx.Side.Bid : mx.Side.Ask, priceLots: px, baseLots: q,
        })]);
      }
    } else if (selectedSide === "Buy" && mode === "Market") {
      const owners = (book?.bid_owners ?? []).map((o) => new PublicKey(o));
      const px = BigInt(book?.best_bid ?? 1);
      const pre = await ensure([yesM, noM], false, obMarket);
      await send([...pre,
        mx.mintPairIx(pubkey!, marketPk, q * 1_000_000n, {
          yesMint: yesM, noMint: noM, collateralVault: new PublicKey(m.collateral_vault),
          userQuote: usdcAta()!, userYes: mx.ataFor(yesM, pubkey!), userNo: mx.ataFor(noM, pubkey!),
        }),
        mx.placeTakeOrderIx({
          user: pubkey!, market: marketPk, obMarket, bids: new PublicKey(m.bids), asks: new PublicKey(m.asks),
          baseVault, quoteVault, eventHeap: new PublicKey(m.event_heap), userBase: mx.ataFor(yesM, pubkey!),
          userQuote: usdcAta()!, makerOos: owners, side: mx.Side.Ask, priceLots: px, baseLots: q,
        }),
      ]);
    } else if (selectedSide === "Buy") {
      const pre = await ensure([yesM, noM], true, obMarket);
      const yesAsk = 100n - priceLots();
      await send([...pre,
        mx.mintPairIx(pubkey!, marketPk, q * 1_000_000n, {
          yesMint: yesM, noMint: noM, collateralVault: new PublicKey(m.collateral_vault),
          userQuote: usdcAta()!, userYes: mx.ataFor(yesM, pubkey!), userNo: mx.ataFor(noM, pubkey!),
        }),
        mx.placeLimitOrderIx({
          user: pubkey!, market: marketPk, ooAccount: oo, userTokenAccount: mx.ataFor(yesM, pubkey!), obMarket,
          bids: new PublicKey(m.bids), asks: new PublicKey(m.asks), eventHeap: new PublicKey(m.event_heap),
          marketVault: baseVault, side: mx.Side.Ask, priceLots: yesAsk > 0n ? yesAsk : 1n, baseLots: q, expiryTimestamp: expiryLots(),
        }),
      ]);
    } else {
      const owners = (book?.ask_owners ?? []).map((o) => new PublicKey(o));
      const px = BigInt(book?.best_ask ?? 99);
      const pre = await ensure([yesM, noM], false, obMarket);
      await send([...pre, mx.createTradeAtaIx(pubkey!, marketPk, yesM),
        mx.redeemNoViaMarketIx(pubkey!, {
          market: marketPk, yesMint: yesM, noMint: noM, collateralVault: new PublicKey(m.collateral_vault),
          userQuote: usdcAta()!, userNo: mx.ataFor(noM, pubkey!), obMarket, bids: new PublicKey(m.bids),
          asks: new PublicKey(m.asks), baseVault, quoteVault, eventHeap: new PublicKey(m.event_heap),
          makerOos: owners, qLots: q, priceLots: px,
        })]);
    }
  });

  const winBal = m.outcome_name === "Yes" ? yesBal : noBal;
  const redeemWin = () => guard(async () => {
    const winMint = new PublicKey(m.outcome_name === "Yes" ? m.yes_mint : m.no_mint);
    await send([mx.redeemWinningIx(pubkey!, new PublicKey(pk), winMint, {
      collateralVault: new PublicKey(m.collateral_vault),
      userWinning: mx.ataFor(winMint, pubkey!),
      userQuote: usdcAta()!,
      amount: winBal,
    })]);
  });

  return (
    <>
      <button
        aria-hidden={!mobileOpen}
        className="event-order-backdrop"
        data-open={mobileOpen}
        onClick={onMobileClose}
        tabIndex={mobileOpen ? 0 : -1}
        type="button"
      />
      <div className="event-order-panel" data-open={mobileOpen}>
        <button
          aria-label="Close order slip"
          className="event-order-sheet-close"
          onClick={onMobileClose}
          type="button"
        />
        <OrderSlip
          balances={orderBalances}
          book={orderBook}
          busy={busy}
          connected={!!pubkey}
          market={{
            closeTs: m.close_ts,
            question: `Will ${m.ticker} close at or above $${strikeUsd(m.strike_1e6)} today?`,
            strikeLabel: `$${strikeUsd(m.strike_1e6)}`,
            ticker: m.ticker,
            tradingDay: m.trading_day,
          }}
          message={msg}
          onChange={setSlipPatch}
          onConnect={connect}
          onRedeem={redeemWin}
          onSubmit={submit}
          quoteReady={!!quoteMint}
          redeemDisabled={winBal === 0n || !quoteMint}
          redeemLabel={`Claim ${usd(winBal.toString(), 0)} winning ${m.outcome_name} → USDC`}
          settled={settled}
          state={slip}
          tradeable={tradeable}
          winningOutcome={m.outcome_name}
        />
      </div>
    </>
  );
}
