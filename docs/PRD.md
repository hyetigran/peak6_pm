# Meridian — Implementation Plan (OpenBook V2)

**Version:** 0.6  
**Date:** 2026-08-19  
**Spec:** `meridian-spec.md` — converted from the source PDF; the PDF remains source of truth.  
**Supersedes:** `meridian-plan-openbook-v2-v0.5.md`.  
**Build posture:** OpenBook V2 remains the approved V1 venue. v0.6 is a closure revision: it restores spec coverage dropped in v0.5 and pins the remaining OpenBook-specific safety surfaces before M0.

---

## 0. v0.5 Adversarial Review Closure Ledger

The v0.5 review approved the OpenBook architecture but failed build handoff because required spec capabilities had drifted out of the plan and several OpenBook integration details were underspecified. v0.6 closes those findings without changing the venue architecture.

| Finding | v0.6 disposition |
|---|---|
| **C1(a) Add Strike missing** | **Closed.** `add_strike` restored as an operator instruction with full market-creation/venue-attachment flow, automation/runbook support, tests, and traceability. |
| **C1(b) Position constraints missing** | **Closed.** Frontend-only position constraints restored as ADR-016; Trade UX, Playwright tests, success criteria, and traceability restored exactly to spec posture. |
| **C1(c) Required UI elements missing** | **Closed.** Live underlying/oracle prices, implied Yes/No probability, contract cards, implied No price, and the payoff sentence are normative frontend requirements and tests. |
| **C1(d) Multi-user integration test missing** | **Closed.** Restored verbatim: one user mints/quotes, another takes, both settle/redeem. |
| **C1(e) Strike-engine worked vectors missing** | **Closed.** META $680 and AAPL $230 examples are pinned verbatim as test vectors. |
| **C1(f) token-destruction interpretation widened** | **Closed structurally, confirmation retained.** User-facing Sell No calls `redeem_pair_via_market`, explicitly modeled as **take + pair-redemption** and sharing the same internal pair-redemption primitive as `redeem_pair`. I3 now treats destruction as pair redemption or outcome redemption. Q1 is restored for spec-owner confirmation. |
| **H1 referrer rebates** | **Closed with a narrower, source-accurate policy.** `place_take_order` has no referrer account and explicitly does not pay referrers. Referral diversion can arise through OpenOrders taker activity + `settle_funds`. Therefore all V1 limit orders are **PostOnly** and may never become takers; wrapper verifies an order actually posted. Market/taker paths use `place_take_order`. `settle_funds` is wrapped by Meridian for Meridian-created OpenOrders and forces `referrer_account=None`; direct settle remains a tested hostile path, and fee-bearing V1 is gated on proving no referrer rebate can accrue on the supported order surfaces. G9 is full fee-flow conservation. |
| **H2 self-trade behavior** | **Closed.** Limit wrapper overwrites `self_trade_behavior=AbortTransaction` even though PostOnly prevents crossing. `place_take_order` has no self-trade field and uses no taker OpenOrders account; economic self-cross against the user's own resting order is documented and tested separately. UI offers cancel-own-orders before Sell No. |
| **H3 EventHeap saturation** | **Closed by product policy.** Taker builders provide up to 15 expected maker OpenOrders accounts as OpenBook remaining accounts so maker fills settle inline. If heap pressure exceeds threshold, the same wallet transaction prepends bounded `consume_events`. Keeper has numeric SLOs. Exit actions fail closed rather than silently partial-fill if neither mitigation fits. G6/G7 include saturation variants. |
| **H4 mint window only narrative** | **Closed.** `mint_pair` has the normative gate `state == Active && mint_open_ts <= now < close_ts && !paused`; I9 and boundary tests added. |
| **H5 release commit supposedly unverifiable** | **Review correction.** Official OpenBook GitHub release metadata for deployed tag v1.7 records GitHub commit `796a470` and build SHA-256 `a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8`. v0.6 retains both but G1 independently verifies the deployed devnet program against the release before use. |
| **H6 close-No fee corner / incidental costs** | **Closed.** Separate compile-time `MAX_TAKER_FEE_BPS = 101`; claim-fee cap remains separately configurable. All OpenBook SOL penalties/rent are wallet/operator-paid, never collateral-vault-paid. The OpenBook 500-lamport EventHeap penalty payer is explicit. Economic self-cross semantics are tested. |
| **H7 Buy-No-limit one approval** | **Closed as hard compliance gate.** One-approval atomic Buy-No-limit is a G7 pass requirement. v0+ALT and an OpenOrders setup mitigation ladder are specified. If the full transaction cannot fit, that is an explicit stakeholder-approved spec deviation, not a silent fallback. |
| **M1 fee-unit conversion undefined** | **Closed.** OpenBook uses 1e-6 fee units: `openbook_fee = bps * 100`; golden vectors required. |
| **M2 order expiry + crossing-limit UX** | **Closed.** Order-level expiry boundary tests added. V1 limit orders are PostOnly; a crossing limit is rejected with an explicit UI message and cannot accidentally pay taker/referrer fees. |
| **M3 pause wording / hard halt** | **Closed.** Pause explicitly freezes directional trading exits (`Sell Yes`, `Sell No`) because those are trading. Custody/recovery exits remain available. `set_market_expired` is evaluated in M0 as an **irreversible emergency-expire** defense-in-depth, not ordinary pause/unpause. |
| **M4 snapshot enumeration incomplete** | **Closed.** Every snapshotted settlement/feed/fee field is enumerated in §7.1 and I8. |
| **M5 GPL adapter posture** | **Closed.** Fallback CPI adapter may be derived only from MIT-licensed IDL/client/account-layout interfaces; no GPL program-source copying. |
| **M6 G7 coverage gaps** | **Closed.** `create_strike_market` metadata CPI and remaining-account taker variants are explicit transaction/CU gates. |
| **M7 indexer details** | **Closed.** OpenOrders discovery derives the per-wallet OpenOrdersIndexer and reads its account list; crank thresholds are specified provisionally and calibrated by G6. |

### Gate posture after this revision

v0.6 has **no unresolved venue-architecture decision**. Remaining open inputs are product/external choices such as stock-data provider and the spec-owner Q1 interpretation. Implementation begins with M0 only after G1–G10 pass.

---

## 1. Executive Summary

Meridian is a non-custodial Solana dApp for same-day binary outcome markets on MAG7 US-equity closes. Each strike has a pair of fully collateralized Yes/No SPL tokens. A single Yes/USDC OpenBook V2 market provides price discovery for both Yes and No perspectives. Settlement reads an on-chain oracle after the regular-session close; the winning token redeems for $1 USDC and the losing token for $0.

### V1 stack

- **Chain:** Solana devnet.
- **Meridian program:** Rust + Anchor.
- **CLOB:** **OpenBook V2 deployed v1.7**, one Yes/USDC market per strike.
- **OpenBook program:** `opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb`.
- **Release metadata:** commit `796a470`; build SHA-256 `a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8`; independently re-verified in G1.
- **Trading authority:** per-market Meridian PDA installed as OpenBook `open_orders_admin`.
- **Hard close:** Meridian `now < close_ts` order gate plus OpenBook `time_expiry = close_ts - 1`.
- **Oracle:** Switchboard On-Demand, immutable versioned PRICE + OBS_TS feed pairs.
- **Tokens:** classic SPL Token, 6 decimals, immutable Metaplex metadata.
- **Frontend:** Next.js + Metaplex Umi/wallet-adapter; OpenBook client isolated behind an adapter boundary.
- **Automation:** creation, EventHeap keeper, settlement, fee sweep, venue cleanup.
- **Indexer:** Meridian + OpenBook event/account indexing to SQLite + REST/WS.

### Why OpenBook V2

OpenBook supplies the existing on-chain CLOB while exposing the control Meridian needs:

- `open_orders_admin` must sign order creation, including `place_take_order`;
- market `time_expiry` rejects trading after expiry;
- `close_market_admin` can expire/prune/close a market;
- `collect_fee_admin` gates fee sweeping;
- `place_take_order` settles the taker-side tokens in the transaction;
- maker bookkeeping can be handled inline with remaining accounts or asynchronously through EventHeap/`consume_events`.

Meridian therefore enforces every order creation with:

```text
market.state == Active
&& trade_open_ts <= now
&& now < close_ts
&& !config.paused
&& !market.paused
```

while leaving custody/recovery operations available.

---

## 2. Source-of-Truth Requirement Inventory

The following source-spec requirements are normative for V1 and must appear in traceability and tests.

### Product and lifecycle

- MAG7: AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA.
- Same-day 0DTE markets.
- Morning previous-close read and automated strike creation.
- ±3%, ±6%, ±9% strikes, rounded to nearest $10, deduplicated; optional ATM/rounded previous close.
- Admin/operator may **add a strike intraday**.
- Minting enabled at 09:00 ET.
- Live trading begins at 09:30 ET.
- Trading/minting closes at 16:00 ET or the calendar-defined early close.
- Settlement target ~16:05; SLO ≤10 minutes; degraded retry example to +15 minutes.
- Delayed manual override only after at least one hour.
- Indefinite redemption.

### Trading

- Exactly one Yes/USDC order book per strike.
- Four first-class intents: Buy Yes, Buy No, Sell Yes, Sell No.
- Buy Yes market + limit.
- Buy No market + limit, with one approval and atomic mint+order semantics.
- Sell Yes market + limit.
- Sell No simple automatic close; no V1 Sell-No limit requirement is claimed.
- Position constraints are **frontend-enforced**: UI does not let a user intentionally open Yes while holding No, or No while holding Yes, without guiding them to close first.

### Contract safety

- $1 collateral per pair/accounted liability.
- Yes payout + No payout = $1.
- Token creation only through pair creation.
- Token destruction only through the approved redemption interpretation (Q1).
- Settlement immutable.
- Oracle freshness + quality checks.
- Pause/unpause minting and trading.

### Frontend

- Landing, Markets, Trade, Portfolio, History.
- Live underlying/oracle prices.
- Contract cards with strike, Yes/No price, implied probability.
- One book shown from Yes and mirrored No perspectives.
- Buy/Sell Yes/No controls.
- Settlement countdown.
- Payoff sentence: `You pay $X. You win $1.00 if [STOCK] closes above [STRIKE].`
- Portfolio entry/current price, P&L, settlement, redemption.

### Testing and deployment

- Smart-contract unit/invariant/oracle/override tests.
- Full lifecycle integration.
- All four trade paths.
- Multi-user maker/taker scenario.
- Frontend tests including position constraints and live price display.
- Solana devnet deployment.
- Reproducible scripts and one-command setup.

---

## 3. OpenBook V2 Facts and Pin

These facts are load-bearing. M0 must re-read them from the pinned v1.7 release/program, not moving `master`.

1. Market state includes `time_expiry`, `collect_fee_admin`, optional `open_orders_admin`, optional `consume_events_admin`, optional `close_market_admin`, maker fee and taker fee.
2. `open_orders_admin` is documented as the admin that must sign all order creation; IDL includes it on both resting-order creation and `place_take_order`.
3. OpenBook's expiry predicate is strict: `time_expiry != 0 && time_expiry < now`.
4. `place_take_order` rejects an expired market and performs immediate taker token transfer.
5. `place_take_order` has no `referrer_account` and the pinned implementation explicitly does not pay referrers on that path.
6. `settle_funds` has an optional `referrer_account`; if present, accumulated referral rebate is paid there; if absent, that rebate is added to `fees_available`.
7. Fee scale is 1e-6: 1 bp = 100 OpenBook fee units.
8. `PlaceOrderArgs` includes explicit `self_trade_behavior`; `PlaceTakeOrderArgs` does not.
9. `SelfTradeBehavior` values are DecrementTake / CancelProvide / AbortTransaction.
10. Matching code can process maker fills inline when the maker OpenOrders account is provided in remaining accounts; otherwise it pushes the fill to EventHeap. Inline processing is bounded to 15 fill remaining accounts.
11. A `place_take_order` that adds EventHeap entries charges a **500 lamport** EventHeap penalty to `penalty_payer`.
12. `consume_events` exists to apply EventHeap maker bookkeeping; setting `consume_events_admin=None` keeps it permissionless.
13. `set_market_expired`, `prune_orders`, and `close_market` are controlled by `close_market_admin`.
14. Classic OpenBook market/orderbook/EventHeap accounts are large enough that rent is an M0 hard gate.
15. The majority of the repository is MIT, while GPL code is behind `enable-gpl`; using the crate via `client`/`cpi` features is intended to use only MIT portions.

### Pinned deployment

```text
OPENBOOK_PROGRAM_ID       = opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb
OPENBOOK_DEPLOYMENT_TAG   = v1.7
OPENBOOK_RELEASE_COMMIT   = 796a470
OPENBOOK_BUILD_SHA256     = a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8
```

G1 independently verifies that the devnet executable matches the official v1.7 release/build record. If it does not, implementation stops and the pin is corrected before any CPI builder is trusted.

---

## 4. Architecture Decision Records

### ADR-001 — Solana + Anchor, pinned OpenBook integration — ACCEPTED

Solana devnet + Rust/Anchor for Meridian.

Integration preference:

1. use OpenBook's MIT `cpi`/`client` feature surface at the pinned compatible revision;
2. if Anchor-version incompatibility blocks that path, implement a **minimal CPI adapter from the MIT IDL/client/account layouts only**;
3. golden-test instruction discriminators, serialized args, account order, signer/writable flags, and expected program ID against the official v1.7 client;
4. do not copy or derive the fallback adapter from GPL program implementation source.

No OpenBook fork enters V1.

---

### ADR-002 — OpenBook V2 venue and authorities — ACCEPTED

Each Meridian strike gets one OpenBook market:

```text
base_mint            = Meridian Yes mint
quote_mint           = Config.quote_mint
open_orders_admin    = PDA["venue-trade", market]
collect_fee_admin    = PDA["venue-fee", market]
consume_events_admin = None
close_market_admin   = PDA["venue-close", market]
time_expiry          = close_ts - 1
oracle_a             = None
oracle_b             = None
maker_fee            = 0
taker_fee            = bps_to_openbook(snapshot.taker_fee_bps)
```

OpenBook is created at ~08:30 immediately after the Yes mint exists. Trading remains impossible until Meridian starts signing at `trade_open_ts`.

---

### ADR-003 — Hard trading authorization — ACCEPTED

Meridian is the only order-creation gateway.

Every order wrapper:

- derives and signs as `venue_trade_authority`;
- pins the OpenBook program and attached market;
- checks time/state/pause;
- pins order type, expiry, fee-relevant fields, and account destinations;
- rejects arbitrary venue account substitution.

No client-supplied `open_orders_admin`, expiry, self-trade mode, market/vault address, fee mode, or program ID is trusted.

#### Custody/recovery actions

The following remain available even when trading is paused:

- cancel / cancel all;
- `consume_events`;
- Meridian-wrapped `settle_openbook_funds`;
- close empty OpenOrders accounts;
- `redeem_pair` before settlement;
- `redeem_outcome` after settlement.

**Directional exits are trading and therefore pause:** Sell Yes, Sell No, and any market/limit order are blocked while paused. This is intentional and matches the spec's "pause trading" requirement.

---

### ADR-004 — Open/close and emergency expiry — ACCEPTED

#### Normal open

```text
now < trade_open_ts        -> Meridian signs no orders
trade_open_ts <= now       -> order gate may open
```

#### Normal close

Two layers:

```text
Meridian: now < close_ts
OpenBook: time_expiry = close_ts - 1
```

At `now == close_ts`, Meridian rejects and OpenBook is already expired under its strict predicate.

#### Emergency expiry

`set_market_expired` is **not** ordinary pause/unpause because it is treated as irreversible for the daily venue lifecycle.

M0 evaluates a Meridian `emergency_expire_venue` CPI signed by `venue_close_authority`. If enabled, it is a one-way circuit breaker used only when the venue itself must be hard-expired early. Normal pause remains reversible wrapper gating.

---

### ADR-005 — Limit orders are PostOnly in V1 — ACCEPTED

All V1 limit orders use OpenBook `PostOnly`.

Reasons:

- the spec's Buy-No limit story explicitly describes posting Yes at the chosen limit;
- it prevents a nominal "limit" action from unexpectedly acting as a taker;
- it prevents OpenOrders taker-referral accounting from entering the supported V1 path;
- taker fees are therefore exclusive to explicit market actions;
- immediate execution remains available through the first-class Market action.

Wrapper behavior:

```text
order_type          = PostOnly
self_trade_behavior = AbortTransaction
expiry_timestamp    = close_ts - 1
```

The wrapper verifies an order ID was actually posted. If the order would cross and OpenBook returns no posted order, Meridian returns `LimitWouldCross`; the whole transaction reverts. UI says: **"This limit would execute immediately. Use Market or choose a non-crossing price."**

Crossing limits never silently incur taker fees.

---

### ADR-006 — Market/taker actions: full-fill-or-revert — ACCEPTED

Explicit market actions use OpenBook `place_take_order` via Meridian CPI.

Because `place_take_order` may execute partially, Meridian implements `take_full`:

1. validate all accounts and price bound;
2. snapshot source/destination balances;
3. CPI OpenBook `place_take_order`;
4. reload balances;
5. compute exact base executed;
6. require `executed_base == requested_base`;
7. otherwise return error, rolling back the entire Solana transaction.

#### EventHeap mitigation supplied to the same CPI

The transaction builder queries the current top-of-book maker OpenOrders accounts from the indexer and supplies up to OpenBook's inline limit (15) as `remaining_accounts`. OpenBook can then apply maker fills inline rather than push them to EventHeap.

If heap pressure is above threshold, the wallet transaction additionally prepends bounded permissionless `consume_events` before `take_full`.

The supported market action therefore has three layers:

```text
optional consume_events
        -> take_full
             -> remaining maker OO accounts
             -> post-CPI exact-fill assertion
```

All size/CU variants are G7 hard gates.

---

### ADR-007 — EventHeap saturation policy — ACCEPTED

EventHeap is not treated as "keeper eventually fixes it." It has explicit product behavior.

#### Inline-first

For every market action, supply up to 15 expected maker OpenOrders accounts as remaining accounts. The indexer derives them from the current book nodes.

#### Pre-consume fallback

If either is true:

```text
heap_depth >= 50% capacity
oldest_event_age >= 2 seconds during close window
```

transaction builder prepends a bounded `consume_events` instruction using the oldest known maker accounts.

#### Keeper SLOs

Provisional until G6 measures actual capacity/latency:

- 09:30–15:55: heap depth <25% capacity; oldest event <5 s.
- 15:55–close: heap depth <10% capacity; oldest event <2 s.
- ≥50% capacity: priority-fee escalation.
- ≥75% capacity: critical alert; market UI warns; market actions use inline + pre-consume only.
- if the safe composed transaction cannot be built within Solana limits, the action fails closed with a retriable "venue backlog" error; it never accepts partial synthetic exposure.

M0/G6 calibrates thresholds but may only tighten them without a new ADR.

---

### ADR-008 — Fee/referrer policy — ACCEPTED

Fees initialize to zero. V1 exposes claim and taker switches subject to separate caps; maker fee is hard-zero.

#### Exact OpenBook conversion

OpenBook fee scale is `1_000_000` and 1 bp = 100 units:

```text
bps_to_openbook(bps: u16) -> i64 = bps * 100
```

Golden vectors:

```text
0 bp   -> 0
1 bp   -> 100
25 bp  -> 2_500
100 bp -> 10_000
101 bp -> 10_100
```

`attach_venue` checks exact integer equality.

#### Fee caps

```text
MAX_TAKER_FEE_BPS = 101
MAX_CLAIM_FEE_BPS = 500
MAKER_FEE_BPS      = 0 in V1
```

The 101 bp taker cap guarantees a 99-cent Yes purchase plus taker fee remains ≤$1 per contract under the OpenBook ceil-fee formula, preserving `redeem_pair_via_market` feasibility.

#### Referral surface

Supported V1 order surfaces deliberately avoid referral-bearing taker OpenOrders:

- Market actions: `place_take_order` — no referrer account.
- Limit actions: PostOnly — they never take.
- `settle_openbook_funds`: Meridian wrapper forces `referrer_account=None`.

If a direct OpenBook caller settles a Meridian OpenOrders account with an arbitrary referrer, G9 must prove that **supported V1 behavior cannot have accumulated a nonzero referral rebate** on that account. If that proof fails, nonzero taker fees remain disabled in compliant V1.

#### Full fee-flow conservation gate

For a fee-enabled scripted session:

```text
OpenBook taker fees charged
== protocol sweepable fees
 + maker rebates (must equal configured expectation)
 + referral payouts (must equal 0 for supported V1)
```

Then:

```text
Meridian accounted_protocol_fees
== exact treasury delta from collect_venue_fees
```

No off-chain event mutates fee accounting.

---

### ADR-009 — SOL/rent/penalty cost bearing — ACCEPTED

Collateral vaults contain USDC only and never fund SOL costs.

For `place_take_order`:

- standard user market trade: `penalty_payer = user wallet`;
- `redeem_pair_via_market` Sell-No flow: OpenBook signer may be a Meridian PDA, but `penalty_payer = user wallet` as the separate signer;
- OpenBook's 500-lamport penalty when new EventHeap entries are added is therefore user-paid;
- keeper/automation transactions are operator-paid;
- account-creation rent is payer/user/operator according to the documented UX, never a collateral vault.

G5 asserts no lamport debit path can use a collateral PDA/vault as penalty payer.

---

### ADR-010 — Collateral liability accounting — ACCEPTED

`collateral_liability_units` is the single accounted $1 liability count.

Before settlement:

```text
mint_pair(q)                 -> liability += q
redeem_pair(q)               -> liability -= q
redeem_pair_via_market(q)    -> liability -= q
```

Settlement:

```text
liability unchanged
```

After settlement:

```text
redeem losing q              -> liability unchanged
redeem winning q             -> liability -= q
```

Solvency:

```text
accounted_collateral = collateral_liability_units * 1_000_000
vault_balance >= accounted_collateral
surplus = vault_balance - accounted_collateral
```

Donations cannot DoS the protocol.

---

### ADR-011 — Redemption model and Sell-No — ACCEPTED, Q1 confirmation retained

Token destruction is expressed as two redemption families:

1. **Pair redemption before settlement**
   - `redeem_pair(q)` when the user already holds Yes+No.
   - `redeem_pair_via_market(q, max_yes_price)` for user-facing Sell No: acquire the missing Yes through OpenBook, then execute the same internal pair-redemption primitive.
2. **Outcome redemption after settlement**
   - `redeem_outcome(q, side)`.

`redeem_pair_via_market` is not modeled as an independent burn primitive. Internally:

```text
acquire missing Yes
-> apply_pair_redemption(Yes + No)
-> withdraw par less actual acquisition spend
```

Post-settlement pair redemption is prohibited to prevent claim-fee bypass.

Redemption minimum = **1 token atom**. Claim fee:

```text
fee = min(gross, ceil(gross * claim_fee_bps / 10_000))
```

**Q1 remains open:** spec owner confirms that pair-redemption instructions are an acceptable interpretation of "tokens can only be destroyed via the redeem function."

---

### ADR-012 — Four trade paths — ACCEPTED

#### Buy Yes — Market

```text
meridian.take_full(Bid, q, max_yes_price)
```

#### Buy Yes — Limit

```text
[OO setup if needed,
 meridian.place_limit_order(PostOnly Bid, q, price)]
```

#### Sell Yes — Market

```text
meridian.take_full(Ask, q, min_yes_price)
```

#### Sell Yes — Limit

```text
meridian.place_limit_order(PostOnly Ask, q, price)
```

#### Buy No — Market

```text
[
  meridian.mint_pair(q),
  meridian.take_full(Ask, q, min_yes_price)
]
```

The user temporarily funds `$1 × q`; the Yes sale must fill completely or the entire transaction reverts. Effective No cost is `$1 - net Yes proceeds`.

#### Buy No — Limit — strict one-approval requirement

```text
[
  create OpenOrdersIndexer if absent,
  create OpenOrdersAccount if absent,
  meridian.mint_pair(q),
  meridian.place_limit_order(PostOnly Ask, q, 100-NoPrice)
]
```

This entire intent must fit one wallet transaction/approval to claim spec compliance.

G7 mitigation order:

1. Solana v0 transaction + Address Lookup Table for stable program/market accounts.
2. Remove optional instructions/accounts and use pre-existing ATAs where standard.
3. If the user already has OpenOrders infrastructure, use it naturally — but this cannot be used to claim the first-use compliance gate passed.
4. If the **first-use** full composite still cannot fit, M0 fails the strict requirement and requires explicit stakeholder waiver before a two-approval UX is implemented.

#### Sell No — Market

Frontend "Sell No" calls:

```text
meridian.redeem_pair_via_market(q, max_yes_price)
```

Inside:

1. require user No balance >= q;
2. pin all Meridian/OpenBook/vault accounts;
3. snapshot collateral vault and program Yes-trade ATA;
4. CPI `place_take_order(Bid)` using collateral vault as quote source and program Yes-trade ATA as base destination;
5. `penalty_payer = user`, never vault;
6. require exactly q Yes acquired;
7. compute `yes_cost` from collateral-vault delta;
8. require `yes_cost <= q × $1` and user price bound;
9. call internal `apply_pair_redemption` to burn acquired Yes + user's No;
10. pay user `q × $1 - yes_cost`;
11. decrement liability q;
12. assert vault delta = exactly `$1 × q` from pre-instruction to post-instruction.

Economic self-cross against the user's own resting Yes ask is permitted by OpenBook's `place_take_order` model and remains solvent because cost is measured from vault delta. UI detects known own resting asks and offers **Cancel own Yes orders first** to avoid pointless self-fills. Integration tests cover the only-liquidity-is-own-order case.

#### Sell No — Limit

Not V1; the source Sell-No story does not require a resting limit close. No one-approval claim is made.

---

### ADR-013 — Mint window — ACCEPTED

`mint_pair` is normatively gated:

```text
market.state == Active
&& mint_open_ts <= now
&& now < close_ts
&& !config.paused
&& !market.paused
```

No mint before 09:00, after close, on `Created`, `Settled`, `Abandoned`, or paused markets.

---

### ADR-014 — Switchboard immutable feed versions — ACCEPTED

Governance registers immutable `FeedVersion` objects per ticker:

```text
FeedVersion {
  version_id,
  ticker,
  price_feed,
  price_feed_hash,
  obs_ts_feed,
  obs_ts_feed_hash,
  provider_id,
  activated_day
}
```

Changing provider or job definition creates a **new** feed pair/version. Existing feeds referenced by unsettled markets are never mutated.

---

### ADR-015 — Settlement contract — ACCEPTED DESIGN

For trading date D, use the provider-designated official regular-session close for D.

Market snapshots all settlement terms:

```text
price_feed
price_feed_hash
obs_ts_feed
obs_ts_feed_hash
provider_id
feed_version_id
finalization_delay_secs
settle_window_secs
obs_tail_secs
obs_window_secs
min_samples
max_stale_slots
max_price_band_bps
override_delay_secs
claim_fee_bps
taker_fee_bps
```

Defaults:

```text
finalization_delay = 300 s
settle_window      = 900 s
override_delay     >= 3600 s
```

`settle_market` validates:

1. feed pubkeys match snapshots;
2. feed job hashes match snapshots;
3. both feed publications are in `[close_ts + finalization_delay, close_ts + settle_window]`;
4. OBS_TS value is inside calibrated close-session bounds;
5. Switchboard freshness/sample checks pass;
6. price > 0;
7. fixed-point normalization succeeds;
8. sanity band vs previous close passes.

M3 must prove PRICE and OBS_TS come from the same immutable provider record keyed by ticker + session date. Provider failure to meet that contract is a provider go/no-go failure, not a reason to weaken checks.

Timing:

- start ~close+5m;
- incident alert close+10m;
- retry to close+15m;
- override only after snapshotted >=1h delay.

---

### ADR-016 — Position constraints — ACCEPTED, frontend-enforced

As the spec explicitly directs, the frontend checks token balances before presenting/opening directional positions:

- if wallet holds No for a strike, Buy Yes is disabled and UI guides the user to Sell No first;
- if wallet holds Yes, Buy No is disabled and UI guides the user to Sell Yes first;
- transfers can still create Yes+No holdings because tokens are freely transferable; this is economically harmless and cannot be made airtight on-chain without changing token semantics;
- pair holdings remain redeemable before settlement.

This is a **UI/product constraint**, not an on-chain invariant.

Playwright tests cover the exact constraint behavior.

---

### ADR-017 — Frontend/client stack — ACCEPTED

- Next.js.
- Metaplex Umi + wallet-adapter + `walletAdapterIdentity`.
- Codama-generated Umi client for Meridian.
- Official/pinned OpenBook TS client behind `packages/openbook-adapter`.
- Raw web3.js/Anchor/OpenBook types stay at the adapter boundary.
- Order creation always invokes Meridian instructions; the app never directly constructs supported OpenBook order-creation transactions.
- Direct OpenBook cancel/consume plumbing may be built by the adapter because those operations are intentionally permissionless/user-authorized recovery paths.

---

## 5. Daily Lifecycle

```text
08:00 ET
  fetch previous close
  generate ±3/6/9% strikes + optional ATM
  round $10, dedupe

08:30 ET
  per strike:
    create_strike_market
      -> Yes/No mints
      -> immutable metadata
      -> collateral vault
      -> program Yes-trade ATA
      -> settlement/fee/feed snapshots

    create OpenBook market
      -> base Yes / quote USDC
      -> Meridian trade/fee/close PDAs
      -> consume admin None
      -> expiry close_ts - 1

    attach_venue
      -> validate exact header/config
      -> state Active

09:00 ET
  mint_pair window opens

09:30 ET
  trading wrapper opens

intraday
  users trade
  keeper consumes events
  indexer updates book/history/P&L
  operator may add_strike -> same create/OpenBook/attach pipeline

15:55 ET
  oracle/provider health preflight
  keeper enters close-window SLO

16:00 ET or calendar early close
  mint gate closes
  trading wrapper closes
  OpenBook market expired by time_expiry

~close+5m
  crank PRICE + OBS_TS
  settle markets

close+10m
  SLO incident if any unresolved

through close+15m
  retry every 30s

post-close
  drain EventHeap
  cancel/prune expired orders
  settle user OpenOrders funds
  collect venue fees
  users redeem outcomes

>= close+1h
  emergency override eligible for still-unsettled markets
```

### Intraday `add_strike`

`add_strike(ticker, strike, day)` is operator-only and allowed while:

```text
now < close_ts
config not globally paused for creation
unique (ticker,strike,day) PDA
strike passes $10-multiple / ticker validation
current FeedVersion exists
```

It executes the same lifecycle as morning creation:

```text
add_strike/create_strike_market equivalent
-> OpenBook create
-> attach_venue
```

The added market snapshots the current **future-safe active config/feed version** allowed for that trading day; config changes scheduled for future days do not alter existing or intraday markets.

---

## 6. Strike Engine

Formula in fixed point:

```text
raw = prev_close * (1 + offset_bps / 10_000)
strike = round_half_up(raw / $10) * $10
```

Offsets:

```text
[-900, -600, -300, +300, +600, +900]
```

Optional ATM = previous close rounded to nearest $10.

Deduplicate equal rounded strikes.

### Required verbatim acceptance vectors

#### META previous close $680

Expected with ATM enabled:

```text
$620, $640, $660, $680, $700, $720, $740
```

#### AAPL previous close $230

Raw rounded set contains duplicates; after dedupe expected:

```text
$210, $220, $230, $240, $250
```

Tests also cover half-up boundaries, negative/overflow guards, deterministic ordering, and ATM on/off.

---

## 7. On-Chain Program Design

### 7.1 Accounts and snapshots

#### Config

Stores:

- `governance`, pending governance;
- `operator`;
- `fee_admin`;
- `pause_authority`;
- `override_authority`;
- quote mint;
- global pause;
- current/future-day fee config;
- current/future-day settlement config;
- FeedVersion registry + active version pointer per ticker;
- `accounted_protocol_fees`;
- `accounted_surplus`.

Compile-time caps/floors:

```text
MIN_OVERRIDE_DELAY_SECS = 3600
MAX_TAKER_FEE_BPS       = 101
MAX_CLAIM_FEE_BPS       = 500
MAKER_FEE_BPS            = 0
```

#### Market

Stores explicitly:

```text
identity:
  ticker
  strike_1e6
  trading_day
  prev_close_1e6

lifecycle:
  mint_open_ts
  trade_open_ts
  close_ts
  state
  paused

outcome:
  settlement_price_1e6
  outcome
  settled_ts
  admin_settled

assets:
  yes_mint
  no_mint
  collateral_vault
  program_yes_trade_ata

venue:
  openbook_market
  bids
  asks
  event_heap
  venue_trade_authority_bump
  venue_fee_authority_bump
  venue_close_authority_bump

oracle/feed snapshot:
  feed_version_id
  provider_id
  price_feed
  price_feed_hash
  obs_ts_feed
  obs_ts_feed_hash

settlement snapshot:
  finalization_delay_secs
  settle_window_secs
  obs_tail_secs
  obs_window_secs
  min_samples
  max_stale_slots
  max_price_band_bps
  override_delay_secs

fee snapshot:
  taker_fee_bps
  claim_fee_bps

accounting:
  collateral_liability_units
```

No generic "settlement params" bucket is acceptable in code/IDL; fields above are individually testable.

#### Treasury

USDC ATA owned by treasury PDA.

Accounting:

```text
accounted_protocol_fees
accounted_surplus
raw treasury balance >= sum(accounted ledgers)
```

---

### 7.2 Instruction set

| Instruction | Caller | Gates / effect |
|---|---|---|
| `initialize_config` | deployer | initialize roles, quote, treasury |
| `set_fees` | fee_admin | caps; next-trading-day activation only |
| `set_params` | governance | floors; next-trading-day activation only |
| `register_feed_version` | governance | append immutable feed version |
| `activate_feed_version` | governance | future-day pointer only |
| `rotate_role` / `accept_role` | governance/incoming | two-step role transfer |
| `create_strike_market` | operator | unique; create mints/metadata/vault/trade ATA; write snapshots; state `Created` |
| `add_strike` | operator | intraday create-strike path; same validation/snapshots |
| `attach_venue` | operator | exact OpenBook validation; state `Created -> Active` |
| `abandon_market` | operator | `Created`, no venue/liability; closes only reclaimable Meridian accounts |
| `mint_pair` | anyone | **Active; mint_open_ts <= now < close_ts; not paused**; deposit $1/pair; mint Yes+No; liability += q |
| `redeem_pair` | holder | pre-settlement; burn equal Yes+No; pay $1/pair; liability -= q |
| `place_limit_order` | user | hard trading gate; PostOnly; fixed self-trade/expiry; CPI OpenBook |
| `take_full` | user | hard trading gate; CPI `place_take_order`; exact-full-fill postcondition |
| `redeem_pair_via_market` | No holder | hard trading gate; acquire Yes via OpenBook then shared pair redemption |
| `settle_openbook_funds` | OO owner/delegate | recovery path; `referrer=None`; wallet pays penalties |
| `settle_market` | anyone | post-finalization; full oracle attestation; immutable outcome |
| `admin_settle` | override_authority | after snapshotted delay >= compile-time floor |
| `redeem_outcome` | holder | Settled; winner payout/claim fee; loser burn zero |
| `collect_venue_fees` | operator | CPI sweep; exact treasury delta -> accounted protocol fees |
| `capture_treasury_surplus` | fee_admin | raw excess -> accounted surplus |
| `skim_collateral_surplus` | fee_admin | only vault excess; move to treasury + accounted surplus |
| `withdraw_protocol_fees` | fee_admin | <= accounted protocol fees |
| `withdraw_surplus` | fee_admin | <= accounted surplus |
| `pause` / `unpause` | pause_authority | global/per-market mint + trading gate |
| `emergency_expire_venue` | pause/close authority, **only if M0 approves** | irreversible CPI `set_market_expired`; evented |

---

### 7.3 `attach_venue` exact validation

Reject unless:

```text
account.owner == PINNED_OPENBOOK_PROGRAM_ID
base_mint      == market.yes_mint
quote_mint     == config.quote_mint

base_lot_size  == 1_000_000
quote_lot_size == 10_000

open_orders_admin    == derived venue_trade_authority
collect_fee_admin    == derived venue_fee_authority
consume_events_admin == None
close_market_admin   == derived venue_close_authority

time_expiry == close_ts - 1

maker_fee == 0
taker_fee == market.taker_fee_bps * 100

oracle_a == None
oracle_b == None
```

Also store and cross-check bids, asks, EventHeap, market authority, and market vault addresses from the OpenBook market account.

---

### 7.4 Trading wrapper invariants

Every order-creation instruction validates:

```text
state == Active
trade_open_ts <= now < close_ts
!global_paused
!market_paused

openbook_program == pinned id
openbook_market  == attached market
bids/asks/heap   == stored addresses
base/quote vault == stored OpenBook vaults
open_orders_admin == derived trade PDA
price_lots in [1,99]
quantity is whole-token lots
```

#### Limit wrapper additionally overwrites

```text
order_type          = PostOnly
self_trade_behavior = AbortTransaction
expiry_timestamp    = close_ts - 1
```

and requires a returned posted order ID.

#### Market wrapper additionally overwrites/pins

```text
OpenBook place_take_order
user price bound
OpenBook remaining maker accounts <= 15
penalty_payer = user wallet
```

Then verifies exact base delta.

---

### 7.5 Invariants

#### I1 — Collateral solvency

```text
vault_balance >= collateral_liability_units * 1_000_000
```

#### I2 — Payout complement

```text
Yes payout + No payout == $1
```

including exact strike equality.

#### I3 — Token creation/destruction

Creation:

```text
mint_pair only
```

Destruction is through the **redemption family only**:

```text
pair redemption pre-settlement:
  redeem_pair
  redeem_pair_via_market -> shared apply_pair_redemption

outcome redemption post-settlement:
  redeem_outcome
```

Q1 requires spec-owner confirmation of this interpretation.

#### I4 — Settlement immutability

Outcome written once; Settled terminal.

#### I5 — Mandatory venue authorization

No OpenBook order creation on a Meridian market succeeds without Meridian's `venue_trade_authority` PDA signature.

#### I6 — Trading window

No order creation before `trade_open_ts`, while paused, or at/after `close_ts`.

#### I7 — Fee/surplus separation

```text
treasury_balance >= accounted_protocol_fees + accounted_surplus
```

Referral payouts on supported V1 surfaces must be zero before taker fee can be nonzero.

#### I8 — Market-term immutability

After Market creation, no privileged config action changes any snapshotted field listed in §7.1.

#### I9 — Mint window

```text
mint_pair succeeds iff:
  state == Active
  && mint_open_ts <= now < close_ts
  && !paused
```

#### I10 — Sell-No pair-redemption solvency

For `redeem_pair_via_market(q)`:

```text
exact_yes_acquired == q
actual_yes_cost <= q * $1
final_vault_delta == -q * $1
liability_delta   == -q
program_yes_trade_ata returns to pre-instruction balance
```

#### I11 — Supported fee-flow conservation

When taker fees enabled:

```text
referral payouts == 0
and exact fee accounting reconciles OpenBook state -> sweep -> Treasury -> Meridian ledger
```

---

## 8. OpenBook Market Parameters and Fee Math

### Lots

```text
base_lot_size  = 1_000_000 base atoms = 1 Yes token
quote_lot_size = 10_000 quote atoms   = $0.01 USDC
price_lots     = cents
```

Examples:

```text
1 lot  -> $0.01
65 lots -> $0.65
99 lots -> $0.99
```

Wrapper permits only 1–99.

### Taker fee conversion

```text
openbook_taker_fee = taker_fee_bps * 100
```

At max V1 101 bps and a 99-cent Yes:

```text
notional = 990,000 USDC atoms
fee = ceil(990,000 * 10,100 / 1,000,000)
    = 9,999 atoms
cost = 999,999 atoms <= $1
```

102 bps would exceed $1 at 99 cents, so it is rejected by compile-time cap.

---

## 9. Venue Cleanup and Rent

OpenBook cleanup never affects user solvency.

Post-expiry workflow:

1. keeper drains EventHeap;
2. owners cancel or close/prune removes expired book entries as allowed;
3. owners call `settle_openbook_funds`;
4. empty OpenOrders accounts may close;
5. `venue_close_authority` may close the OpenBook market only after OpenBook preconditions report market/book/EventHeap empty.

### Creation failure

Users cannot mint until `attach_venue` produces `Active`.

If creation fails before activation:

- retry valid venue attach;
- if abandonable, close reclaimable Meridian-owned accounts;
- classic SPL mints and Metaplex metadata are explicitly treated as non-reclaimable V1 creation cost;
- OpenBook account rent is reclaimed only through OpenBook-supported close semantics; no plan claim exceeds those semantics.

---

## 10. Automation Service

Node/TypeScript; `America/New_York`; single NYSE calendar module for holidays and early closes.

### 08:00 — strike generation

- fetch previous close;
- run deterministic engine;
- verify duplicates/limits;
- log planned markets.

### 08:30 — market creation

For each strike:

```text
create_strike_market
create OpenBook market
attach_venue
```

Idempotent/restart-safe.

### Intraday Add Strike

Operator command/API:

```text
make add-strike TICKER=META STRIKE=690
```

Runs same create/OpenBook/attach path and emits audit logs.

### Event keeper

Continuously:

- read EventHeap depth/oldest event;
- discover maker OpenOrders accounts from events/book/indexer;
- consume in bounded batches;
- ordinary SLO <25% / <5s;
- close-window SLO <10% / <2s;
- ≥50% priority escalation;
- ≥75% critical alert.

Thresholds are calibrated in G6 and stored in ops config; any looser production threshold requires documented review.

### 15:55 — oracle preflight

- provider reachable;
- active FeedVersion healthy;
- advisory independent-source cross-check.

### close+5m settlement

Per ticker:

```text
crank PRICE + OBS_TS
settle markets in idempotent batches
```

### close+10m

Incident alert if any market unresolved.

### close+15m

Stop normal retry loop; alert/runbook remains active.

### post-close

- aggressive EventHeap drain;
- collect venue fees through Meridian;
- venue cleanup attempts.

### >= close+1h

Override authority may settle unresolved markets following runbook and independent-source verification.

---

## 11. Indexer

### Inputs

- Meridian Anchor events.
- OpenBook events/logs.
- OpenBook Market, bids, asks, EventHeap.
- wallet OpenOrdersIndexer + listed OpenOrders accounts.
- wallet SPL Yes/No balances.

### OpenOrders discovery

For each tracked wallet:

1. derive its OpenBook `OpenOrdersIndexer` PDA;
2. fetch/decode it;
3. enumerate registered OpenOrders accounts;
4. fetch accounts and filter to Meridian-attached markets;
5. backfill relevant transactions/signatures.

No heuristic "relevant accounts" language remains.

### APIs

```text
GET /markets/:day
GET /underlyings
GET /book/:market
WS  /book/:market
GET /history/:wallet
GET /positions/:wallet
GET /open-orders/:wallet
GET /crank-health
```

`/crank-health` returns capacity, depth, percent full, oldest-event age, last consume signature/time, and SLO status.

### P&L contract

Platform-execution P&L only.

- transfer-in -> unknown cost basis;
- transfer-out -> reduce qty at average cost; no fabricated realized P&L;
- Buy No basis = $1 deposit - net Yes proceeds + trading fees;
- Sell No realized proceeds = $1 - actual Yes acquisition cost;
- unknown basis clearly badged.

Indexer is idempotent across duplicate logs, restart/backfill, and short chain reorgs.

---

## 12. Frontend

### Landing

Required:

- product explanation;
- live MAG7 underlying/oracle prices;
- connect-wallet CTA;
- active market counts.

### Markets

7-stock grid with:

- live underlying/oracle price;
- number of active strikes;
- nearest strikes;
- settlement/trading status.

### Trade

Required elements:

- contract cards with ticker, strike, expiry/status;
- current Yes price;
- **implied No price = $1 - Yes**;
- **implied probability** derived from Yes price and clearly labeled as market-implied, not forecast certainty;
- one OpenBook ladder rendered as Yes view + mirrored No view;
- Buy Yes / Buy No / Sell Yes / Sell No controls;
- Market and PostOnly Limit modes where spec requires;
- price/slippage/quantity;
- fee-inclusive estimate;
- countdown to `close_ts`;
- exact payoff sentence: `You pay $X. You win $1.00 if [STOCK] closes above [STRIKE].`;
- state for "limit would cross — use Market";
- EventHeap/backlog retriable error state.

### Position constraints

Before enabling directional buys:

```text
holds No > 0 -> Buy Yes disabled; guide to Sell No
holds Yes > 0 -> Buy No disabled; guide to Sell Yes
```

If both exist through transfers, UI offers `redeem_pair` before settlement.

### Buy-No-limit first-use UX

Strict target is one approval containing OO setup + mint + post order. G7 determines feasibility.

If G7 fails, no two-approval fallback may silently ship as compliant. The UI fallback is implemented only after explicit stakeholder deviation acceptance.

### Portfolio

Show separately:

- wallet Yes/No positions;
- unknown-basis badges;
- resting OpenBook orders;
- OpenBook free balances awaiting settlement;
- P&L;
- settled outcome and payout;
- Redeem buttons.

Post-close helper may compose:

```text
consume events if needed
cancel orders
settle_openbook_funds
redeem_outcome
```

If one transaction cannot fit, recovery/claim may be split; this does not violate the spec's trading one-approval requirement.

### History

Trade execution log from the indexer with market, side, price, quantity, fee, signature, timestamp, and realized P&L when basis is known.

---

## 13. Testing Strategy

### 13.1 Strike engine

- META $680 -> `$620,$640,$660,$680,$700,$720,$740`.
- AAPL $230 -> `$210,$220,$230,$240,$250` after dedupe.
- half-up boundaries.
- ATM on/off.
- deterministic ordering.
- duplicate elimination.

### 13.2 Core Meridian program

- all instruction gates;
- `add_strike` unique/late/pause/config cases;
- mint at `mint_open_ts - 1`, exact open, `close_ts - 1`, exact close, Settled;
- collateral liability transitions;
- one-atom redemption;
- donation/surplus;
- fee ceil math;
- per-market snapshots vs config changes;
- oracle stale/wrong feed/wrong hash/old OBS_TS/band/sample cases;
- override before/after delay;
- pause/unpause;
- token destruction only through redemption-family code paths.

### 13.3 OpenBook integration

#### Authorization

- direct `placeOrder` without trade PDA fails;
- direct `placeTakeOrder` without trade PDA fails;
- wrapper succeeds only in trading window;
- pause blocks maker + taker wrappers;
- exact close blocks;
- cancel/consume/settle recovery still succeeds while paused/closed.

#### Market expiry boundary

With `time_expiry = close_ts - 1`:

```text
close_ts - 2
close_ts - 1
close_ts
close_ts + 1
```

#### Order-level expiry boundary

PostOnly order `expiry_timestamp=close_ts-1` tested at the same four clock points; verify exact OpenBook per-order predicate independently from market expiry.

#### PostOnly semantics

- non-crossing Buy Yes posts;
- non-crossing Buy No ask posts;
- non-crossing Sell Yes posts;
- crossing order returns no post -> Meridian `LimitWouldCross` -> transaction rollback;
- no crossing limit taker fee;
- no referral rebate accrual from supported limit flow;
- wrapper ignores hostile self-trade/expiry/order-type client inputs.

#### Market paths

- Buy Yes full fill;
- Buy Yes insufficient liquidity -> whole rollback;
- Sell Yes full fill;
- Buy No mint + full Yes sale;
- Buy No partial -> mint + trade rollback;
- Sell No via `redeem_pair_via_market`;
- partial Sell No -> rollback;
- fee corner at 99 cents / 101 bps succeeds within $1;
- 102 bps config rejected;
- only liquidity is user's own resting ask -> documented economic self-cross remains solvent;
- wallet pays EventHeap penalty, collateral vault never pays lamports.

#### EventHeap

- fill with maker OOA in remaining accounts -> maker applied inline, no heap growth;
- >inline makers -> residual events enter heap;
- pre-consume + take transaction;
- keeper idempotency;
- saturation at 50/75/near-full thresholds;
- safe action fails closed if account/CU limit prevents mitigation.

#### Fees/referrers

- OpenBook fee unit golden vectors;
- taker fee 0 and 101 bps;
- `place_take_order` supported flow;
- PostOnly limit produces no taker-referral accrual;
- `settle_openbook_funds` forces no referrer;
- hostile direct settle with referrer against supported maker account: prove rebate available == 0 before enabling fee switch;
- `collect_venue_fees` exact treasury delta;
- full fee-flow conservation G9.

### 13.4 Multi-user spec scenario — REQUIRED

Wallet A:

1. mint pairs;
2. place PostOnly Yes quote(s).

Wallet B:

1. take quote via Buy Yes;
2. execute Buy No path;
3. exercise Sell Yes / Sell No as applicable.

Then:

- consume events;
- settle OpenBook balances;
- settle market outcome;
- both wallets redeem;
- reconcile collateral, fees, supplies, and P&L.

### 13.5 Frontend / Playwright

- wallet connect;
- live underlying price display;
- Markets 7-stock grid;
- contract Yes/No/implied probability display;
- payoff sentence;
- both orderbook perspectives;
- Buy/Sell Yes/No;
- crossing-limit warning;
- position constraint: No holder cannot Buy Yes;
- position constraint: Yes holder cannot Buy No;
- guided exit;
- first-use Buy-No-limit transaction composition;
- Portfolio P&L/unknown basis;
- History;
- settlement and redemption;
- pause/closed states.

---

## 14. Adversarial Test Suite

ADV-01 direct maker order pre-open fails.  
ADV-02 direct taker order pre-open fails.  
ADV-03 maker/taker order while paused fails.  
ADV-04 stale resting order cannot be taken at/after close.  
ADV-05 wrong OpenBook `open_orders_admin` rejected by attach.  
ADV-06 wrong fee/close admin rejected.  
ADV-07 wrong expiry/lot/mint/vault rejected.  
ADV-08 arbitrary OpenBook account substitution in wrapper rejected.  
ADV-09 hostile order type / expiry / self-trade arg ignored; wrapper pins PostOnly/Abort/close expiry.  
ADV-10 crossing limit reverts, does not turn taker.  
ADV-11 partial `place_take_order` followed by Meridian exact-fill failure rolls back all state.  
ADV-12 EventHeap near-full: inline maker accounts prevent heap growth where possible.  
ADV-13 EventHeap pressure: pre-consume+take succeeds atomically.  
ADV-14 EventHeap mitigation cannot fit -> synthetic action fails closed, no partial exposure.  
ADV-15 hostile direct `settle_funds(referrer)` cannot divert supported V1 fee flow; if nonzero rebate exists, taker-fee feature gate fails.  
ADV-16 fee-flow reconciliation including `fees_available`, referrer state, sweep, treasury delta.  
ADV-17 99-cent Sell-No at max 101 bp remains <=$1.  
ADV-18 102 bp taker config rejected.  
ADV-19 collateral vault cannot be penalty payer / lamport payer.  
ADV-20 economic self-cross in Sell No remains solvent and P&L deterministic.  
ADV-21 mint before 09:00 rejected.  
ADV-22 mint at/after close rejected.  
ADV-23 mint on Settled rejected.  
ADV-24 unsolicited USDC into vault/treasury does not DoS.  
ADV-25 live market params/fees/feed version unaffected by future config updates.  
ADV-26 attempt to mutate feed referenced by unsettled market rejected operationally/governance path.  
ADV-27 fresh publication with stale OBS_TS rejected.  
ADV-28 final-minute strike crossing settles from post-close observation only.  
ADV-29 permissionless settlement race cannot use pre-finalization data.  
ADV-30 override delay cannot be lowered for live market.  
ADV-31 post-settlement `redeem_pair` / `redeem_pair_via_market` rejected.  
ADV-32 one-atom winning redemption works.  
ADV-33 first-use Buy-No-limit fits one transaction or M0 explicitly fails compliance gate.  
ADV-34 `create_strike_market` metadata CPI CU/bytes.  
ADV-35 remaining-account taker max-size CU/bytes.  
ADV-36 indexer duplicate/restart/backfill/reorg.  
ADV-37 multi-user maker/taker/both-redeem lifecycle.  
ADV-38 intraday `add_strike` complete create->attach->trade->settle lifecycle.

---

## 15. M0 Hard Gates

Implementation does not progress to M1 unless G1–G10 are green or the plan is formally revised.

### G1 — Deployed OpenBook pin / license-safe integration

- confirm devnet program ID;
- confirm official v1.7 release commit `796a470`;
- confirm official build SHA-256;
- dump devnet executable and verify against official verifiable-build artifact/hash path;
- pin Rust CPI + TS client revisions;
- confirm fallback adapter can be generated from MIT IDL/client/account layouts only.

### G2 — PDA universal order gate

Prove against deployed/pinned build:

- direct maker order without PDA fails;
- direct `place_take_order` without PDA fails;
- Meridian CPI succeeds;
- no alternate order-creation instruction used by V1 bypasses the admin.

### G3 — Exact time/pause/mint gates

- order pre-open rejected;
- order paused rejected;
- order exact close rejected;
- OpenBook expiry exact boundary proven;
- mint pre-09:00 rejected;
- mint exact close rejected;
- mint Settled rejected;
- cancel/consume/settle funds still work.

Evaluate `set_market_expired` as irreversible emergency defense-in-depth and either adopt or explicitly reject it in the M0 report.

### G4 — Full-fill rollback

- create partial-liquidity book;
- `take_full` executes OpenBook CPI partially;
- Meridian exact-delta postcondition fails;
- verify every OpenBook/token/Meridian change rolls back.

### G5 — Sell-No / `redeem_pair_via_market`

Prove:

- only correct collateral vault can fund quote;
- user must sign No burn;
- program Yes-trade ATA exact;
- exact q Yes acquired;
- vault delta / liability delta invariant;
- 99c + 101bp corner;
- 102bp rejected by config;
- economic self-cross case;
- `penalty_payer` is user/operator, never collateral account;
- any other lamport/rent/penalty charge cannot debit collateral.

### G6 — EventHeap / inline maker policy

Measure:

- EventHeap capacity;
- maker inline remaining-account limit (expected 15, verify pinned build);
- match latency;
- maker inline latency;
- heap event latency;
- consume batch size/CU;
- saturation failure behavior;
- keeper throughput.

Calibrate SLO thresholds. No product path may rely on unmeasured "keeper should be fast enough."

### G7 — Transaction feasibility / one-approval gate

Measure serialized bytes, ALTs, account count, CU, wallet simulation for:

1. **first-use Buy-No-limit**: OOI + OOA creation + `mint_pair` + PostOnly order — **hard spec gate**;
2. first-use Buy-Yes-limit;
3. `redeem_pair_via_market` with max remaining maker accounts;
4. pre-consume + `take_full` with remaining maker accounts;
5. post-close cancel + settle + redeem helper;
6. batched settlement transaction;
7. `create_strike_market` including two Metaplex metadata CPIs;
8. intraday Add Strike create/OpenBook/attach sequence.

If first-use Buy-No-limit cannot fit one approval, stop and request explicit stakeholder deviation. Do not silently pre-create accounts and claim compliance.

### G8 — Rent / daily market budget

Measure exact rent for:

- Meridian Market;
- mints;
- metadata;
- collateral vault / trade ATA;
- OpenBook Market;
- bids;
- asks;
- EventHeap;
- per-user OpenOrdersIndexer;
- per-market OpenOrders account.

Budget:

- 35 markets/day;
- 49 markets/day;
- five trading days;
- best-case reclaimed vs worst-case locked rent.

### G9 — Full fee/referrer conservation

Before `taker_fee_bps > 0` is permitted:

- verify fee conversion vectors;
- run Market-action session;
- run PostOnly maker session;
- prove supported maker OOA has zero referral rebate available;
- hostile direct settle with arbitrary referrer must receive zero on supported flow;
- reconcile OpenBook `fees_accrued`, `fees_available`, referral counters, sweep amount, treasury delta;
- prove Meridian ledger delta equals treasury delta;
- maker fee remains zero.

If any supported path permits a user-selected referrer to divert protocol-intended taker fee, the nonzero taker fee switch remains disabled and plan is revised before activation.

### G10 — Lot/price/order semantics

Prove with golden vectors:

- 1 contract == 1 base lot;
- 1 price lot == 1 cent;
- price 1..99 maps $0.01..$0.99;
- PostOnly crossing behavior + returned order ID semantics;
- per-order expiry boundary;
- self-trade field serialization pinned to `AbortTransaction` for limit wrapper.

---

## 16. Devnet and Demo Strategy

### `make demo` — deterministic localnet

- local validator;
- pinned OpenBook clone/build;
- MockOracle;
- synthetic close;
- two wallets;
- complete create -> mint -> trade -> settle -> redeem.

### `make demo-devnet` — required pass path

- deployed Meridian devnet;
- deployed OpenBook v1.7;
- real Switchboard On-Demand feed accounts;
- two funded wallets;
- public stock provider or explicitly labeled public-HTTPS synthetic data source.

Reject:

```text
localhost
127.0.0.0/8
RFC1918
.local
LAN-only hostnames
```

Production validation is unchanged.

Required devnet demo includes:

- morning/one strike creation;
- PostOnly quote;
- Buy Yes;
- Buy No;
- Sell Yes;
- Sell No via pair redemption;
- maker event consumption;
- settlement;
- both-wallet redemption;
- accounting reconciliation.

---

## 17. Milestones

**Capacity assumption:** one senior engineer, full-time, AI-assisted.  
**Estimate:** **18–22 working days**, assuming M0 passes without architectural revision.

| Milestone | Days | Scope | Exit gate |
|---|---:|---|---|
| **M0** | D1–4 | G1–G10: pin, CPI, fee/referrer semantics, PostOnly, event saturation, one-approval Buy-No-limit, Sell-No, rent/CU/bytes | all hard gates green |
| **M1** | D5–7 | Config/roles/feed versions; market snapshots; create/add-strike; metadata; collateral ledger; mint/redemption; MockOracle; pause | program + strike + ADV core green |
| **M2** | D8–11 | OpenBook create/attach; PostOnly limit wrapper; take-full; pair-redemption-via-market; OpenOrders wrapper/discovery; EventHeap keeper; fee collection | localnet full four-path + multi-user green |
| **M3** | D12–14 | Switchboard immutable feed versions; provider same-record calibration; NYSE calendar; settlement automation; override runbook | real devnet settlement + oracle ADV green |
| **M4** | D15–17 | 5 frontend pages; required UI elements; position constraints; first-use OO UX; live prices | Playwright green |
| **M5** | D18–19.5 | indexer, ladder WS, History, P&L, crank health | scripted accounting/P&L sequence green |
| **M6** | D20–22 | devnet E2E, demo, cleanup, docs, risk note, final traceability audit | clean-clone `make demo-devnet` succeeds |

### Non-compliant deviations

The following may be used only with explicit stakeholder acceptance and must be labeled non-compliant:

- two approvals for first-use Buy-No-limit;
- fewer required tickers/strikes;
- no History/P&L;
- no position constraints;
- weakened pause/open/close gates;
- MockOracle-only pass demo;
- dropped devnet E2E.

---

## 18. Risk Register

| Risk | L | I | Mitigation |
|---|---|---|---|
| EventHeap backlog blocks/raises cost of exits near close | M | H | inline maker accounts, pre-consume, numeric keeper SLO, fail-closed path, G6/G7 |
| First-use Buy-No-limit exceeds tx limits | M | H | v0+ALT + hard G7; stakeholder waiver required if impossible |
| Direct `settle_funds` referrer diverts fee | L/M | M | PostOnly OO surface; market via place_take; G9 proves rebate zero or disables nonzero taker fee |
| OpenBook large-account rent | H | M | G8; cleanup; devnet funding model |
| Deployed/client revision mismatch | L | H | G1 program/release/build verification |
| CPI adapter accidentally derives GPL implementation | L | M | MIT IDL/client-only fallback rule + review |
| `redeem_pair_via_market` vault spend bug | L | H | account pinning, exact deltas, max fee 101bp, rollback, G5 |
| Economic self-cross in Sell No surprises user | M | L | cancel-own-order UX + explicit test; solvency unaffected |
| OpenBook EventHeap penalty surprises user | M | L | disclose small SOL penalty possibility; inline makers minimize; wallet pays |
| Provider unavailable at close | M | H | preflight, retries, override |
| PRICE/OBS_TS not same record | M | H | M3 provider go/no-go |
| stale observation laundered by fresh publication | L | H | OBS_TS value + publication window |
| live market changed by admin | L | H | explicit snapshots + future-day config |
| DST/holiday/early-close error | M | H | one calendar module + tests |
| freely transferred tokens bypass UI position constraints | H | L | documented; economically harmless; frontend enforces spec-intended actions |
| regulatory/legal | — | — | devnet only; neutral risk note; no compliance claims |

---

## 19. Open Inputs

1. **Q1 — spec-owner confirmation:** pair redemption (`redeem_pair` and `redeem_pair_via_market`) counts as the spec's allowed "redeem" destruction path.
2. Stock-data provider for M3 same-record calibration.
3. ATM strike default on/off.
4. Metadata URI empty vs hosted JSON/icon.
5. Alert destination.
6. Claim-fee cap confirmation (proposed 500 bps). Taker cap is architecture-bound at 101 bps unless Sell-No design changes.
7. Whether nonzero maker fees are a future business requirement. They are not V1.

---

## 20. Requirements Traceability Matrix

| Spec requirement | v0.6 mechanism | Acceptance evidence |
|---|---|---|
| Solana chain fast enough for real-time on-chain CLOB | Solana + OpenBook V2 | M0 latency / local+devnet lifecycle |
| 7 MAG7 tickers | config + strike job | automation tests / Markets UI |
| ±3/6/9 strikes, nearest $10, dedupe, optional ATM | §6 | META/AAPL verbatim vectors |
| Add Strike intraday | `add_strike` + automation command | ADV-38 |
| contracts/order books before open | 08:30 create + attach | lifecycle E2E |
| minting starts 09:00 | ADR-013 + I9 | mint boundary tests |
| trading starts 09:30 | trade PDA wrapper | direct pre-open ADV |
| pause minting + trading | mint + order gates | pause tests |
| no trading after close | wrapper + OpenBook expiry | close boundary tests |
| $1 collateral invariant | liability ledger / I1 | fuzz + reconciliation |
| Yes+No payout=$1 | I2 | exhaustive settle tests |
| creation only via mint pair | I3 | authority/path tests |
| destruction only via redeem interpretation | ADR-011 + I3 + Q1 | path tests + spec-owner signoff |
| settlement immutable | I4 | race/write-once tests |
| one Yes/USDC book per strike | ADR-002 | attach validation |
| Buy Yes market | take_full Bid | integration |
| Buy Yes limit | PostOnly Bid | integration |
| Buy No market atomic / one approval | mint + take_full one tx | rollback + tx builder |
| Buy No limit atomic / one approval | OOI+OOA+mint+PostOnly ask | **G7 hard gate** |
| Sell Yes market/limit | take_full Ask / PostOnly Ask | integration |
| Sell No automatic close | `redeem_pair_via_market` | G5 / integration |
| position constraints | ADR-016 frontend | Playwright |
| oracle on-chain settlement read | ADR-014/015 | devnet + oracle matrix |
| staleness/quality | feed hashes + OBS_TS + samples/stale slots | ADV oracle suite |
| previous close off-chain allowed | strike job | automation test |
| retry 30s up to 15m | automation | job test |
| settle within 10m SLO | +5 start / +10 incident | M3 SLO test |
| override >=1h | snapshot + compile-time floor | ADV-30 |
| indefinite redemption | one atom / no expiry | E2E |
| Landing live prices | §12 Landing | Playwright |
| Markets 7-stock live grid | §12 Markets | Playwright |
| contract cards / implied probability / implied No | §12 Trade | component+Playwright |
| both book perspectives | mirrored ladder | Playwright |
| payoff sentence | exact required copy | Playwright snapshot |
| Portfolio entry/current/P&L/redeem | §12 Portfolio + indexer | Playwright/scripted sequence |
| History trade log | indexer + History | test |
| multi-user maker/taker/both redeem | §13.4 | integration/ADV-37 |
| devnet full lifecycle | `make demo-devnet` | clean-clone gate |
| secrets via env | Appendix C | repo review |
| risks/limitations | §18 + README | final doc audit |

---

## Appendix A — User Intent to Transaction Composition

| Intent | Mode | Composition | Notes |
|---|---|---|---|
| Buy Yes | Market | `[consume? , meridian.take_full(Bid)]` | full-fill or rollback |
| Buy Yes | Limit | `[OO setup if needed, meridian.place_limit_order(PostOnly Bid)]` | no crossing/taker fee |
| Buy No | Market | `[meridian.mint_pair, consume?, meridian.take_full(Ask)]` | one approval; $1/q temporary funding |
| Buy No | Limit | `[OOI?, OOA?, meridian.mint_pair, meridian.place_limit_order(PostOnly Ask @ 100-No)]` | **first-use one-approval G7** |
| Sell Yes | Market | `[consume?, meridian.take_full(Ask)]` | directional trading; paused when market paused |
| Sell Yes | Limit | `[meridian.place_limit_order(PostOnly Ask)]` | directional trading |
| Sell No | Market | `[consume?, meridian.redeem_pair_via_market]` | pair redemption after acquiring Yes |
| Sell No | Limit | Not V1 | no claim |
| Pair unwind | pre-settle | `[meridian.redeem_pair]` | recovery/redemption, not directional trade |
| Cancel | any state | direct OpenBook cancel | recovery |
| Settle OO funds | any state | `[meridian.settle_openbook_funds(referrer=None)]` | recovery |
| Outcome redeem | post-settle | `[meridian.redeem_outcome]` | indefinite |
| Venue fee collect | ops | `[meridian.collect_venue_fees -> OpenBook sweep]` | exact ledger delta |

---

## Appendix B — Repository Layout

```text
meridian/
├─ programs/meridian/
│  ├─ config.rs
│  ├─ roles.rs
│  ├─ feed_versions.rs
│  ├─ market.rs
│  ├─ collateral.rs
│  ├─ redemption.rs
│  ├─ trading_gate.rs
│  ├─ openbook_adapter.rs
│  ├─ settlement.rs
│  ├─ fees.rs
│  └─ metadata.rs
├─ packages/common/
│  ├─ strike-engine/
│  ├─ nyse-calendar/
│  ├─ generated-meridian-client/
│  └─ openbook-adapter/
├─ services/automation/
│  ├─ market-creation/
│  ├─ add-strike/
│  ├─ openbook-event-keeper/
│  ├─ oracle-settlement/
│  ├─ venue-fee-collector/
│  └─ cleanup/
├─ services/indexer/
├─ services/demo-source/
├─ app/
├─ scripts/
├─ tests/
│  ├─ strike/
│  ├─ program/
│  ├─ openbook-integration/
│  ├─ adversarial/
│  ├─ devnet/
│  └─ playwright/
├─ docs/adr/
├─ docs/runbooks/
├─ Makefile
└─ .env.example
```

---

## Appendix C — `.env.example`

```bash
RPC_URL=https://api.devnet.solana.com
WS_URL=wss://api.devnet.solana.com

OPENBOOK_PROGRAM_ID=opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb
OPENBOOK_DEPLOYMENT_TAG=v1.7
OPENBOOK_RELEASE_COMMIT=796a470
OPENBOOK_BUILD_SHA256=a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8

GOVERNANCE_KEYPAIR_PATH=./keys/governance.json
OPERATOR_KEYPAIR_PATH=./keys/operator.json
FEE_ADMIN_KEYPAIR_PATH=./keys/fee_admin.json
PAUSE_AUTHORITY_KEYPAIR_PATH=./keys/pause.json
OVERRIDE_AUTHORITY_KEYPAIR_PATH=./keys/override.json

QUOTE_MINT=
STOCK_API_KEY=
ALERT_WEBHOOK_URL=

# Public HTTPS only when used on devnet.
DEMO_SOURCE_URL=

# Keeper thresholds are calibrated by G6; defaults are upper safety bounds.
HEAP_WARN_PERCENT=50
HEAP_CRITICAL_PERCENT=75
HEAP_NORMAL_MAX_AGE_MS=5000
HEAP_CLOSE_MAX_AGE_MS=2000
```

---

## Appendix D — M0 OpenBook Evidence File

M0 must create `docs/adr/openbook-v2-pin.md` containing exact pinned-source evidence for:

- deployed program ID/tag/commit/build hash;
- license boundary (`client`/`cpi` MIT path);
- Market admin fields;
- expiry predicate;
- `place_order` admin signer;
- `place_take_order` admin signer and immediate transfer;
- `place_take_order` no-referrer behavior;
- `settle_funds` optional referrer behavior;
- fee scale and conversion;
- SelfTradeBehavior enum;
- PostOnly semantics;
- remaining-account inline fill limit;
- EventHeap penalty and penalty payer;
- `consume_events` authority;
- `set_market_expired` / prune / close authority;
- close-market preconditions;
- lot/tick math;
- market/book/EventHeap sizes and rent.

Every golden test must name the pinned evidence item it protects.

---

## Appendix E — Source Set Used for v0.6 Review Closure

Primary OpenBook sources re-verified during this revision:

- official `openbook-dex/openbook-v2` repository README / deployed versions;
- official GitHub v1.7 release metadata;
- `idl/openbook_v2.json`;
- `programs/openbook-v2/src/state/market.rs`;
- `programs/openbook-v2/src/state/orderbook/book.rs`;
- `programs/openbook-v2/src/instructions/place_take_order.rs`;
- `programs/openbook-v2/src/accounts_ix/place_take_order.rs`;
- `programs/openbook-v2/src/instructions/settle_funds.rs`;
- `programs/openbook-v2/src/accounts_ix/settle_funds.rs`.

The source PDF / `meridian-spec.md` remains authoritative for Meridian product requirements.
