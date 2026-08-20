# Product Context

## Why this exists

Retail traders want a simple same-day directional bet on MAG7 closes without options complexity. Binary Outcome Markets make max gain and max loss known at entry. Building this on Solana with an on-chain CLOB removes discretionary custody and makes issuance, matching, and Settlement auditable.

The user-facing question is always: **Will [STOCK] close at or above [STRIKE] today?**

## Problems it solves

- Express a same-day view without Greeks, margin, or unlimited downside.
- Keep Yes and No economically complementary so one book can serve both sides.
- Automate daily market creation and Settlement instead of manual listing.
- Keep user assets in wallets; Meridian only holds fully collateralized vault USDC.

## How it should feel

The user never has to understand mint-and-sell or buy-and-redeem. The Trade UI shows Buy Yes / Buy No / Sell Yes / Sell No. The book is one Yes/USDC Venue Market, mirrored for the No perspective.

Required payoff copy uses the at-or-above rule (Strike equality belongs to Yes).

Mark Price is an explicitly labeled midpoint of a **fresh two-sided** Venue Market, not an executable price. Implied Probability exists only when a defensible Mark Price exists.

Live Underlying Price is an informational, timestamped eligible SIP last trade. It goes stale after fifteen seconds, is labeled delayed when entitlement requires it, and **never** affects protocol state or Settlement.

When fresh venue or Position State cannot be built, the app enters **Recovery-only Mode**: no new Directional Intents, no stale prices/probabilities/P&L. Cancel, settle funds, and Redemption remain.

Market Action requires fresh Executable Depth and explicit confirmation of Worst Execution Price (or minimum proceeds). It fills completely or has no effect.

## Core user journeys

### Buy Yes

Buy Yes Tokens from the ask (Market Action: full-fill-or-revert; Limit: PostOnly).

### Buy No

First-class. Market: mint pair + sell Yes in one approval; keep No; cost is `$1 − Yes proceeds`. Limit: mint pair + PostOnly Yes ask at `100 − NoPrice` in one first-use approval (G7; only named product-compliance waiver if it cannot fit).

`mint_pair` may create missing canonical Yes/No ATAs in the same instruction (user pays). The funded USDC ATA may be a documented wallet prerequisite.

### Sell Yes

Sell Yes on the ask (Market Action or PostOnly Limit). Directional trading — blocked while paused.

### Sell No

Acquire missing Yes, then Pair Redemption. V1 has no Sell-No limit. The **normal builder must not knowingly self-cross**: cancel/settle the user’s matching Yes order and use direct Pair Redemption when that closes the position. A race/adversarial self-fill remains solvent and is reported as an **Internal Unwind**, not external price discovery.

### Mint and quote

Deposit $1 USDC per Pair, receive Yes+No, post PostOnly Yes quotes.

### Settlement and redemption

All Strikes for a ticker and Trading Day settle from **one** Settlement Record. Winning tokens redeem $1; losers $0. Direct Pair Redemption remains available after Settlement. If no trustworthy Official Close exists, the market stays **Settlement Disputed** indefinitely: Pair Redemption stays; unmatched directional positions wait; no void/draw/last-price invention.

## Daily lifecycle (ET; NYSE is calendar authority)

| Time | What happens |
| --- | --- |
| 08:00 | Fetch previous Official Close; generate ±3/6/9% + ATM; round $10; dedupe; corporate-action blackout check |
| 08:30 | `create_strike_market` (Pending SettlementRecord header if first that day) → `create_venue_market` → `attach_venue` → Active |
| 09:00 | Mint window opens |
| 09:30 | Trading wrapper opens |
| Intraday | Users trade; keeper consumes events; operator may `add_strike` until close−30m |
| close − 5m | Official-Close provider/feed preflight |
| 16:00 or early close | Mint and trading close; OpenBook `time_expiry = close_ts - 1` |
| close + 15m | Begin polling for an explicitly final Settlement Record |
| close + 20m | Earliest automated Settlement on **devnet** |
| close + 25m | SLO incident if unresolved |
| ≥ close + 1h | Manual Settlement Override additionally eligible |

Strike acceptance vectors (verbatim):

- META prev close $680 (ATM on): `$620, $640, $660, $680, $700, $720, $740`
- AAPL prev close $230 after dedupe: `$210, $220, $230, $240, $250`

## Position behavior users should see

Position State includes wallet tokens, venue balances, and resting **and locally pending** orders. The Directional Guardrail uses Exposure Interval across every combination of those orders finalizing or filling:

- **Flat / Yes-sided / No-sided / Mixed / Unknown** as in `CONTEXT.md`.
- Mixed and Unknown fail closed for new Directional Intents.
- Cancel, settle funds, Pair Redemption, and exit recovery stay available.

Pause freezes new maker/taker actions but **does not cancel resting orders**. They resume only on explicit safe unpause, with a UI warning.

User-visible **Market Phase** (Preparing, Scheduled, Minting, Trading, Paused, Closed awaiting Settlement, Settlement delayed, Settled, Emergency expired, Abandoned) is a projection, not the on-chain `MarketState` enum.

## Corporate actions and halts

- No new Outcome Market on an effective split, stock dividend, spin-off, merger, rights, reorganization, or identity change. Two sources checked before issuance. Cash-dividend ex-dates remain eligible.
- Halt before issuance → do not create. Halt after issuance → pause new Directional Intents; resume only if trading resumes and safety checks still pass.
- If the listing market publishes an Official Close, settle with that Close Method. If it publishes none, Settlement Disputed. Never silently substitute last trade, midpoint, zero, previous close, or vendor bar.

## UX pages

- **Landing** — explanation, live MAG7 prices, connect wallet, active market counts.
- **Markets** — 7-stock grid: Live Underlying Price, active strike count, nearest strikes, Market Phase.
- **Trade** — Outcome Market cards, Yes price, implied No, Implied Probability, mirrored ladder, four intents, Market/Limit, countdown, payoff sentence, crossing-limit warning, backlog / Recovery-only Mode.
- **Portfolio** — wallet Yes/No, unknown-basis badges, resting orders, OpenBook free balances, Platform-execution P&L, settled payout, Redeem.
- **History** — execution log plus **History Completeness** (genesis slot through backfill cursor, gaps exposed).

## What “good” looks like

Users can complete a same-day round trip without understanding PDAs or EventHeap. Failures fail closed. Recovery always exists when trading is paused or indexed state is missing. Language stays Outcome Market / Venue Market / Trading Day / Official Close — never “contract,” bare “market,” or “last price” as settlement.
