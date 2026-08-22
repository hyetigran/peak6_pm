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

The user never has to understand mint-and-sell or buy-and-redeem. The Trade UI shows Buy Yes / Buy No / Sell Yes / Sell No. The book is one Yes/USDC Venue Market, mirrored for the No perspective. Standalone Mint/Redeem-pair buttons were dropped from the order slip so the four intents stay first-class.

Required payoff copy uses the at-or-above rule (Strike equality belongs to Yes).

Mark Price is an explicitly labeled midpoint of a **fresh two-sided** Venue Market, not an executable price. Implied Probability exists only when a defensible Mark Price exists.

Live Underlying Price is an informational, timestamped eligible SIP last trade. It goes stale after fifteen seconds, is labeled delayed when entitlement requires it, and **never** affects protocol state or Settlement. The localnet Markets page currently uses static demo reference prices, not a SIP feed.

When fresh venue or Position State cannot be built, the app enters **Recovery-only Mode**: no new Directional Intents, no stale prices/probabilities/P&L. Cancel, settle funds, and Redemption remain. Today the frontend shows a Recovery-only banner from indexer lag; it does not yet compute Exposure Interval or fail-close Mixed/Unknown.

Market Action requires fresh Executable Depth and explicit confirmation of Worst Execution Price (or minimum proceeds). It fills completely or has no effect.

## Core user journeys

### Buy Yes

Buy Yes Tokens from the ask (Market Action: full-fill-or-revert; Limit: PostOnly).

### Buy No

First-class. Market: mint pair + sell Yes in one approval; keep No; cost is `$1 − Yes proceeds`. Limit: mint pair + PostOnly Yes ask at `100 − NoPrice` in one first-use approval (G7; named waiver is **not** needed — one approval fits).

`mint_pair` may create missing canonical Yes/No ATAs in the same instruction (user pays). The funded USDC ATA may be a documented wallet prerequisite.

### Sell Yes

Sell Yes on the ask (Market Action or PostOnly Limit). Directional trading — blocked while paused.

### Sell No

Acquire missing Yes, then Pair Redemption. V1 has no Sell-No limit. The **normal builder must not knowingly self-cross**: cancel/settle the user’s matching Yes order and use direct Pair Redemption when that closes the position. A race/adversarial self-fill remains solvent and is reported as an **Internal Unwind**, not external price discovery.

On-chain path is `redeem_no_via_market` (ported; meridian trading T5 green).

### Mint and quote

Deposit $1 USDC per Pair, receive Yes+No, post PostOnly Yes quotes. In the current Trade UI this is composed inside Buy No / quoting flows, not a separate slip action.

### Settlement and redemption

All Strikes for a ticker and Trading Day settle from **one** Settlement Record. Winning tokens redeem $1; losers $0. Direct Pair Redemption remains available after Settlement. If no trustworthy Official Close exists, the market stays **Settlement Disputed** indefinitely: Pair Redemption stays; unmatched directional positions wait; no void/draw/last-price invention.

## Daily lifecycle (ET; NYSE is calendar authority)

The 08:00 / 08:30 / 09:00 / 09:30 morning block in PRD §5 is a **timing convenience, not the deployed clock**. ADR-0032 / ADR-0033 roll the cycle:

```text
prior close + ~20m     earliest automated Settlement (devnet floor)
prior close + ~25m     SLO if unresolved
prior close + ~30m     create next session (resolution + 5m), anchored on the just-published Official Close
                       mint_open = creation
                       trade_open = creation + 30m   (30-minute mint-seed lead kept)
                       close_ts  = next NYSE session close
creation → close       book is open (~23.5h overnight; up to ~4 days across a long weekend)
close − 5m             Official-Close provider/feed preflight
16:00 / early close    mint and trading close; OpenBook time_expiry = close_ts - 1
close + 15m            begin accepting a final Settlement Record
>= close + 1h          Manual Settlement Override additionally eligible
```

Safety gates move with creation: NYSE eligibility and two-source Corporate Action Blackout are evaluated for the *target* session. After `activity_started`, `abandon_market` is unusable; a late disqualifier (weekend corporate action) uses the Emergency Expiry recovery path (ADR-0033), not a clean abort. Issue #21 still tracks a pre-open re-validation job for markets that have not yet gone live.

Intraday `add_strike` remains until `close_ts - 1800s`.

Production keeper work is **scheduled jobs + EventHeap subscription** (ADR-0031), not a poll. The localnet `services/keeper` 5s loop is a demo affordance only.

Strike acceptance vectors (verbatim):

- META prev close $680 (ATM on): `$620, $640, $660, $680, $700, $720, $740`
- AAPL prev close $230 after dedupe: `$210, $220, $230, $240, $250`

## Position behavior users should see

Position State includes wallet tokens, venue balances, and resting **and locally pending** orders. The Directional Guardrail uses Exposure Interval across every combination of those orders finalizing or filling:

- **Flat / Yes-sided / No-sided / Mixed / Unknown** as in `CONTEXT.md`.
- Mixed and Unknown fail closed for new Directional Intents.
- Cancel, settle funds, Pair Redemption, and exit recovery stay available.

Pause freezes new maker/taker actions but **does not cancel resting orders**. They resume only on explicit safe unpause, with a UI warning.

User-visible **Market Phase** (Preparing, Scheduled, Minting, Trading, Paused, Closed awaiting Settlement, Settlement delayed, Settled, Emergency expired, Abandoned) is a projection, not the on-chain `MarketState` enum. The Markets page currently projects a shorter set (Minting / Trading / …) from timestamps.

## Corporate actions and halts

- No new Outcome Market on an effective split, stock dividend, spin-off, merger, rights, reorganization, or identity change. Two sources checked before issuance. Cash-dividend ex-dates remain eligible.
- Halt before issuance → do not create. Halt after issuance → pause new Directional Intents; resume only if trading resumes and safety checks still pass.
- If the listing market publishes an Official Close, settle with that Close Method. If it publishes none, Settlement Disputed. Never silently substitute last trade, midpoint, zero, previous close, or vendor bar.

## UX pages (as shipped on localnet)

- **Markets** (`/`, redirects here) — MAG7 cards, strike chips, session/settles/OI pills, lifecycle strip. No separate Landing page.
- **Trade** (`/trade/[market]`) — three-column mockup: payoff sentence, mirrored YES/NO books, four intents, open orders, recent fills. Dark theme (Space Grotesk + IBM Plex Mono).
- **Portfolio** — wallet Yes/No per market, Redeem.
- **History** — thinner than the freeze (no full History Completeness / Platform-execution P&L yet).
- **Admin** — localnet demo console (pause / settle / override via indexer routes signed from `.demo-config.json`). Not the production authority model.

## What “good” looks like

Users can complete a same-day round trip without understanding PDAs or EventHeap. Failures fail closed. Recovery always exists when trading is paused or indexed state is missing. Language stays Outcome Market / Venue Market / Trading Day / Official Close — never “contract,” bare “market,” or “last price” as settlement.
