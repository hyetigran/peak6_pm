# Open trading when the market exists, not at the session bell

ADR-0032 creates each session's Outcome Markets at the prior session's close+30m.
Solana and the OpenBook venue are 24/7, and a binary bet on the 4pm Official
Close does not require the book to sit idle until 9:30 — participants can form
and express a view on today's close overnight and pre-market. Today
`validate_schedule` (strict build) pins the trading session to exactly 3.5h or
6.5h (`session == 12_600 || 23_400`, the NYSE regular and half-day sessions) as
an operator constraint (ADR-0004); that pin is what forces session-bell trading.

**Decision.** Trading opens when the market exists. The schedule snapshot is set
to `mint_open_ts = creation time` (~prior close+30m) and `trade_open_ts =
creation + 30m` — preserving the existing 30-minute mint-before-trade seeding
window (so the exact `trade_open_ts − mint_open_ts == 1800` rule is unchanged) —
with `close_ts` unchanged at the NYSE session close. The trading window becomes
creation→close: ~23.5h on an overnight rollover, up to ~4 days across a
long-weekend/holiday gap. Settlement is still the same 4pm Official Close; this
changes only *when the book opens*, not what it settles on.

**Program change.** `validate_schedule` (under `not(feature = "localnet")`)
replaces the exact `session ∈ {12_600, 23_400}` check with a bounded window:
keep `mint_open < trade_open < close` and `trade_open − mint_open == 1800`, and
require `0 < session ≤ MAX_SESSION_SECS`, where `MAX_SESSION_SECS` covers the
longest consecutive-trading-day gap (~4 days, pinned with the calendar in the
implementation). `close_ts` must still be a valid NYSE session close
(calendar-checked at creation, ADR-0014). This is a redeploy and lands with the
strict `build-devnet` target. The localnet build already skips the session
check, so the demo is unaffected (it effectively opens trading at creation
today).

**Gap risk — recovery path, not clean abort (decided).** With trading live from
creation, `abandon_market` (which requires `!activity_started`,
`collateral_liability_atoms == 0`, `!has_venue()`) is no longer usable once a
market goes live, so the clean pre-mint abort of #21 does not apply to early-open
markets. A disqualifying event landing after creation — most acutely a corporate
action over a weekend gap — therefore hits a live, possibly-collateralized market
and is handled by the **emergency-expiry recovery path** (ID-004: pause →
`set_market_expired` → cancel/prune → event consumption → fund settlement → Pair
Redemption/refund), not a clean abandon. This accepts recovery-path handling of
the rare gap case in exchange for a fully 24/7 book (chosen over gating
multi-day-gap markets).

**Consequences.** The market-maker becomes a **continuous (24/7-while-open)**
service rather than intraday, or overnight/pre-market books are thin
(`docs/PRODUCTION_INFRA.md`). The directional guardrail (ID-016), PostOnly limits
(ID-005), and full-fill-or-revert market actions (ID-006) are unchanged. Product
framing ("same-day / trade the close") is unchanged. PRD §5 and ID-004 open
semantics move from session-bell to creation-relative.
