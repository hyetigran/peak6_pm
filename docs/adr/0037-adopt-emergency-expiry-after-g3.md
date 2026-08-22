# Adopt Emergency Expiry (amends ADR-0018)

Closes #15. ADR-0018 made the `emergency_expire_venue` one-way fuse conditional
on M0 proving (a) the pinned OpenBook operation and (b) the post-expiry recovery
path. This ADR records the disposition after G3.

**Decision: ADOPT.**

**Evidence (condition a — met).** G3 (`make g3`, `docs/adr/openbook-v2-pin.md`
§8) proved at the pinned OpenBook bytes: `set_market_expired` is admin-gated
(`close_market_admin` signer; wrong signer → `InvalidCloseMarketAdmin`), a true
**one-way fuse** (`time_expiry = -1`; re-expire rejected `MarketHasExpired`),
`prune_orders` requires expired (proven both ways), and cancellation/settlement
remain intact afterward. Meridian already wires the `emergency_expired` flag
into the mint/trade gates (`trading/mod.rs`, `mint_pair.rs`).

**Why adopt (not reject).** ADR-0033's rolling creation opens trading when the
market exists, so after `activity_started` `abandon_market` is unusable; a late
disqualifier (a weekend corporate action on a market that already went live) has
**no clean recovery without Emergency Expiry**. #21's pre-open gate only catches
markets before they go live. Rejecting the fuse would leave that live-gap
unhandled — the design already depends on this path.

**Scope + authority (V1).**
- Fires only via the **Pause Authority**, through the dedicated venue-close
  signer, on a market that is **paused and pre-close**.
- Sets an **immutable flag + reason**; the market stays **permanently paused**.
- Post-expiry, **cancellation, event consumption, fund settlement, Pair
  Redemption, Settlement, and Outcome Redemption remain available**. The
  operator hot key cannot fire it; it is not a settlement or override power.

**Condition (b) — carried to #17.** The *full* post-expiry recovery exercise
(Pair Redemption → Settlement → Outcome Redemption end-to-end after the fuse
fires) needs M1 program state and is tracked by the go/no-go (#17). Adoption is
**conditional on that recovery test passing** — exactly ADR-0018's own
requirement. If any recovery test fails, the instruction is removed from V1 per
ADR-0018; this ADR is then superseded.

Relates to #15 (this decision), ADR-0018 (conditional fuse), ADR-0033 (live-gap
dependency), #21 (pre-open gate, the complementary pre-activity path), #17
(recovery-test gate).
