# Meridian — Product Requirements and M0 Validation Plan

**Version:** 0.7.1 (ADR-0030 G1 revision: canonical OpenBook deployment with monitored fail-closed identity; stakeholder-approved 2026-08-20)
**Date:** 2026-08-20  
**Source requirements:** [`docs/REQUIREMENTS.md`](./REQUIREMENTS.md), converted from the source PDF; the PDF remains the upstream source of truth.
**Decision record:** [`CONTEXT.md`](../CONTEXT.md) and [`docs/adr/`](./adr/) contain the accepted Rounds 1–6 vocabulary and decisions.
**Status:** **M0 validation candidate; full build pending gates.** M0 may begin from this document. M1 and all full-build work begin only after the non-waiverable M0 gates pass and the signed go/no-go report is approved.
**Build posture:** OpenBook V2 remains the approved V1 Venue Market. This revision reconciles the implementation plan with ADRs 0001–0028 without weakening the source product requirements.

---

## 0. Reconciliation and Review Closure Ledger

The earlier adversarial review approved the OpenBook direction but found missing source capabilities and underspecified integration details. Rounds 1–6 then resolved the remaining product, domain, trust, lifecycle, data, and operational decisions. The repository ADRs are authoritative for those decisions.

| Finding | v0.7 disposition |
|---|---|
| **C1(a) Add Strike missing** | **Closed.** `add_strike` restored as an operator instruction with full market-creation/venue-attachment flow, automation/runbook support, tests, and traceability. |
| **C1(b) Position constraints missing** | **Closed.** The accepted Directional Guardrail uses worst-case Exposure Interval across holdings, venue balances, and resting/pending orders; Mixed/Unknown Positions fail closed for new Directional Intents. |
| **C1(c) Required UI elements missing** | **Closed.** Timestamped Live Underlying Price, executable Yes/No views, two-sided Mark Price/Implied Probability rules, Outcome Market cards, and exact at-or-above payout copy are normative frontend requirements and tests. |
| **C1(d) Multi-user integration test missing** | **Closed.** Restored verbatim: one user mints/quotes, another takes, both settle/redeem. |
| **C1(e) Strike-engine worked vectors missing** | **Closed.** META $680 and AAPL $230 examples are pinned verbatim as test vectors. |
| **C1(f) token-destruction feasibility** | **Closed with an explicit classic-SPL boundary.** Meridian/PDA burns occur only through the ADR-0003 Redemption family. A holder can burn owned classic SPL tokens directly; that unsupported forfeiture pays nothing and is handled by permissionless supply-based liability reconciliation. |
| **H1 referrer rebates / fee paths** | **Closed by removal.** ADR-0001/0007 make V1 protocol-fee-free and remove fee configuration, administrators, ledgers, collection, and withdrawals. Venue attachment requires zero maker/taker fees and an M0-proven unsignable fee-admin sentinel. |
| **H2 self-trade behavior** | **Closed.** Limit wrapper pins `AbortTransaction`. Normal Sell No must not knowingly self-cross: it cancels/settles the user's matching Yes order and uses direct Pair Redemption. A race/adversarial on-chain occurrence remains solvent and is reported as an Internal Unwind, not external price discovery. |
| **H3 EventHeap saturation** | **Closed by product policy.** Taker builders provide up to 15 expected maker OpenOrders accounts as OpenBook remaining accounts so maker fills settle inline. If heap pressure exceeds threshold, the same wallet transaction prepends bounded `consume_events`. Keeper has numeric SLOs. Exit actions fail closed rather than silently partial-fill if neither mitigation fits. G6/G7 include saturation variants. |
| **H4 mint window only narrative** | **Closed.** `mint_pair` has the normative gate `state == Active && mint_open_ts <= now < close_ts && !paused`; I9 and boundary tests added. |
| **H5 release commit supposedly unverifiable** | **Review correction.** Official OpenBook release metadata records commit `796a470` and build SHA-256 `a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8`; G1 independently verifies the deployed devnet executable before any CPI builder is trusted. |
| **H6 incidental costs** | **Closed.** V1 has no protocol fees. Wallet/operator-paid SOL network fees, rent, and the OpenBook EventHeap penalty remain explicitly outside collateral and Platform-execution P&L. |
| **H7 Buy-No-limit one approval** | **Closed as hard compliance gate.** One-approval atomic Buy-No-limit is a G7 pass requirement. v0+ALT and an OpenOrders setup mitigation ladder are specified. If the full transaction cannot fit, that is an explicit stakeholder-approved spec deviation, not a silent fallback. |
| **M1 fee-unit conversion undefined** | **Superseded.** No conversion exists in V1; attachment requires exact zero maker and taker fees. |
| **M2 order expiry + crossing-limit UX** | **Closed.** Order-level expiry boundary tests remain. V1 limit orders are PostOnly; a crossing limit is rejected with an explicit UI message. |
| **M3 pause wording / hard halt** | **Closed.** Pause explicitly freezes directional trading exits (`Sell Yes`, `Sell No`) because those are trading. Custody/recovery exits remain available. `set_market_expired` is evaluated in M0 as an **irreversible emergency-expire** defense-in-depth, not ordinary pause/unpause. |
| **M4 snapshot enumeration incomplete** | **Closed.** Every immutable Outcome Market and shared Settlement Record field is enumerated in §7.1 and I8. |
| **M5 GPL adapter posture** | **Closed.** Fallback CPI adapter may be derived only from MIT-licensed IDL/client/account-layout interfaces; no GPL program-source copying. |
| **M6 G7 coverage gaps** | **Closed.** `create_strike_market` metadata CPI and remaining-account taker variants are explicit transaction/CU gates. |
| **M7 indexer details** | **Closed.** OpenOrders discovery derives the per-wallet OpenOrdersIndexer and reads its account list; crank thresholds are specified provisionally and calibrated by G6. |

### Gate posture after this revision

The product decision frontier is empty. M0 is authorized to begin. It validates the pinned venue, zero-fee sentinel, recovery paths, capacity, funding, transaction feasibility, and real Nasdaq Official Close path. Safety gates cannot be waived; only the source one-approval Buy-No-limit requirement has the named product-compliance waiver in ADR-0020. M1 begins only after M0 passes.

---

## 1. Executive Summary

Meridian is a self-directed Solana dApp for same-day binary Outcome Markets on MAG7 US-equity Official Closes. Each Strike has a Pair of fully collateralized Yes/No SPL tokens. A single Yes/USDC OpenBook V2 Venue Market provides price discovery for both Yes and No perspectives. Settlement consumes one immutable Settlement Record shared by every Outcome Market for a ticker and Trading Day. A whole winning token pays exactly 1 USDC and a losing token pays 0; V1 charges no protocol fees. Users control their wallets, while collateral and active Venue Market balances are held by program and venue smart contracts rather than a discretionary custodian.

### V1 stack

- **Chain:** Solana devnet.
- **Meridian program:** Rust + Anchor.
- **CLOB:** **OpenBook V2 deployed v1.7**, one Yes/USDC market per strike.
- **OpenBook program:** `opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb`.
- **Release metadata:** commit `796a470`; build SHA-256 `a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8`; independently re-verified in G1.
- **Venue creation authority:** per-Outcome-Market `venue_market_authority` PDA is the sole authority signer for the Meridian `create_venue_market` CPI wrapper.
- **Trading authority:** per-market Meridian PDA installed as OpenBook `open_orders_admin`.
- **Hard close:** Meridian `now < close_ts` order gate plus OpenBook `time_expiry = close_ts - 1`.
- **Settlement transport:** Switchboard On-Demand carrying one atomically bound, versioned Settlement Record per ticker and Trading Day.
- **Official Close:** unadjusted Nasdaq Official Closing Price (NOCP) under the primary listing market's declared Close Method.
- **Tokens:** classic SPL Token, 6 decimals; canonicalized metadata/image published and verified on permanent storage before immutable Metaplex metadata is created.
- **Quote asset:** pinned Circle six-decimal Solana Devnet USDC.
- **Frontend:** Next.js under `frontend/` + Metaplex Umi/wallet-adapter; OpenBook client isolated behind an adapter boundary.
- **Automation:** creation, EventHeap keeper, Settlement Record orchestration, incident handling, and venue cleanup.
- **Indexer:** Meridian + OpenBook event/account indexing from deployment genesis to SQLite + REST/WS, with visible History Completeness.

### Why OpenBook V2

OpenBook supplies the existing on-chain CLOB while exposing the control Meridian needs:

- `open_orders_admin` must sign order creation, including `place_take_order`;
- market `time_expiry` rejects trading after expiry;
- `close_market_admin` can expire/prune/close a market;
- the pinned market header exposes fields Meridian validates as zero-fee and permanently non-collectable;
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
- Morning prior Official Close read and automated Strike creation, subject to Corporate Action Blackout.
- ±3%, ±6%, ±9% Strikes plus the rounded prior Official Close as the default ATM Strike, rounded to nearest $10 and deduplicated.
- Operator may **add a Strike intraday** until 30 minutes before the NYSE close, including early closes.
- Minting enabled at 09:00 ET.
- Live trading begins at 09:30 ET.
- Trading/minting closes at 16:00 ET or the calendar-defined early close.
- Preflight begins five minutes before close; final-record polling begins close+15m; automatic Settlement may begin close+20m; the incident SLO is close+25m.
- Delayed manual override only after at least one hour.
- Indefinite redemption.
- No identity/KYC gate in V1; wallet connection is sufficient for protocol access, without making a legal-compliance claim.
- No borrowing, margin, leverage, or unsecured short path; issuance remains fully collateralized through Pair minting.

### Trading

- Exactly one Yes/USDC order book per strike.
- Four first-class intents: Buy Yes, Buy No, Sell Yes, Sell No.
- Buy Yes market + limit.
- Buy No market + limit, with one approval and atomic mint+order semantics.
- Sell Yes market + limit.
- Sell No simple automatic close; no V1 Sell-No limit requirement is claimed.
- The frontend Directional Guardrail evaluates the wallet's worst-case Exposure Interval across holdings, venue balances, and resting/pending orders. Mixed and Unknown Positions fail closed for new Directional Intents while recovery remains available.

### Contract safety

- $1 collateral per pair/accounted liability.
- Yes payout + No payout = $1; equality at the Strike belongs to Yes.
- Token creation only through pair creation.
- Meridian and its PDAs invoke SPL burns only through the accepted Redemption family in ADR-0003. A holder can still call classic SPL Token directly to burn tokens they own; that unsupported voluntary forfeiture releases no collateral.
- Settlement immutable.
- Oracle freshness + quality checks.
- Pause/unpause minting and trading.

### Frontend

- Landing, Markets, Trade, Portfolio, History.
- Timestamped Live Underlying Prices, stale after 15 seconds and labeled delayed when entitlement requires it.
- Outcome Market cards with Strike and executable Yes/No bid/ask; Mark Price and Implied Probability appear only when both best quotes are present and no more than five seconds old.
- One book shown from Yes and mirrored No perspectives.
- Buy/Sell Yes/No controls.
- Settlement countdown.
- Payoff sentence: `A Yes Token pays 1.00 USDC if the Official Close is at or above [STRIKE].` Entry cost and maximum payout appear separately.
- Portfolio known/unknown basis, fresh Mark Price where available, Platform-execution P&L, Settlement, and Redemption.

### Testing and deployment

- Smart-contract unit/invariant/oracle/override tests.
- Full lifecycle integration.
- All four trade paths.
- Multi-user maker/taker scenario.
- Frontend tests including the Directional Guardrail, Recovery-only Mode, and Live Underlying Price freshness/entitlement states.
- Solana devnet deployment.
- Reproducible scripts and one-command setup.

---

## 3. OpenBook V2 Facts and Pin

These facts are load-bearing. M0 must re-read them from the pinned v1.7 release/program, not moving `master`.

1. Market state includes `time_expiry`, required `collect_fee_admin`, optional `open_orders_admin`, optional `consume_events_admin`, optional `close_market_admin`, maker fee, and taker fee. V1 accepts only exact zero fees and uses the M0-proven unsignable sentinel for the required fee-admin key.
2. `open_orders_admin` is documented as the admin that must sign all order creation; IDL includes it on both resting-order creation and `place_take_order`.
3. OpenBook's expiry predicate is strict: `time_expiry != 0 && time_expiry < now`.
4. `place_take_order` rejects an expired market and performs immediate taker token transfer.
5. `PlaceOrderArgs` includes explicit `self_trade_behavior`; `PlaceTakeOrderArgs` does not.
6. `SelfTradeBehavior` values are DecrementTake / CancelProvide / AbortTransaction.
7. Matching code can process maker fills inline when the maker OpenOrders account is provided in remaining accounts; otherwise it pushes the fill to EventHeap. Inline processing is bounded to 15 fill remaining accounts.
8. A `place_take_order` that adds EventHeap entries charges a **500 lamport** EventHeap penalty to `penalty_payer`.
9. `consume_events` exists to apply EventHeap maker bookkeeping; setting `consume_events_admin=None` keeps it permissionless.
10. `set_market_expired`, `prune_orders`, and `close_market` are controlled by `close_market_admin`.
11. Classic OpenBook market/orderbook/EventHeap accounts are large enough that rent is an M0 hard gate.
12. The majority of the repository is MIT, while GPL code is behind `enable-gpl`; using the crate via `client`/`cpi` features is intended to use only MIT portions.

### Pinned deployment

```text
OPENBOOK_PROGRAM_ID       = opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb
OPENBOOK_DEPLOYMENT_TAG   = v1.7
OPENBOOK_RELEASE_COMMIT   = 796a470
OPENBOOK_BUILD_SHA256     = a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8
```

G1 independently verifies that the devnet executable matches the official v1.7 release/build record. If it does not, implementation stops and the pin is corrected before any CPI builder is trusted.

OpenBook is also a custody-critical external program, so a release tag and program ID alone are insufficient. G1 records the executable account owner, derived ProgramData address, deployment slot, executable SHA-256, and upgrade-authority state. V1 accepts the verified canonical devnet deployment; per ADR-0030 its retained external upgrade authority is a monitored fail-closed risk, because the artifact's compiled-in program ID makes an immutable re-deployment impossible. `initialize_config` stores the snapshotted identity, and every OpenBook wrapper checks the executable/ProgramData relationship and exact stored slot before CPI. A changed slot, owner mismatch, ProgramData mismatch, or executable-hash mismatch is a non-waiverable G1 failure that halts Meridian; any upgrade by the external authority must trigger an alert and reopens the architecture before funds are exposed.

---

## 4. Implementation Decision Summaries

### ID-001 — Solana + Anchor, pinned OpenBook integration — ACCEPTED

Solana devnet + Rust/Anchor for Meridian.

Integration preference:

1. use OpenBook's MIT `cpi`/`client` feature surface at the pinned compatible revision;
2. if Anchor-version incompatibility blocks that path, implement a **minimal CPI adapter from the MIT IDL/client/account layouts only**;
3. golden-test instruction discriminators, serialized args, account order, signer/writable flags, and expected program ID against the official v1.7 client;
4. do not copy or derive the fallback adapter from GPL program implementation source.

No OpenBook fork enters V1.

---

### ID-002 — OpenBook V2 venue and authorities — ACCEPTED

Each Meridian strike gets one OpenBook market:

```text
base_mint            = Meridian Yes mint
quote_mint           = Config.quote_mint
market_authority      = PDA["venue-market-authority", outcome_market]
open_orders_admin    = PDA["venue-trade", market]
collect_fee_admin    = UNSIGNABLE_FEE_ADMIN_SENTINEL
consume_events_admin = None
close_market_admin   = PDA["venue-close", market]
time_expiry          = close_ts - 1
oracle_a             = None
oracle_b             = None
maker_fee            = 0
taker_fee            = 0
```

The operator-funded `create_venue_market` instruction is the only supported creation path. It CPIs to the pinned OpenBook program, derives and signs only as `venue_market_authority`, and supplies every mint, vault, lot, oracle, expiry, fee, and admin field above rather than accepting caller-selected header values. `attach_venue` then requires the decoded OpenBook market authority to be that exact PDA. Meridian exposes no post-creation Market-header mutation wrapper.

OpenBook is created at ~08:30 immediately after the Yes mint exists. Trading remains impossible until Meridian starts signing at `trade_open_ts`.

---

### ID-003 — Hard trading authorization — ACCEPTED

Meridian is the only order-creation gateway.

Every order wrapper:

- derives and signs as `venue_trade_authority`;
- pins the OpenBook program and attached market;
- checks time/state/pause;
- pins order type, expiry, zero-fee fields, and account destinations;
- rejects arbitrary venue account substitution.

No client-supplied `open_orders_admin`, expiry, self-trade mode, market/vault address, fee mode, or program ID is trusted.

#### Custody/recovery actions

The following remain available even when trading is paused:

- cancel / cancel all;
- `consume_events`;
- Meridian-wrapped `settle_openbook_funds`;
- close empty OpenOrders accounts;
- direct `redeem_pair` before or after Settlement;
- `redeem_outcome` after settlement.

**Directional exits are trading and therefore pause:** Sell Yes, Sell No, and any market/limit order are blocked while paused. This is intentional and matches the spec's "pause trading" requirement.

---

### ID-004 — Open/close and emergency expiry — ACCEPTED

#### Normal open

```text
now < trade_open_ts        -> Meridian signs no orders
trade_open_ts <= now       -> order gate may open
```

Per ADR-0033, `trade_open_ts` is **creation-relative** (`creation + 30m`), not
the 9:30 session bell, so the order gate opens when the market exists; the gate
predicate above is unchanged. `validate_schedule` correspondingly bounds the
session length instead of pinning it to 3.5h/6.5h.

#### Normal close

Two layers:

```text
Meridian: now < close_ts
OpenBook: time_expiry = close_ts - 1
```

At `now == close_ts`, Meridian rejects and OpenBook is already expired under its strict predicate.

#### Emergency expiry

`set_market_expired` is **not** ordinary pause/unpause because it is irreversible for the daily venue lifecycle.

V1 exposes `emergency_expire_venue` only if M0 proves the pinned OpenBook operation and the complete post-expiry recovery path. A previously paused, pre-close Outcome Market may be expired only by the Pause Authority through the dedicated venue-close signer. An immutable flag and reason keep it permanently paused while cancellation, event consumption, fund settlement, Pair Redemption, Settlement, and Outcome Redemption remain available. Failure of any recovery test removes this instruction from V1.

---

### ID-005 — Limit orders are PostOnly in V1 — ACCEPTED

All V1 limit orders use OpenBook `PostOnly`.

Reasons:

- the spec's Buy-No limit story explicitly describes posting Yes at the chosen limit;
- it prevents a nominal "limit" action from unexpectedly acting as a taker;
- it makes the user's execution choice explicit even though V1 protocol and venue fees are zero;
- immediate execution remains available through the first-class Market action.

Wrapper behavior:

```text
order_type          = PostOnly
self_trade_behavior = AbortTransaction
expiry_timestamp    = close_ts - 1
```

The wrapper verifies an order ID was actually posted. If the order would cross and OpenBook returns no posted order, Meridian returns `LimitWouldCross`; the whole transaction reverts. UI says: **"This limit would execute immediately. Use Market or choose a non-crossing price."**

Crossing limits never silently become Market Actions.

---

### ID-006 — Market/taker actions: full-fill-or-revert — ACCEPTED

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

### ID-007 — EventHeap saturation policy — ACCEPTED

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

### ID-008 — Protocol-fee-free V1 — ACCEPTED

ADR-0001 and ADR-0007 remove the V1 fee subsystem rather than preserving dormant switches:

- claim fee = 0 and Outcome Redemption transfers exact atom-for-atom payout;
- OpenBook maker fee = 0;
- OpenBook taker fee = 0;
- no fee administrator, fee configuration, fee snapshot, treasury ledger, collection, or withdrawal instruction exists in Meridian;
- OpenBook's required `collect_fee_admin` key is the intentionally unsignable sentinel proven by M0;
- `attach_venue` rejects any nonzero maker/taker fee or any other fee-admin key.

Adding protocol fees later requires a new product and architecture revision that applies only to newly created Outcome Markets. Wallet-paid network fees, account rent, priority fees, and the OpenBook EventHeap penalty are operating costs, not protocol fees.

---

### ID-009 — SOL/rent/penalty cost bearing — ACCEPTED

Collateral vaults contain USDC only and never fund SOL costs.

For `place_take_order`:

- standard user market trade: `penalty_payer = user wallet`;
- `redeem_pair_via_market` Sell-No flow: OpenBook signer may be a Meridian PDA, but `penalty_payer = user wallet` as the separate signer;
- OpenBook's 500-lamport penalty when new EventHeap entries are added is therefore user-paid;
- keeper/automation transactions are operator-paid;
- account-creation rent is payer/user/operator according to the documented UX, never a collateral vault;
- every operator-funded closable account snapshots its Rent Refund Address at creation, while user-funded venue-account rent returns to its user payer/owner under the pinned venue closure path.

G5 asserts no lamport debit path can use a collateral PDA/vault as penalty payer.

---

### ID-010 — Collateral liability accounting — ACCEPTED

`collateral_liability_atoms` is the single accounted Collateral Liability. One outcome-token atom corresponds to one USDC atom because both assets use six decimals.

Before settlement:

```text
mint_pair(q_atoms)                 -> liability_atoms += q_atoms
redeem_pair(q_atoms)               -> burn/pay, then set liability to the pre-Settlement supply target
redeem_pair_via_market(q_atoms)    -> burn/pay, then set liability to the pre-Settlement supply target
```

Settlement:

```text
write the outcome, then reconcile liability to winning_mint.supply
```

After settlement:

```text
redeem losing q_atoms              -> burn/pay zero, then set liability to winning supply
redeem winning q_atoms             -> burn/pay, then set liability to winning supply
redeem_pair(q_atoms)               -> burn/pay, then set liability to winning supply
```

The familiar `-q_atoms` delta for Pair/winning Redemption and zero delta for losing Redemption apply only when liability was already reconciled immediately before the instruction. If an earlier Direct Holder Burn left the conservative stored value stale, the post-burn reconciliation may reduce it by more.

Classic SPL Token allows a holder to burn tokens directly from an account they control. Such a burn is unsupported voluntary forfeiture: it transfers no USDC, invokes no Meridian instruction, and can only create additional ownerless Collateral Surplus. It never releases vault funds to the burner.

Anyone may call `reconcile_collateral_liability`. The program reads the canonical mint accounts and computes:

```text
outcome == Unset:  target_liability_atoms = max(yes_mint.supply, no_mint.supply)
outcome != Unset:  target_liability_atoms = winning_mint.supply

require target_liability_atoms <= collateral_liability_atoms
collateral_liability_atoms = target_liability_atoms
```

Reconciliation is idempotent and monotonic-decrease-only. `settle_market` invokes the same reconciliation primitive after writing the winner. A direct holder burn can therefore reduce the accounted liability only through a later reconciliation, but neither reconciliation nor any other V1 instruction transfers the resulting surplus.

Every Redemption-family instruction invokes the same primitive after its burns with trigger `Redemption`; explicit permissionless calls use `Explicit`, and `settle_market` uses `Settlement`. This keeps liability changes and the stable reconciliation event exhaustive even when a losing-token Redemption produces a no-op liability target.

Solvency:

```text
vault_balance_atoms >= collateral_liability_atoms
collateral_surplus_atoms = vault_balance_atoms - collateral_liability_atoms
```

Collateral Surplus cannot DoS the protocol and is ownerless and non-withdrawable in V1.

---

### ID-011 — Redemption model and Sell-No — ACCEPTED

Meridian and its PDAs invoke SPL Token burns only inside two Redemption families exposed through three public paths:

1. **Direct Pair Redemption before or after Settlement**
   - `redeem_pair(q_atoms)` when the user already holds equal free amounts of Yes+No.
2. **Market-assisted Pair Redemption during live trading**
   - `redeem_pair_via_market(q_atoms, max_yes_price)` for user-facing Sell No: acquire the missing Yes through OpenBook, then execute the same internal pair-redemption primitive.
3. **Outcome Redemption after Settlement**
   - `redeem_outcome(q_atoms, side)`.

`redeem_pair_via_market` is not modeled as an independent burn primitive. Internally:

```text
acquire missing Yes
-> apply_pair_redemption(Yes + No)
-> withdraw par less actual acquisition spend
```

Redemption minimum = **1 token atom**. V1 has no claim fee: one winning token atom or one Pair atom transfers exactly one USDC atom. Venue-backed actions require whole-contract quantities and reject, rather than round, invalid quantities.

A holder's direct call to the classic SPL Token burn instruction is outside Meridian's supported product paths. It is voluntary forfeiture, produces no Redemption payment or protocol event, and cannot authorize release of Collateral Surplus.

---

### ID-012 — Four trade paths — ACCEPTED

#### Buy Yes — Market

```text
meridian.take_full(Bid, q_atoms, max_yes_price)
```

#### Buy Yes — Limit

```text
[OO setup if needed,
 meridian.place_limit_order(PostOnly Bid, q_atoms, price)]
```

#### Sell Yes — Market

```text
meridian.take_full(Ask, q_atoms, min_yes_price)
```

#### Sell Yes — Limit

```text
meridian.place_limit_order(PostOnly Ask, q_atoms, price)
```

#### Buy No — Market

```text
[
  meridian.mint_pair(q_atoms),
  meridian.take_full(Ask, q_atoms, min_yes_price)
]
```

The user temporarily funds `q_atoms` USDC atoms; the Yes sale must fill completely or the entire transaction reverts. Effective No cost is `q_atoms - yes_proceeds_atoms`.

#### Buy No — Limit — strict one-approval requirement

```text
[
  create OpenOrdersIndexer if absent,
  create OpenOrdersAccount if absent,
  meridian.mint_pair(q_atoms), # init_if_needed canonical Yes + No ATAs, user pays
  meridian.place_limit_order(PostOnly Ask, q_atoms, 100-NoPrice)
]
```

This entire intent must fit one wallet transaction/approval to claim spec compliance.

G7 mitigation order:

1. Solana v0 transaction + the frozen deployment Address Lookup Table for stable global program/sysvar/Config/quote addresses; daily Outcome Market, Venue Market, Settlement Record, transport, wallet, and OpenOrders addresses remain inline.
2. Remove optional instructions/accounts. The funded classic-SPL USDC quote ATA may be a documented wallet prerequisite, but first-use compliance must include both absent canonical outcome ATAs in `mint_pair` rather than assuming them away.
3. If the user already has OpenOrders infrastructure, use it naturally — but this cannot be used to claim the first-use compliance gate passed.
4. If the **first-use** full composite still cannot fit, M0 fails the strict requirement and requires explicit stakeholder waiver before a two-approval UX is implemented.

#### Sell No — Market

Frontend "Sell No" calls:

```text
meridian.redeem_pair_via_market(q_atoms, max_yes_price)
```

Inside:

1. require `q_atoms > 0 && q_atoms % 1_000_000 == 0` and user No balance >= `q_atoms`;
2. pin all Meridian/OpenBook/vault accounts;
3. snapshot collateral vault and program Yes-trade ATA;
4. CPI `place_take_order(Bid)` using collateral vault as quote source and program Yes-trade ATA as base destination;
5. `penalty_payer = user`, never vault;
6. require exactly `q_atoms` Yes atoms acquired;
7. compute `yes_cost_atoms` from collateral-vault delta;
8. require `yes_cost_atoms <= (99 * q_atoms) / 100` and the confirmed Worst Execution Price;
9. call internal `apply_pair_redemption` to burn acquired Yes + user's No;
10. pay user `q_atoms - yes_cost_atoms` USDC atoms;
11. reconcile Collateral Liability to `max(post_burn_yes_supply_atoms, post_burn_no_supply_atoms)`; the delta is `-q_atoms` only from an already-reconciled pre-state;
12. assert vault delta = exactly `-q_atoms` from pre-instruction to post-instruction.

OpenBook's `place_take_order` has no self-trade field, so a race or adversarial call may economically self-cross against the user's own resting Yes ask. The path remains solvent because cost is measured from vault delta, but it is an **Internal Unwind**, not external price discovery or a realized sale. The normal transaction builder must not knowingly self-cross: fresh Position State detects matching own asks, cancels them, settles funds, and uses direct Pair Redemption when equal free Yes/No amounts exist. If that recovery composition cannot fit atomically, the UI requires the recovery approval before Sell No. Tests cover both the normal no-self-cross UX and the solvent race/adversarial occurrence.

#### Sell No — Limit

Not V1; the source Sell-No story does not require a resting limit close. No one-approval claim is made.

---

### ID-013 — Mint window — ACCEPTED

`mint_pair` is normatively gated:

```text
market.state == Active
&& mint_open_ts <= now
&& now < close_ts
&& !config.paused
&& !market.paused
```

No mint before 09:00, after close, on `Created`, `Settled`, `Abandoned`, or paused markets.

`mint_pair` validates the user's canonical Yes and No Associated Token Accounts and creates either or both with `init_if_needed` in the same instruction when absent, with the user as payer. It never accepts a noncanonical token destination. The user's funded classic-SPL USDC quote ATA may be a stated preflight prerequisite. First-use G7 starts with both outcome ATAs absent and includes their ATA Program/System Program CPIs, account metas, rent, bytes, and compute.

---

### ID-014 — Immutable Settlement Transport Versions — ACCEPTED

Governance registers immutable transport/provider versions per ticker. A version identifies the Switchboard feed/job that attests the complete Settlement Record; it never splits price and observation time across independently mutable feeds.

```text
SettlementTransportVersion {
  schema_version: u8,
  reserved_padding: [u8; 64],
  version_id: u32,
  ticker_id: u8,
  switchboard_program_id: Pubkey,
  switchboard_programdata: Pubkey,
  switchboard_deployment_slot: u64,
  switchboard_executable_sha256: [u8; 32],
  switchboard_upgrade_authority: Pubkey, # all-zero means None
  switchboard_feed: Pubkey,
  switchboard_job_hash: [u8; 32],
  provider_id: u16,
  close_method_id: u16,
  activated_trading_day: u32
}
```

Changing provider, Close Method, or job definition creates a new version. Existing versions referenced by an Outcome Market or unsettled Trading Day are never mutated.

The Switchboard executable identity is part of the version rather than a mutable global assumption. Registration verifies the executable owner, the Upgradeable Loader-derived ProgramData address, deployment slot, upgrade-authority field, and an off-chain independently reproduced executable hash. Normal finalization receives that ProgramData account read-only and checks its exact stored address, owner, slot, and authority while the transaction holds the account read lock. An immutable deployment is preferred. If an externally retained authority upgrades or rotates the snapshotted deployment, normal finalization fails closed; governance may register the new identity only for future Trading Days, while an already-Pending record remains bound to its old version and may reach only the documented delayed Manual path. The program never claims to compute the executable SHA-256 on-chain; G11/deployment tooling verifies and publishes that hash.

Config holds current, pending, pending-activation-day, and monotonic latest-created-Trading-Day slots per ticker. On-chain scheduling requires the new activation day to be later than that ticker's latest created day; automation additionally verifies it is a future NYSE Trading Day. For a target Trading Day, resolution returns pending when the target is on/after its activation day, otherwise current. Scheduling another version first promotes an already-effective pending version to current; if an existing pending version is not yet effective, replacement rejects. The new future entry can never change resolution for an earlier Trading Day. Every creation path and the ticker/day Pending Settlement Record header use this resolver.

---

### ID-015 — Shared Settlement Record Contract — ACCEPTED

For each ticker and Trading Day, Settlement uses the primary listing market's unadjusted Official Close. For the V1 MAG7 universe, this is Nasdaq NOCP under the recorded Close Method, including a documented halt/contingency method where Nasdaq declares one.

The canonical Settlement Record PDA is derived from `(ticker_id, trading_day)`. Creation of the first Outcome Market for the tuple initializes an immutable Pending header; every later Strike must match that header exactly. The result then transitions once from Pending to FinalOracle or, after the delay, FinalManual. The first valid result wins; anyone may submit a verified normal result and settle Outcome Markets without private credentials. Every Outcome Market for the tuple consumes this same record.

```text
SettlementRecord {
  state: SettlementRecordState(u8)

  header (immutable from first Outcome Market creation):
    schema_version: u8
    ticker_id: u8
    trading_day: u32
    close_ts: i64
    prior_official_close_1e6: u64
    settlement_transport_version_id: u32
    switchboard_program_id: Pubkey
    switchboard_programdata: Pubkey
    switchboard_deployment_slot: u64
    switchboard_executable_sha256: [u8; 32]
    switchboard_upgrade_authority: Pubkey
    switchboard_feed: Pubkey
    switchboard_job_hash: [u8; 32]
    provider_id: u16
    close_method_id: u16
    normal_settlement_delay_secs: u32
    min_samples: u8
    max_stale_slots: u64
    max_sample_spread_bps: u16
    max_price_band_bps: u16
    override_delay_secs: u32

  common result (zeroed while Pending; written atomically with state):
    official_close_1e6: u64
    halt_or_contingency_status: u8
    is_final: u8
    is_unadjusted: u8
    finalized_ts: i64

  FinalOracle-only result:
    official_close_observed_ts: i64
    exchange_published_ts: i64
    provider_observed_ts: i64
    provider_revision_hash: [u8; 32]
    source_record_id_hash: [u8; 32]
    raw_response_sha256: [u8; 32]
    delivery_update_slot: u64
    sample_count: u8
    sample_spread_bps: u16

  FinalManual-only result:
    manual_source_a_value_1e6: u64
    manual_source_b_value_1e6: u64
    override_reason_code: u16
    manual_evidence_manifest_sha256: [u8; 32]

  reserved_padding: [u8; 64]
}
```

A finalized record requires `is_final=1` and `is_unadjusted=1`. V1 config freezes `max_sample_spread_bps=0`; this is exact equality over normalized `u64` samples, not a rounded basis-point calculation. A nonzero tolerance requires a new product/architecture revision.

`HaltOrContingencyStatus (u8)` is frozen as `Invalid=0, NormalOfficialClose=1, OfficialCloseAfterHalt=2, OfficialContingencyClose=3`; all remaining values are reserved. `Invalid` cannot finalize, and a Trading Day for which the primary listing market publishes no Official Close remains Settlement Disputed rather than inventing a status or payout.

The hashes are fixed-field, domain-separated Borsh commitments:

```text
header_digest = SHA256(
  "MERIDIAN_SETTLEMENT_HEADER_V1" ||
  borsh(HeaderCommitmentV1)
)

result_digest = SHA256(
  "MERIDIAN_SETTLEMENT_RESULT_V1" ||
  borsh(ResultCommitmentV1)
)
```

`HeaderCommitmentV1` contains the header fields above in declaration order. `ResultCommitmentV1` contains `state`, every common result field, every FinalOracle-only field, and every FinalManual-only field in declaration order. Account padding and Anchor's account discriminator are never included. Outcome Markets store `result_digest` as `settlement_record_digest`; golden vectors freeze the domains, widths, endianness, order, state-dependent zero rules, and digests.

The header is initialized only from validated Config/schedule values, not caller-selected alternatives. Later Outcome Markets recheck exact close, prior-close, transport, quality, and delay equality before creation. Finalization consumes the Pending header directly and writes only the result, so a caller cannot win the permanent PDA with a registered but wrong transport version.

`finalize_settlement_record` validates:

1. canonical PDA identity, Pending state, and exact ticker/Trading Day;
2. the immutable transport version and quality terms in the preinitialized header;
3. atomic binding of price, observation, record identity, revision, and raw-response digest;
4. provider-declared final/unadjusted status and Nasdaq NOCP Close Method;
5. positive fixed-point normalization;
6. `close_ts <= official_close_observed_ts <= exchange_published_ts <= provider_observed_ts <= Clock.unix_timestamp`, and `finalized_ts` is the current Clock value no earlier than `close_ts`;
7. qualifying-trade, exact sample agreement (`max_sample_spread_bps=0`), delivery freshness, and prior Official Close sanity checks in the Settlement Quality Predicate;
8. stale/latest-value substitution resistance.

`max_stale_slots` applies only to the Switchboard delivery account at submission: require `submission_slot >= delivery_update_slot`, then checked-subtract and require `submission_slot - delivery_update_slot <= max_stale_slots`. It does not measure how recently the underlying market closed. Anyone may refresh or redeliver the same immutable source-record identity, provider revision hash, normalized fields, and raw-response digest, then retry permissionless finalization; changing any of those bound values is a different candidate and cannot launder a stale record as fresh.

The prior-close sanity band is inclusive and division-free. With positive `prior_official_close_1e6`, checked `u128` arithmetic must satisfy:

```text
abs_diff(official_close_1e6, prior_official_close_1e6) * 10_000
  <= prior_official_close_1e6 * max_price_band_bps
```

Any checked conversion or multiplication overflow rejects.

For `FinalOracle`, every common and FinalOracle-only field is populated from the verified atomic transport record, with `provider_revision_hash = SHA256(canonical opaque provider revision bytes)`; every FinalManual-only field is zero. For `FinalManual`, the two stored source values must be equal and positive, the common fields are populated, and `override_reason_code` plus `manual_evidence_manifest_sha256` are nonzero; every FinalOracle-only field is zero. Every unused state-dependent field must be zero, and `finalized_ts` always comes from the Solana Clock.

The service preflights at close-5m, begins final-record polling at close+15m, may settle automatically no earlier than close+20m, and raises the settlement-SLO incident at close+25m. The +20m earliest-Settlement gate is enforced on-chain from the immutable header; the other thresholds are operational, and none is an acceptance expiry, so a trustworthy normal result remains acceptable until Settlement. The +20m cutoff is devnet-specific; any non-demo deployment first requires a proven finalized Official Close source or a separately approved longer dispute window.

After the snapshotted delay of at least one hour, the Override Authority may submit a manual record. On-chain finalization enforces the delay, canonical ticker/Trading Day/header, positive values, exact equality of the two normalized `u64` values and stable halt/contingency statuses, both submitted final/unadjusted flags, distinct fixed-width source descriptors, Source A's SIP-consolidated class, a nonzero bounded reason, the ordered-manifest digest, canonical state-dependent zeroing, and for each source `close_ts <= official_close_observed_ts <= exchange_published_ts <= provider_observed_ts <= Clock.unix_timestamp`. Later, each `settle_market` call derives its Outcome Market's winner from the one stored price and that Market's immutable Strike.

The instruction supplies Source A followed by Source B in this fixed order:

```text
ManualSourceEvidenceV1 {
  source_class: u8
  provider_id: u16
  provider_revision_hash: [u8; 32]
  source_record_id_hash: [u8; 32]
  raw_response_sha256: [u8; 32]
  normalized_official_close_1e6: u64
  official_close_observed_ts: i64
  exchange_published_ts: i64
  provider_observed_ts: i64
  is_final: u8
  is_unadjusted: u8
  halt_or_contingency_status: u8
}

manual_evidence_manifest_sha256 = SHA256(
  "MERIDIAN_MANUAL_EVIDENCE_V1" ||
  borsh(ticker_id: u8, trading_day: u32, close_method_id: u16,
        override_reason_code: u16, source_a: ManualSourceEvidenceV1,
        source_b: ManualSourceEvidenceV1)
)
```

`ManualEvidenceSourceClass (u8)` is frozen as `Invalid=0, SipConsolidated=1, IndependentOther=2`; all remaining values are reserved. The program rejects identical source descriptors, requires Source A to be `SipConsolidated`, requires Source B's class to be nonzero, requires both entries to agree on the normalized Official Close and stable halt/contingency status, uses that status in the common FinalManual result, re-derives the manifest, and stores its digest.

The complete raw responses and retrieval log are retained off-chain. Critically, Solana cannot authenticate the submitted HTTPS responses, prove they were independently fetched, or validate entitlement provenance. Those facts and faithful normalization are attested by the Override Authority and controlled by the manual-settlement runbook. The isolated cold devnet key is therefore a real delayed-price trust root used only offline and never loaded into automation/frontend. Every non-demo deployment requires a multisignature Override Authority; a single-key override is prohibited.

If evidence never converges or Nasdaq publishes no Official Close, the Outcome Markets remain Settlement Disputed indefinitely. Pair Redemption stays available; unmatched positions wait for evidence. No void, draw, last-trade, midpoint, previous-close, vendor-bar, or discretionary fallback is invented. Later corrections create incident annotations and never mutate Settlement or payouts.

---

### ID-016 — Directional Guardrail — ACCEPTED, frontend-enforced

The frontend derives Position State and its worst-case Exposure Interval from wallet holdings, Venue Market free/locked balances, and every resting or pending order for the Outcome Market:

- Flat Position may open either direction;
- Yes-sided Position may add/exit Yes exposure but cannot cross into No exposure;
- No-sided Position may add/exit No exposure but cannot cross into Yes exposure;
- Mixed Position and Unknown Position fail closed for new Directional Intents;
- cancellation, fund settlement, Pair Redemption, Outcome Redemption, and guided exit recovery remain available;
- the Buy-No-limit composite is an explicit valid transition, not a balance-only violation;
- freely transferred fractional tokens remain recoverable at atom granularity.

Every resting or signed-but-unfinalized intent contributes its possible signed exposure delta until finalized or expired. Shared/Rust interval math uses checked signed `i128`; TypeScript uses `bigint` and never JavaScript `number` for atom totals. An unresolved pending transaction makes Position State Unknown and keeps the app in Recovery-only Mode.

This is a **UI/product guardrail**, not an on-chain invariant. When fresh authoritative Position State or venue data is unavailable, the app enters Recovery-only Mode rather than presenting stale prices, P&L, probabilities, or new Directional Intents.

Playwright tests cover every Position State, future/resting-order fill boundary, Recovery-only Mode, and recovery action.

---

### ID-017 — Frontend/client stack — ACCEPTED

- Next.js under `frontend/`.
- Metaplex Umi + wallet-adapter + `walletAdapterIdentity`.
- Codama-generated Umi client for Meridian.
- Official/pinned OpenBook TS client behind `packages/openbook-adapter`.
- Raw web3.js/Anchor/OpenBook types stay at the adapter boundary.
- Order creation always invokes Meridian instructions; the app never directly constructs supported OpenBook order-creation transactions.
- Direct OpenBook cancel/consume plumbing may be built by the adapter because those operations are intentionally permissionless/user-authorized recovery paths.

### Repository ADRs 0018–0028 — ACCEPTED

The repository ADRs additionally freeze the following V1 behavior and override any stale historical wording in this document:

- Emergency Expiry is the conditional one-way fuse in ADR-0018.
- Recovery-only Mode and explicit Worst Execution Price/minimum proceeds are required by ADR-0019.
- M0 is the non-waiverable safety boundary in ADR-0020.
- Nasdaq NOCP and its declared Close Method define Official Close under ADR-0021.
- share- or identity-changing Trading Days are Corporate Action Blackouts under ADR-0022.
- one permanent permissionless Settlement Record per ticker/Trading Day is finalized under ADR-0023.
- roles rotate in two steps and devnet upgrade trust is published under ADR-0024.
- the deployment Address Lookup Table is content-checked and frozen under ADR-0025.
- halts/suspensions follow the pause/resume/dispute policy in ADR-0026.
- Rent Refund Addresses are snapshotted under ADR-0027.
- deterministic synthetic demo and real oracle proof are separate commands under ADR-0028.

The final devnet demo has a non-waiverable authority gate: before M6 acceptance, program upgrade authority must be transferred to and verified under a 2-of-3 multisig. A single-key upgrade authority is allowed only during earlier POC implementation and cannot pass the final demo. Every non-demo deployment also requires multisignature upgrade and Override Authority policies.

The mechanism is frozen to the immutable Squads Protocol V4 deployment on devnet:

```text
SQUADS_V4_PROGRAM_ID = SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
SQUADS_V4_AUDITED_COMMIT = 64af7330413d5c85cbbccfd8c27a05d45b6e666f
SQUADS_V4_SDK = @sqds/multisig@2.1.4
members = 3 distinct published pubkeys
threshold = 2
member permissions = Initiate + Vote + Execute
configAuthority = null
vault_index = 0
devnet_timelock_secs = 0
```

The derived vault PDA—not the Squads multisig account—is the Meridian Upgradeable Loader authority. The package version and lockfile are exact; deployment scripts pass the expected Squads program ID explicitly. M6 creates a vault transaction containing the decoded loader instruction, creates/activates its proposal, proves one approval cannot execute, collects two distinct approvals, and executes through the vault PDA. Finalized inspection must show the expected ProgramData owner/authority, changed deployment slot, and unchanged expected executable hash after a reproducible version-identical upgrade; the old deployer must fail. The Squads program executable is independently verified against the audited commit before transfer.

For non-demo Manual Settlement Override, Config stores a separately approved Squads vault PDA. A direct member signature cannot satisfy Meridian's signer/address constraint; an approved two-vote Squads vault transaction can. The separate multisig's members, custody, timelock, and deployment address are published before non-demo use. The multisig changes authorization, not the documented human trust assumption for HTTP evidence. Primary-source evidence and the full gate inventory are in [`docs/agents/squads-v4-multisig-research.md`](./agents/squads-v4-multisig-research.md).

---

## 5. Daily Lifecycle

```text
08:00 ET
  verify NYSE Trading Day and per-symbol eligibility
  check two corporate-action sources; black out disqualifying tickers
  fetch prior Official Close
  generate ±3/6/9% strikes + default rounded ATM
  round $10, dedupe

08:30 ET
  per strike:
    publish/canonicalize metadata image + JSON to Arweave
    verify exact bytes through two gateways
    create_strike_market
      -> Yes/No mints
      -> immutable metadata
      -> collateral vault
      -> program Yes-trade ATA
      -> immutable schedule/settlement transport snapshots
      -> Rent Refund Addresses

    create_venue_market
      -> base Yes / quote USDC
      -> sole creation authority signer is Meridian venue-market-authority PDA
      -> Meridian trade/close PDAs
      -> unsignable fee-admin sentinel; zero maker/taker fees
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
  indexer updates book/History Completeness/Platform-execution P&L
  operator may add_strike until close-30m -> same publish/create/OpenBook/attach pipeline
  a halt/suspension pauses new Directional Intents and preserves recovery

close-5m
  Settlement Record provider/transport health preflight
  keeper enters close-window SLO

16:00 ET or calendar early close
  mint gate closes
  trading wrapper closes
  OpenBook market expired by time_expiry

close+15m
  begin polling/finalizing the shared Settlement Record

close+20m
  earliest automatic Settlement from a final accepted record

close+25m
  settlement-SLO incident if any Outcome Market remains unresolved
  continue accepting trustworthy normal evidence without an on-chain deadline

post-close
  drain EventHeap
  cancel/prune expired orders
  settle user OpenOrders funds
  users redeem outcomes

>= close+1h
  evidenced Manual Settlement Override additionally eligible

indefinitely
  absent trustworthy evidence -> Settlement Disputed
  direct Pair Redemption remains available; unmatched positions wait
```

These lifecycle times are driven by a **durable scheduler**, not a polling
loop: the market-creation/`add_strike` and settlement runners are scheduled jobs
that fire at the times above (settlement gated on the Official Close being
published), and intraday EventHeap cranking is an **account subscription** that
is idle in the inline-first common path (ID-007) rather than a per-second poll.
At-least-once scheduling is safe because every action is idempotent on-chain.
See ADR-0031 and `docs/PRODUCTION_INFRA.md`; the always-on `services/keeper` loop
is a localnet-demo affordance only.

**Rolling creation (ADR-0032).** The 08:00/08:30 morning block above is a
timing convenience, not a dependency: the strike ladder anchors on the prior
Official Close, which is only known at settlement (~close+20m). So the next
session's markets are created at **resolution + 5 minutes** (~close+30m), off
the settlement job's completion, as a continuous roll rather than a next-morning
batch — the chain is 24/7 and this is the earliest the anchor exists. **Trading
opens when the market exists (ADR-0033)**, not at the session bell: the schedule
is `mint_open = creation`, `trade_open = creation + 30m` (the 30-minute mint-seed
lead is kept), `close = the NYSE session close` — a creation→close window of
~23.5h overnight, up to ~4 days across a long-weekend gap, still settling on the
same 4pm Official Close. The morning
job's safety gates move with it: NYSE trading-day eligibility (ADR-0014) and the
two-source Corporate Action Blackout (ADR-0022) are evaluated at creation for the
target session, and a **pre-open re-validation gate** `abandon_market`s any
market that stops qualifying before its mint window opens (critical across
weekend/holiday gaps). The resolution window (close+15/20/25m) is unchanged.

### Intraday `add_strike`

`add_strike(ticker, strike, day)` is operator-only and allowed while:

```text
now <= close_ts - 30 minutes
config not globally paused for creation
unique (ticker,strike,day) PDA
strike passes $10-multiple / ticker validation
day is the current NYSE Trading Day, including the canonical early close
no Corporate Action Blackout or known halt/suspension before issuance
current SettlementTransportVersion exists
```

It executes the same lifecycle as morning creation:

```text
add_strike/create_strike_market equivalent
-> create_venue_market
-> attach_venue
```

The added Outcome Market snapshots the active future-safe configuration and Settlement Transport Version allowed for that Trading Day. Config changes scheduled for future Trading Days do not alter existing or intraday Outcome Markets. Metadata publication and verification complete before any immutable mint account is created.

---

## 6. Strike Engine

Formula in fixed point:

```text
raw = prior_official_close * (1 + offset_bps / 10_000)
strike = round_half_up(raw / $10) * $10
```

Offsets:

```text
[-900, -600, -300, +300, +600, +900]
```

Default ATM = prior Official Close rounded to nearest $10.

Deduplicate equal rounded strikes.

### Required verbatim acceptance vectors

#### META prior Official Close $680

Expected with ATM enabled:

```text
$620, $640, $660, $680, $700, $720, $740
```

#### AAPL prior Official Close $230

Raw rounded set contains duplicates; after dedupe expected:

```text
$210, $220, $230, $240, $250
```

Tests also cover half-up boundaries, negative/overflow guards, deterministic ordering, ATM deduplication, and Corporate Action Blackout. V1 does not create Outcome Markets on effective splits, stock dividends, spin-offs, mergers, rights distributions, reorganizations, or security-identity changes; ordinary cash-dividend ex-dates remain eligible and their price movement counts.

---

## 7. On-Chain Program Design

### 7.1 Accounts and snapshots

#### Config

Stores:

- `schema_version: u8` + `reserved_padding: [u8; 64]`;
- `governance`, pending governance;
- `operator`, pending operator;
- `pause_authority`, pending Pause Authority;
- `override_authority`, pending Override Authority;
- pinned Circle Devnet USDC `quote_mint`, classic SPL `token_program`, and `quote_decimals = 6`;
- immutable OpenBook executable identity: program ID, ProgramData address, deployment slot, executable SHA-256 audit commitment, and all-zero/`None` upgrade authority;
- global pause;
- current/future-day settlement config;
- Settlement Transport Version registry plus current/pending version, pending-activation-day, and monotonic latest-created-Trading-Day slots per ticker;
- permanent ticker discriminants and fixed `supported_ticker_mask` for IDs 1–7.

Compile-time caps/floors:

```text
MIN_OVERRIDE_DELAY_SECS = 3600
MIN_ADD_STRIKE_LEAD_SECS = 1800
DEVNET_NORMAL_SETTLEMENT_DELAY_SECS = 1200
MIN_SETTLEMENT_SAMPLES = 2
MAX_SETTLEMENT_SAMPLES = 32
MIN_SETTLEMENT_STALE_SLOTS = 1
MAX_SETTLEMENT_STALE_SLOTS = 450
MIN_SETTLEMENT_PRICE_BAND_BPS = 1
MAX_SETTLEMENT_PRICE_BAND_BPS = 5000
OUTCOME_TOKEN_DECIMALS   = 6
QUOTE_TOKEN_DECIMALS     = 6
```

Config and `set_params` reject quality values outside those inclusive bounds, and V1 always requires `max_sample_spread_bps = 0`. G11 calibration must publish the selected `min_samples`, `max_stale_slots`, and `max_price_band_bps` in a signed `docs/adr/settlement-quality-calibration.md` before M1; those exact values are deployed for future Trading Days and snapshotted into each ticker/day header.

Stable wire identities are explicit and never follow source declaration order:

```text
TickerId (u8):              Invalid=0, AAPL=1, AMZN=2, GOOGL=3, META=4, MSFT=5, NVDA=6, TSLA=7
MarketState (u8):           Uninitialized=0, Created=1, Active=2, Settled=3, Abandoned=4
Outcome (u8):               Unset=0, Yes=1, No=2
SettlementRecordState (u8): Pending=0, FinalOracle=1, FinalManual=2
```

All remaining values are reserved. IDs are never reused; account schema versions, reserved padding, and golden PDA vectors protect compatibility. Market Phase is a user-visible projection and is not this serialized `MarketState` enum.

Config, Settlement Transport Version, Settlement Record, and Outcome Market each reserve exactly `[u8; 64]` for future account-compatible fields. G8 sizes and funds accounts including those 64 bytes. Padding remains zeroed and is excluded from semantic digests.

The venue authority seeds are permanent and covered by golden PDA vectors:

```text
venue_market_authority = ["venue-market-authority", outcome_market_pubkey]
venue_trade_authority  = ["venue-trade", outcome_market_pubkey]
venue_close_authority  = ["venue-close", outcome_market_pubkey]
```

#### Outcome Market

Stores explicitly:

```text
identity:
  schema_version: u8
  reserved_padding: [u8; 64]
  ticker_id
  strike_1e6
  trading_day
  prior_official_close_1e6

lifecycle:
  mint_open_ts
  trade_open_ts
  close_ts
  state
  activity_started
  paused
  emergency_expired
  emergency_expired_ts
  emergency_reason_code

outcome:
  settlement_price_1e6
  outcome
  settled_ts
  settlement_record
  settlement_record_digest
  manual_settled

assets:
  yes_mint
  no_mint
  collateral_vault
  program_yes_trade_ata

venue:
  openbook_market
  openbook_market_authority: Pubkey
  bids
  asks
  event_heap
  openbook_base_vault
  openbook_quote_vault
  venue_market_authority_bump
  venue_trade_authority_bump
  venue_close_authority_bump

settlement transport snapshot:
  settlement_transport_version_id
  switchboard_program_id
  switchboard_programdata
  switchboard_deployment_slot
  switchboard_executable_sha256
  switchboard_upgrade_authority
  switchboard_feed
  switchboard_job_hash
  provider_id
  close_method_id

settlement snapshot:
  normal_settlement_delay_secs
  min_samples
  max_stale_slots
  max_sample_spread_bps
  max_price_band_bps
  override_delay_secs

metadata:
  yes_metadata_uri_hash
  yes_metadata_sha256
  yes_image_uri_hash
  yes_image_sha256
  no_metadata_uri_hash
  no_metadata_sha256
  no_image_uri_hash
  no_image_sha256
  metadata_manifest_sha256

rent refunds:
  market_rent_refund_address
  venue_rent_refund_address

accounting:
  collateral_liability_atoms

safety flags:
  permanent_pause_reason
```

No generic "settlement params" bucket is acceptable in code/IDL; fields above are individually testable.

Metadata JSON is serialized as RFC 8785 canonical UTF-8 bytes; images use their exact binary bytes. The manifest root is:

```text
SHA256(
  "MERIDIAN_METADATA_V1" ||
  yes_metadata_uri_hash || yes_metadata_sha256 ||
  yes_image_uri_hash    || yes_image_sha256    ||
  no_metadata_uri_hash  || no_metadata_sha256  ||
  no_image_uri_hash     || no_image_sha256
)
```

Each field is 32 bytes and the order is fixed. Two-gateway byte verification occurs off-chain before the transaction. On-chain creation binds the submitted URI/content digests, re-derives the manifest root, and validates the Yes/No Metaplex accounts, mints, URIs, `update_authority = Market PDA`, and `is_mutable = false`; it never claims to fetch gateway content.

#### Settlement Record

One permanent canonical account per `(ticker_id, trading_day)` stores the fixed-width atomically bound record enumerated in ID-015. Its PDA is `["settlement-record", ticker_id_u8, trading_day_yyyymmdd_le_u32]`. The first Outcome Market initializes its immutable Pending header and domain-separated `header_digest`; every later Strike must match. The result transitions once to FinalOracle or FinalManual, computes `result_digest`, and all Outcome Markets for the tuple reference that digest. Reserved padding is excluded from both commitments.

#### Collateral Surplus

No Treasury account or surplus ledger exists in V1. `vault_balance_atoms - collateral_liability_atoms` is observable Collateral Surplus, but it is ownerless and non-withdrawable.

---

### 7.2 Instruction set

| Instruction | Caller | Gates / effect |
|---|---|---|
| `initialize_config` | deployer | initialize versioned config, roles, pinned quote mint, and the G1-verified immutable OpenBook program/ProgramData/slot/hash identity; reject any retained OpenBook upgrade authority |
| `set_params` | governance | compile-time floors; future-Trading-Day activation only; never mutates or lowers an existing Settlement Record header |
| `register_settlement_transport_version` | governance | append immutable transport/provider/Close Method version |
| `activate_settlement_transport_version` | governance | future-Trading-Day pointer only |
| `rotate_role` / `accept_role` | governance/incoming | two-step role transfer |
| `create_strike_market` | operator | global pause clear; unique; for every current-Trading-Day call require `now <= close_ts - 30m`; validate metadata/schedule/assets and resolved transport; initialize the ticker/day Pending Settlement Record header if absent or require an exact match; create assets/snapshots; state `Created` |
| `add_strike` | operator | global pause clear; current Trading Day, no blackout/halt, `now <= close_ts - 30m`; same Pending-header match and creation validation |
| `create_venue_market` | operator | Created and global pause clear; operator pays all OpenBook account rent; CPI through pinned program with exact header/admin/fee/expiry/oracle/lot values; sole authority signer is the derived `venue_market_authority` PDA |
| `attach_venue` | operator | global pause clear; exact OpenBook validation including the derived `venue_market_authority`; state `Created -> Active` |
| `abandon_market` | operator | Created or Active; `activity_started == false`; zero liability/supply/orders/EventHeap/balances; terminal tombstone retained; close only pinned reclaimable accounts to snapshotted refund addresses |
| `mint_pair` | anyone | **Active; mint_open_ts <= now < close_ts; not paused**; `q_atoms > 0`; validate or user-fund `init_if_needed` canonical Yes/No ATAs; deposit `q_atoms` USDC atoms; mint equal Yes/No atoms; liability += `q_atoms` |
| `redeem_pair` | holder | Active or Settled recovery; burn equal `q_atoms` Yes/No; pay `q_atoms` USDC; reconcile liability to the state-dependent supply target |
| `place_limit_order` | user | hard trading gate; PostOnly; fixed self-trade/expiry; CPI OpenBook |
| `take_full` | user | hard trading gate; CPI `place_take_order`; exact-full-fill postcondition |
| `redeem_pair_via_market` | No holder | hard trading gate; acquire Yes via OpenBook then shared pair redemption |
| `settle_openbook_funds` | OO owner/delegate | recovery path; wallet pays operating costs |
| `prune_expired_venue` | anyone, **only if M0 proves pinned support** | post-close; exact stored accounts; CPI with venue-close PDA; no client destination |
| `close_venue` | anyone, **only if M0 proves pinned support** | post-close and fully empty; exact stored accounts; recoverable operator-funded rent only to snapshotted Venue Rent Refund Address |
| `finalize_settlement_record` | anyone | validate the read-locked Switchboard ProgramData identity plus atomic candidate against the Pending canonical header and Settlement Quality Predicate; write only the FinalOracle result once; may occur before the Settlement delay |
| `finalize_manual_settlement_record` | Override Authority | after the Pending header's snapshotted delay; equal positive source A/B normalized values + reason/ordered-manifest digest; canonical FinalManual field population; write once |
| `settle_market` | anyone | require a final canonical record and `Clock.now >= close_ts + normal_settlement_delay_secs`; match the Market snapshots to the header; derive immutable at-or-above outcome, then reconcile liability to winning supply without transferring surplus |
| `redeem_outcome` | holder | Settled; winning atoms pay matching USDC atoms; losing atoms burn for zero |
| `reconcile_collateral_liability` | anyone | read canonical mint supplies; when `outcome == Unset` target `max(yes_supply,no_supply)`, otherwise target `winning_supply`; decrease liability only; transfer no funds |
| `pause` / `unpause` | pause_authority | global/per-market new-activity gate; explicit safe resume |
| `permanently_pause_market` | Pause Authority | one-way bounded reason; preserve recovery and Settlement; `unpause` thereafter rejects |
| `emergency_expire_venue` | Pause Authority, **only if M0 recovery proof passes** | paused, pre-close only; irreversible CPI via venue-close signer; immutable reason |

Global pause blocks Outcome Market creation, Add Strike, Venue Market creation/attachment/activation, minting, and every new Directional Intent. It preserves cancellation, event consumption, OpenBook fund settlement, direct Pair Redemption, liability reconciliation, Settlement Record finalization, Outcome Market Settlement, and Outcome Redemption. Pause does not mutate resting orders; they may fill again only after every applicable pause is explicitly and safely cleared, with an explicit UI warning.

`activity_started` is false at creation and monotonic. The first successful `mint_pair` or Meridian order authorization sets it true in the same transaction. Abandonment never clears it and retains the Market account as an `Abandoned` tombstone, so the same identity cannot be recreated.

Every successful global or market `pause`/`unpause` emits the same stable event shape:

```text
PauseChanged {
  schema_version: u8,
  scope: u8,                 // Invalid=0, Global=1, OutcomeMarket=2
  outcome_market: Pubkey,    // all-zero for Global
  paused: u8,
  permanent: u8,
  reason_code: u16,
  authority: Pubkey,
  slot: u64
}
```

`paused` and `permanent` are each exactly 0 or 1. `permanently_pause_market` emits market-scoped `PauseChanged` with both values 1 in addition to `MarketPermanentlyPaused`. Enum values and field widths are frozen; the indexer never infers pause state only from transaction names.

Every explicit, Settlement-triggered, or Redemption-triggered liability reconciliation emits:

```text
CollateralLiabilityReconciled {
  schema_version: u8,
  trigger: u8,
  phase: u8,
  outcome_market: Pubkey,
  caller: Pubkey,
  old_liability_atoms: u64,
  new_liability_atoms: u64,
  yes_supply_atoms: u64,
  no_supply_atoms: u64,
  winning_side: u8,
  slot: u64
}
```

`trigger (u8)` is `Invalid=0, Explicit=1, Settlement=2, Redemption=3`; `phase (u8)` is `Invalid=0, PreSettlement=1, PostSettlement=2`; and `winning_side` uses the frozen `Outcome` enum with `Unset` before Settlement. All remaining values are reserved. `caller` is the outer instruction signer even when reconciliation runs internally. The event is emitted for every Redemption-family path and even when an idempotent call leaves liability unchanged, making indexer reconciliation exhaustive. The stored `openbook_market_authority: Pubkey` and `venue_market_authority_bump` together freeze the exact derived OpenBook Market authority.

---

### 7.3 `attach_venue` exact validation

Reject unless:

```text
account.owner == PINNED_OPENBOOK_PROGRAM_ID
base_mint      == market.yes_mint
quote_mint     == config.quote_mint
quote_mint     == 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU on devnet
quote owner/program/decimals == pinned classic SPL Token / 6

base_lot_size  == 1_000_000
quote_lot_size == 10_000

open_orders_admin    == derived venue_trade_authority
collect_fee_admin    == UNSIGNABLE_FEE_ADMIN_SENTINEL
consume_events_admin == None
close_market_admin   == derived venue_close_authority
market_authority      == derived venue_market_authority

time_expiry == close_ts - 1

maker_fee == 0
taker_fee == 0

oracle_a == None
oracle_b == None
```

Also store and cross-check bids, asks, EventHeap, the derived OpenBook market authority, and market vault addresses from the OpenBook market account. `attach_venue` rejects a market not created under the exact `venue_market_authority` PDA even if every other header field matches. Every OpenBook authority is either the proven unsignable sentinel, `None`, or a Meridian PDA that can sign only through its allowlisted create/trade/close wrapper; no operator/service key is retained. Meridian has no wrapper that signs as `venue_market_authority` after successful creation.

First-use composite transactions use the deployment Address Lookup Table whose exact contents are published and client-checked. After M0 freezes the stable account set, the ALT authority is removed.

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
decoded OpenBook owner/mints/market authority == stored expected values
decoded lot sizes == 1_000_000 / 10_000
decoded open_orders_admin == derived trade PDA
decoded collect_fee_admin == unsignable sentinel
decoded consume_events_admin == None
decoded close_market_admin == derived close PDA
decoded time_expiry == close_ts - 1
decoded maker_fee/taker_fee == 0
decoded oracle_a/oracle_b == None
price_lots in [1,99]
quantity is whole-token lots
```

This is per-order defense-in-depth, not attach-only validation. M0 enumerates every pinned OpenBook instruction that could edit a Market header after attachment. Any permissionless mutation or operator/service-held authority capable of changing an admin, fee, expiry, oracle, lot, mint, vault, or order-gateway field fails G1/G2/G9 and blocks M1.

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
confirmed Worst Execution Price or minimum proceeds
OpenBook remaining maker accounts <= 15
penalty_payer = user wallet
```

Then verifies exact base delta.

---

### 7.5 Invariants

#### I1 — Collateral solvency

```text
vault_balance_atoms >= collateral_liability_atoms

while outcome == Unset:
  collateral_liability_atoms >= max(yes_mint.supply, no_mint.supply)

while outcome != Unset:
  collateral_liability_atoms >= winning_mint.supply
```

Supported Meridian mint/Redemption paths maintain equality. A permissionless reconciliation may only decrease liability to the applicable supply target; it never transfers collateral.

#### I2 — Payout complement

```text
Yes payout atoms + No payout atoms == one USDC atom per outcome-token atom
```

Equality at the Strike resolves to Yes.

#### I3 — Meridian mint/burn authority paths

Creation:

```text
mint_pair only
```

Meridian/PDA-originated burns are through the **Redemption family only**:

```text
direct pair redemption before or after Settlement:
  redeem_pair

market-assisted pair redemption during live trading:
  redeem_pair_via_market -> shared apply_pair_redemption

outcome redemption post-settlement:
  redeem_outcome
```

A holder-authorized direct classic-SPL burn is possible outside Meridian. It is unsupported voluntary forfeiture, emits no Meridian Redemption event, cannot transfer vault funds, and leaves any resulting Collateral Surplus ownerless.

#### I4 — Settlement immutability

The canonical Settlement Record header is immutable after the first Outcome Market creation; its result and every Outcome Market outcome are each written once. Normal record finalization may occur earlier, but `settle_market` requires `Clock.now >= close_ts + normal_settlement_delay_secs`, whose live snapshot cannot be lowered. Settled is terminal; later corrections create incident annotations rather than payout changes.

#### I5 — Mandatory venue authorization

No OpenBook order creation on a Meridian market succeeds without Meridian's `venue_trade_authority` PDA signature.

#### I6 — Trading window

No order creation before `trade_open_ts`, while paused, or at/after `close_ts`.

#### I7 — Zero fees and locked Collateral Surplus

```text
OpenBook maker_fee == 0
OpenBook taker_fee == 0
OpenBook collect_fee_admin == UNSIGNABLE_FEE_ADMIN_SENTINEL
no Meridian protocol-fee or surplus-withdrawal instruction exists
```

Collateral Surplus is observable but ownerless and non-withdrawable.

#### I7a — Liability reconciliation

```text
target = outcome != Unset ? winning_mint.supply : max(yes_mint.supply, no_mint.supply)
reconcile succeeds only when target <= collateral_liability_atoms
new collateral_liability_atoms == target
vault transfer delta == 0
```

`settle_market` sets the winner locally, invokes the primitive with the explicit PostSettlement phase while `state` is still Active, and marks the Market Settled only after reconciliation succeeds; Solana atomicity rolls all three steps back together on failure. Every Redemption family invokes the primitive after burning; repeated permissionless calls and losing-token Redemption no-ops are idempotent and evented.

#### I8 — Market-term immutability

After Outcome Market creation, no privileged config action changes any snapshotted field listed in §7.1.

#### I9 — Mint window

```text
mint_pair succeeds iff:
  state == Active
  && mint_open_ts <= now < close_ts
  && !paused
```

#### I10 — Sell-No pair-redemption solvency

For `redeem_pair_via_market(q_atoms)` where `q_atoms > 0 && q_atoms % 1_000_000 == 0`:

```text
exact_yes_atoms_acquired == q_atoms
actual_yes_cost_atoms <= (99 * q_atoms) / 100
final_vault_delta_atoms == -q_atoms
new_liability_atoms == max(post_burn_yes_supply_atoms, post_burn_no_supply_atoms)
program_yes_trade_ata returns to pre-instruction balance
```

When the pre-instruction liability already equals the pre-instruction supply target, the liability delta is exactly `-q_atoms`; an earlier Direct Holder Burn may make the reconciliation decrease larger.

#### I11 — Shared Settlement Record

```text
one (ticker_id, trading_day) -> one permanent canonical Settlement Record
all Outcome Markets for that tuple consume the same record
first valid normal-or-manual finalization wins
```

#### I12 — CPI allowlist

Meridian CPIs only to the pinned SPL Token, Associated Token Account, Metaplex Token Metadata, OpenBook V2, and System Programs. System Program use is limited to required account initialization with exact PDA, payer, owner, space, and rent validation (`create_account` or equivalent allocate/assign/funding steps). Public settlement delivery is an account-read path; no caller supplies an arbitrary CPI program ID.

---

## 8. OpenBook Market Parameters

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

### Zero-fee header

```text
maker_fee        = 0
taker_fee        = 0
collect_fee_admin = UNSIGNABLE_FEE_ADMIN_SENTINEL
```

G9 proves the sentinel cannot sign and rejects every alternative/nonzero header. No conversion helper or dormant fee switch exists.

---

## 9. Venue Cleanup and Rent

OpenBook cleanup never affects user solvency.

Post-expiry workflow:

1. keeper drains EventHeap;
2. owners cancel or close/prune removes expired book entries as allowed;
3. owners call `settle_openbook_funds`;
4. empty OpenOrders accounts may close and return user-funded rent to the user payer/owner;
5. if M0 proves the exact pinned instructions, anyone may call Meridian's `prune_expired_venue` and `close_venue` wrappers; both pin every account and sign through `venue_close_authority`, and closure returns operator-funded recoverable rent only to the snapshotted Venue Rent Refund Address.

### Creation failure

Users cannot mint until `attach_venue` produces `Active`.

If creation fails before issuance or order activity, whether the Market is still Created or has already been attached as Active:

- metadata upload or two-gateway byte verification failure aborts before mint/account creation;
- production Arweave is the primary permanent store; an IPFS fallback is eligible only with a raw content CID and two independently verified pins;
- retry valid venue attach;
- if `activity_started == false` and every liability, supply, order, EventHeap entry, and venue balance is empty, retain the Market as a terminal Abandoned tombstone and close only M0-proven reclaimable child/venue accounts to their snapshotted refund destinations;
- do not recreate the same ticker/Strike/Trading Day identity after immutable asset accounts exist;
- classic SPL mints, Metaplex metadata, and permanent-storage publication are explicitly non-reclaimable V1 creation costs;
- OpenBook account rent is reclaimed only through OpenBook-supported close semantics; no plan claim exceeds those semantics.

Once issuance or order activity occurs, an erroneous Outcome Market is permanently paused while recovery and Settlement remain available; V1 never replaces its identity.

---

## 10. Automation Service

Node/TypeScript; `America/New_York`; NYSE's published schedule is authoritative. The Alpaca Calendar API supplies the operational schedule, cached annually and compared with checked-in NYSE fixtures; disagreement fails loudly.

### 08:00 — strike generation

- verify the Trading Day and early-close schedule;
- check two corporate-action sources and apply Corporate Action Blackout;
- check per-symbol halt/suspension/eligibility state;
- fetch the prior Official Close;
- run deterministic engine;
- verify duplicates/limits;
- include the rounded prior-close ATM Strike by default;
- log planned Outcome Markets and exclusions.

### 08:30 — market creation

For each strike:

```text
publish and verify canonical metadata/image
create_strike_market
create_venue_market
attach_venue
```

Idempotent/restart-safe.

### Intraday Add Strike

Operator command/API:

```text
make add-strike TICKER=META STRIKE=690
```

Accepts at exactly `close_ts - 30 minutes` and rejects one second later, including on early closes. It runs the same metadata/create/OpenBook/attach path and emits audit logs.

### Symbol-status monitor

- automation may use its Operator key to abandon an empty pre-issuance halted/suspended ticker under the on-chain checks;
- after issuance, automation detects the status, emits a critical alert and deterministic unsigned `pause`/`permanently_pause_market` action payload, and the separate Pause Authority runbook signs it;
- the Pause Authority may resume a temporary halt pause only when automation reports trading resumed and all safety checks remain satisfied;
- settle from Nasdaq's declared Official Close/Close Method when one exists;
- otherwise expose Settlement Disputed and never substitute an unofficial price;
- when a disqualifying corporate action is discovered after issuance, the Pause Authority runbook signs the one-way permanent pause, preserves recovery, keeps the issued Strike unchanged, and emits a high-severity incident annotation;
- if an Official Close exists after that late discovery, settle the literal issued terms rather than adjusting or replacing the Outcome Market.

### Alert delivery contract

Automation emits every alert as structured JSON to stdout/stderr first; this structured-console path remains available when no receiver is configured or delivery fails. Unattended devnet operation is prohibited until an actual receiver and on-call owner are selected and a signed-webhook integration test passes.

The stable JSON payload is:

```text
schema_version: 1
event_id
occurred_at
severity: info | warning | critical
code
summary
ticker_id? / trading_day? / outcome_market?
transaction_signature? / evidence_sha256?
```

When `ALERT_WEBHOOK_URL` is configured, automation sends the exact JSON request bytes with:

```text
X-Meridian-Timestamp: <unix-seconds>
X-Meridian-Key-Id: <ALERT_WEBHOOK_KEY_ID>
X-Meridian-Signature: v1=<lowercase hex HMAC-SHA256>

signed_bytes = ascii(timestamp) || "." || exact_request_body_bytes
```

The secret comes only from `ALERT_WEBHOOK_HMAC_SECRET_PATH`; it is read from its secret mount and never stored in JSON, logs, source, literal environment values, console fallback, or frontend configuration. The receiver verifies exact received bytes before JSON parsing and rejects unknown key IDs, invalid signatures, timestamps outside `ALERT_WEBHOOK_REPLAY_WINDOW_SECS` (300 in V1), or reuse of an `event_id` with a different body hash. Every bounded-exponential-backoff retry preserves the exact request body and stable `event_id` but uses a fresh timestamp and signature. If the same `event_id` and body hash were already accepted, the receiver performs no duplicate side effect and returns the prior success-class 2xx response. This makes a retry after a lost 2xx idempotently successful; stale or invalid signatures still reject. A terminal delivery failure creates an operational incident and leaves the structured-console record intact.

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

### close-5m — Settlement Record preflight

- provider reachable;
- active Settlement Transport Version healthy;
- Nasdaq NOCP Close Method and provider finality/revision fields available;
- advisory independent-source cross-check.

### close+15m — final-record polling

Per ticker:

```text
update public transport if required
fetch atomically bound candidate Settlement Record
validate finality + Settlement Quality Predicate
```

### close+20m — earliest automatic Settlement

Permissionlessly finalize the canonical record and settle Outcome Markets in idempotent batches.

### close+25m — settlement-SLO incident

Alert if any Outcome Market remains unresolved. Continue normal evidence polling; close+25m is not an on-chain acceptance expiry.

### post-close

- aggressive EventHeap drain;
- venue cleanup attempts.

### Finalized-record correction monitor

Finalization starts, rather than ends, the correction-monitor lifecycle keyed by the permanent Settlement Record. For every FinalOracle or FinalManual ticker/day, automation monitors the primary provider for its entire provider-supported correction horizon, which must include at least the next NYSE Trading Day. The documented V1 cadence is every five minutes for the first two hours after finalization, hourly thereafter, explicit polls at the next Trading Day open and close, and one final poll at the provider horizon boundary. The versioned provider runbook records any stricter cadence and exact horizon-end rule.

Each fetch retains the raw response and canonical opaque revision bytes. For FinalOracle, the monitor compares the revision hash, source-record identity, raw digest, normalized Official Close, final/unadjusted flags, and halt/contingency status with the immutable result. For FinalManual, the finalized revision/raw hashes use the canonical all-zero baseline, and the monitor compares the subsequently available provider record with the stored manual Official Close and manifest digest. A difference creates or updates one idempotent operational incident:

```text
correction_incident_id = SHA256(
  "MERIDIAN_SETTLEMENT_CORRECTION_V1" ||
  borsh(settlement_record: Pubkey,
        finalized_provider_revision_hash: [u8; 32],
        finalized_raw_response_sha256: [u8; 32],
        observed_provider_revision_hash: [u8; 32],
        observed_raw_response_sha256: [u8; 32])
)
```

Retries with the same comparison key update one incident. It stores first/last observed times, fetch count, old/new normalized values and status, both revision hashes/raw digests, and retained-evidence locations. The indexer exposes it through the Settlement Record and `/incidents` APIs plus applicable Market/History projections. Monitoring and incidents never mutate the Settlement Record, an Outcome Market, Settlement, liability reconciliation, or payouts.

### >= close+1h

The offline Override Authority runbook may finalize the same canonical Settlement Record identity only when fixed-order Source A/Source B evidence, including SIP-consolidated Source A, agrees exactly after normalization and the ordered `manual_evidence_manifest_sha256` is recorded. On-chain finalization verifies the delay, submitted descriptors/status/equality, and manifest commitment; later `settle_market` calls derive each winner from the stored price and immutable Market Strike. HTTP/source authenticity remains explicit runbook/authority trust. The isolated devnet key is never loaded into automation, and non-demo use requires a multisignature Override Authority. Disagreement remains Settlement Disputed.

---

## 11. Indexer

### Inputs

- eligible SIP Live Underlying trade stream plus provider entitlement, real-time/delayed classification, source timestamp, and receive timestamp metadata.
- finalized Meridian Config and Outcome Market account subscriptions, with deployment-genesis transaction/account backfill and periodic finalized RPC reconciliation.
- Meridian Anchor events, including the stable global/market `PauseChanged` event.
- finalized canonical Settlement Record account subscriptions/backfill and protocol events.
- OpenBook events/logs.
- OpenBook Market, bids, asks, EventHeap.
- wallet OpenOrdersIndexer + listed OpenOrders accounts.
- finalized tracked Yes/No mint and token-account changes plus their transaction signatures, reconciled against wallet SPL balances.
- typed automation operational incidents for pre-issuance blackouts, later provider corrections, metadata availability, alert delivery failures, and other facts that have no on-chain instruction. Each incident has a stable idempotency key and is never presented as a protocol event.

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
GET /settlement-records/:ticker_id/:trading_day
GET /book/:outcome_market
WS  /book/:outcome_market
GET /history/:wallet
GET /positions/:wallet
GET /open-orders/:wallet
GET /crank-health
GET /incidents?type=&ticker_id=&trading_day=&outcome_market=
```

`outcome_market` is the Meridian Outcome Market PDA; the indexer resolves its one stored Venue Market. `/underlyings` returns only eligible SIP last trades together with provider/source/receive timestamps, entitlement metadata, redistribution permission/display disclaimer, real-time/delayed labels, and the 15-second freshness state; Live Underlying Price never affects Settlement. Settlement Record responses include correction-monitor lifecycle state, horizon/cadence, and incident IDs. `/crank-health` returns capacity, depth, percent full, oldest-event age, last consume signature/time, and SLO status. `/incidents` returns the stable incident key, type, lifecycle state, first/last observed times, revision/raw/evidence digests, affected identities, and the explicit `settlement_mutated=false` flag for correction annotations.

Markets and History expose each applicable operational incident's type, observed time, evidence digest, and immutable-settlement impact. These projections never masquerade as Meridian protocol events or mutate a finalized Settlement. Collateral Surplus is derived from finalized collateral-vault account state versus Collateral Liability rather than assuming a direct donation emitted a program event.

### P&L contract

Platform-execution P&L only.

- maintain a distinct paired-inventory bucket plus weighted-average unpaired basis per wallet, Outcome Market, and token side from finalized Meridian/Venue Market activity;
- `mint_pair` adds `q_atoms` to `paired_qty_atoms` with combined `paired_basis_atoms += q_atoms`; it does not arbitrarily allocate the one-USDC combined basis between Yes and No;
- source ordering is paired inventory first, weighted-average within that bucket, then the applicable unpaired side bucket;
- a Yes sale sourced from paired inventory unpairs the sold quantity, assigns its actual finalized Yes proceeds as the disposed Yes basis without fabricating realized sale P&L, and assigns the exact residual `q_atoms - actual_yes_proceeds_atoms` to the corresponding No atoms; partial fills apply this rule to the exact filled atoms;
- transfer-in -> unknown cost basis;
- transfer-out -> reduce qty at average cost; no fabricated realized P&L;
- Direct Holder Burn -> identify the finalized SPL burn signature, reduce quantity at average cost, label unsupported forfeiture/non-platform disposal, and record no fabricated proceeds;
- Buy Yes basis and Sell Yes proceeds use actual finalized USDC execution deltas;
- Buy No basis is the residual created by the paired-inventory Yes-sale rule: pair-mint USDC deposit minus actual Yes-sale proceeds;
- market-assisted Pair Redemption proceeds = redeemed USDC atoms - actual Yes acquisition cost;
- direct Pair Redemption consumes paired inventory first and closes its combined basis against the received USDC, then consumes unpaired sides and realizes received USDC minus their combined basis;
- at Settlement, any still-paired quantity assigns its full combined basis to the winning side and zero to the losing side before Outcome Redemption P&L;
- Outcome Redemption realizes payout minus the redeemed side's basis;
- unrealized P&L requires the current <=5-second two-sided Mark Price and is unknown otherwise;
- Internal Unwind is not external price discovery or a realized sale;
- wallet-paid SOL network costs, rent, priority fees, and EventHeap penalties are excluded;
- a transfer, direct holder burn, ingestion gap, or other unmatched change that makes the pairing association ambiguous marks the affected paired quantity and corresponding side basis unknown rather than guessing an allocation;
- unknown basis clearly badged.

Indexer is idempotent across duplicate logs, restart/backfill, and short chain reorgs. Finalized events deduplicate on `(transaction_signature, instruction_index, event_index)`; stable `PauseChanged` events are the canonical transition log while finalized Config/Outcome Market accounts are the state-reconciliation source. Provisional observations never enter user-visible History. It exposes History Completeness from the deployment genesis slot through the current finalized backfill cursor, including every known gap. Advisory P&L uses finalized activity only.

Tracked token-account changes without a matched finalized Meridian/OpenBook execution are classified from the finalized SPL instruction when possible: a Direct Holder Burn is labeled unsupported forfeiture/non-platform disposal, while other unexplained inflows make that side's basis unknown and outflows reduce quantity at weighted-average basis without fabricating realized proceeds.

---

## 12. Frontend

### Landing

Required:

- product explanation;
- timestamped Live Underlying Prices with fresh/stale/delayed labels;
- connect-wallet CTA;
- active market counts.

### Markets

supported-ticker grid (up to seven; blacked-out/suspended tickers remain visible with reasons) with:

- Live Underlying Price and timestamp;
- number of active strikes;
- nearest strikes;
- user-visible Market Phase: Preparing, Scheduled, Minting, Trading, Paused, Closed awaiting Settlement, Settlement delayed, Settled, Emergency expired, or Abandoned.

Every API and UI uses the same first-match precedence: Abandoned; Settled; Emergency expired; Settlement delayed when unresolved at/after close+25m; Closed awaiting Settlement at/after close; Paused before close; Preparing while Created; Scheduled while Active before mint-open; Minting from mint-open to trade-open; Trading from trade-open to close. Settlement Disputed is a separate evidence status shown with Settlement delayed, and post-close pause never hides settlement progress.

### Trade

Required elements:

- Outcome Market cards with ticker, Strike, Trading Day, Close Method, and Market Phase;
- executable Yes best bid/ask and **Mark Price only when both best quotes are present and no more than five seconds old**;
- mirrored No bid = `$1 - Yes ask` and No ask = `$1 - Yes bid`;
- **Implied Probability** from the Mark Price only, clearly labeled market-implied rather than forecast certainty;
- one-sided or older-than-five-second books suppress Mark Price and Implied Probability; any stale last trade is separately labeled context and never substitutes for an executable quote;
- one OpenBook ladder rendered as Yes view + mirrored No view;
- Buy Yes / Buy No / Sell Yes / Sell No controls;
- Market and PostOnly Limit modes where spec requires;
- Executable Depth, quantity, and explicit confirmation of Worst Execution Price or minimum proceeds; no hidden slippage default;
- `Protocol fee: 0` plus separately labeled estimates/disclosures for wallet-paid SOL operating costs;
- countdown to `close_ts`;
- exact payoff sentence: `A Yes Token pays 1.00 USDC if the Official Close is at or above [STRIKE].`;
- separate entry cost, maximum payout, and advisory Platform-execution P&L;
- state for "limit would cross — use Market";
- insufficient Executable Depth and EventHeap/backlog retriable error states;
- Recovery-only Mode when fresh authoritative Venue Market or Position State is unavailable;
- Settlement delayed/Disputed evidence status and immutable later-correction incident annotations.

### Directional Guardrail

Before enabling any new Directional Intent, compute the worst-case Exposure Interval across held tokens, Venue Market balances, and every resting/pending order:

```text
Flat Position      -> may open either side
Yes-sided Position -> may add/exit Yes; may not cross into No
No-sided Position  -> may add/exit No; may not cross into Yes
Mixed Position     -> new Directional Intents disabled; recovery guided
Unknown Position   -> Recovery-only Mode
```

Direct Pair Redemption is offered before or after Settlement whenever equal free Yes/No atoms exist. For Sell No, the normal UI must not knowingly match the user's own Yes ask: cancel the matching order, settle funds, and use direct Pair Redemption. Any race/adversarial self-cross is shown as an Internal Unwind rather than a trade.

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
- Settlement Record/Close Method and any incident annotation;
- Collateral Surplus as non-withdrawable protocol state, not wallet funds;
- Redeem buttons.

Post-close helper may compose:

```text
consume events if needed
cancel orders
settle_openbook_funds
redeem_pair when a Pair exists
redeem_outcome
```

If one transaction cannot fit, recovery/Redemption may be split; this does not violate the spec's trading one-approval requirement.

### History

Finalized execution and recovery log from deployment genesis with Outcome Market, Directional Intent, price, quantity, signature, timestamp, Internal Unwind label where applicable, and realized Platform-execution P&L only when basis is known. History Completeness and any gaps are always visible.

---

## 13. Testing Strategy

### 13.1 Strike engine

- META $680 -> `$620,$640,$660,$680,$700,$720,$740`.
- AAPL $230 -> `$210,$220,$230,$240,$250` after dedupe.
- half-up boundaries.
- default ATM inclusion and deduplication.
- deterministic ordering.
- duplicate elimination.
- Corporate Action Blackout for every disqualifying action; ordinary cash-dividend ex-date remains eligible.

### 13.2 Core Meridian program

- all instruction gates;
- `add_strike` unique/late/pause/config cases;
- mint at `mint_open_ts - 1`, exact open, `close_ts - 1`, exact close, Settled;
- collateral liability transitions;
- holder direct burns on either/both sides produce no payout; permissionless pre-/post-Settlement reconciliation uses the exact supply target, only decreases liability, transfers no funds, and emits `CollateralLiabilityReconciled` idempotently;
- `settle_market` selects the winning-supply target from its explicit PostSettlement phase while state is still Active, then marks Settled; a forced reconciliation failure rolls back outcome, liability, and state together;
- one-atom mint, Pair Redemption before/after Settlement, and Outcome Redemption with exact one-USDC-atom payout;
- donated Collateral Surplus cannot DoS and cannot be withdrawn;
- per-market snapshots vs config changes;
- canonical Settlement Record identity/shared consumption/first-valid-write;
- fixed-width account/golden digest vectors, including `[u8;64]` padding exclusion, domain separation, all enum/width/order boundaries (including `HaltOrContingencyStatus`), and `switchboard_job_hash` naming;
- atomic record stale delivery/wrong transport/wrong job hash/wrong ticker-day/wrong opaque revision hash/wrong Close Method/band/exact-sample/qualifying-trade cases, including anyone refreshing the same immutable identity/revision;
- Manual Settlement Override before/after delay, frozen source classes, two-source exact agreement, disagreement failure, ordered manifest/reason/evidence digest, authority-trust disclosure, FinalManual zero/common-field population, and derived at-or-above outcome;
- immutable late-correction incident behavior and indefinite Settlement Disputed path;
- halt with declared Official Close vs halt with no Official Close;
- metadata publication failure before account creation and content-hash validation;
- permanent ticker IDs, account schema versions, two-step role rotation, and Rent Refund Address pinning;
- pause/unpause;
- stable global/market `PauseChanged` event schema and account-state reconciliation;
- Meridian/PDA burns only through Redemption-family code paths; holder direct classic-SPL burns remain unsupported forfeiture.

### 13.3 OpenBook integration

#### Authorization

- `create_venue_market` succeeds only with the operator payer, derived `venue_market_authority`, pinned program, and exact creation fields;
- a directly created or otherwise matching market with the wrong market-authority PDA cannot attach;
- Meridian exposes no post-create wrapper that can sign as `venue_market_authority` or mutate the Market header;
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
- zero maker/taker fee header remains unchanged;
- wrapper ignores hostile self-trade/expiry/order-type client inputs.

#### Market paths

- Buy Yes full fill;
- Buy Yes insufficient liquidity -> whole rollback;
- Sell Yes full fill;
- Buy No mint + full Yes sale;
- Buy No partial -> mint + trade rollback;
- Sell No via `redeem_pair_via_market`;
- partial Sell No -> rollback;
- 99-cent Sell No succeeds with positive proceeds under zero fees;
- known own resting ask -> normal builder cancels/settles and directly redeems rather than knowingly self-crossing;
- race/adversarial own-order fill remains solvent and is indexed as Internal Unwind;
- wallet pays EventHeap penalty, collateral vault never pays lamports.

#### Liability reconciliation

- direct holder burn of Yes, No, and both sides produces no vault transfer;
- pre-Settlement reconciliation targets `max(yes_supply,no_supply)` and post-Settlement targets winning supply;
- target-above-current rejects; decreases and no-op retries are idempotent and evented;
- `settle_market` performs the same reconciliation and direct burns can create only ownerless, non-withdrawable surplus.

#### EventHeap

- fill with maker OOA in remaining accounts -> maker applied inline, no heap growth;
- >inline makers -> residual events enter heap;
- pre-consume + take transaction;
- keeper idempotency;
- saturation at 50/75/near-full thresholds;
- safe action fails closed if account/CU limit prevents mitigation.

#### Zero-fee venue

- Venue Market creation and attachment require exact zero maker/taker fees;
- the exact M0-proven unsignable fee-admin sentinel is required;
- every alternative fee-admin key and every nonzero fee rejects;
- supported maker/taker sessions leave OpenBook fee counters at zero;
- no Meridian fee configuration, ledger, collection, treasury, surplus-withdrawal, or fee-withdrawal instruction exists.

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
- reconcile atom-denominated Collateral Liability, supplies, zero-fee venue state, and Platform-execution P&L.

### 13.5 Frontend / Playwright

- wallet connect;
- Live Underlying Price timestamp/fresh/stale/delayed states;
- Markets 7-stock grid;
- executable Yes/No bid/ask, two-sided Mark Price, and absent/present Implied Probability states;
- payoff sentence;
- both orderbook perspectives;
- Buy/Sell Yes/No;
- crossing-limit warning;
- every Flat/Yes-sided/No-sided/Mixed/Unknown Exposure Interval boundary;
- Recovery-only Mode preserves direct-RPC recovery and suppresses stale/new Directional Intents;
- known own-order Sell No guides cancel/settle/direct Pair Redemption;
- first-use Buy-No-limit transaction composition;
- Portfolio Platform-execution P&L/unknown basis/Internal Unwind;
- History Completeness and gap display;
- signed-alert success, exact-byte mutation, timestamp replay, wrong key ID, lost-2xx retry returning idempotent success for the same body, same-ID/different-body rejection, and structured-console fallback;
- finalized Config/Outcome Market/Settlement Record subscription restart and deployment-genesis backfill;
- correction monitor cadence/horizon, opaque revision-hash deduplication, `/incidents` projection, and no-mutation guarantee;
- shared Settlement Record, Settlement delayed/Disputed, immutable correction annotation, and Redemption;
- every Market Phase, including paused orders-resume warning and Emergency expired.

---

## 14. Adversarial Test Suite

- ADV-01 direct maker order pre-open fails.
- ADV-02 direct taker order pre-open fails.
- ADV-03 maker/taker order while paused fails.
- ADV-04 stale resting order cannot be taken at/after close.
- ADV-05 wrong OpenBook `open_orders_admin` rejected by attach.
- ADV-06 wrong fee/close admin rejected.
- ADV-07 wrong expiry/lot/mint/vault rejected.
- ADV-08 arbitrary OpenBook account substitution in wrapper rejected.
- ADV-09 hostile order type / expiry / self-trade arg ignored; wrapper pins PostOnly/Abort/close expiry.
- ADV-10 crossing limit reverts, does not turn taker.
- ADV-11 partial `place_take_order` followed by Meridian exact-fill failure rolls back all state.
- ADV-12 EventHeap near-full: inline maker accounts prevent heap growth where possible.
- ADV-13 EventHeap pressure: pre-consume+take succeeds atomically.
- ADV-14 EventHeap mitigation cannot fit -> Market Action fails closed, no partial exposure.
- ADV-15 nonzero maker/taker fee or wrong fee-admin sentinel rejects during attach.
- ADV-16 supported sessions leave venue fee counters zero and no Meridian fee/treasury instruction exists.
- ADV-17 99-cent zero-fee Sell No remains below $1 cost and pays positive proceeds.
- ADV-18 unsignable fee-admin sentinel is proven against the pinned build.
- ADV-19 collateral vault cannot be penalty payer / lamport payer.
- ADV-20 normal Sell No cannot knowingly self-cross; a raced/adversarial occurrence remains solvent and is an Internal Unwind.
- ADV-21 mint before 09:00 rejected.
- ADV-22 mint at/after close rejected.
- ADV-23 mint on Settled rejected.
- ADV-24 unsolicited USDC creates locked Collateral Surplus without DoS or a withdrawal path.
- ADV-25 live Outcome Market terms/Settlement Transport Version unaffected by future config updates.
- ADV-26 attempt to mutate a transport version referenced by an unsettled Trading Day rejected.
- ADV-27 apparently fresh publication carrying a stale/different record identity or revision rejected.
- ADV-28 final-minute Strike crossing settles only from Nasdaq's final NOCP Settlement Record.
- ADV-29 permissionless record-finalization race accepts exactly one valid canonical record; all Outcome Markets consume it.
- ADV-30 override delay cannot be lowered for live Outcome Market.
- ADV-31 post-Settlement direct Pair Redemption succeeds; market-assisted Pair Redemption rejects.
- ADV-32 one-atom Pair and winning Outcome Redemption each transfer exactly one USDC atom.
- ADV-33 first-use Buy-No-limit fits one transaction or M0 explicitly fails compliance gate.
- ADV-34 permanent metadata upload/verification precedes `create_strike_market`; metadata CPI CU/bytes passes.
- ADV-35 remaining-account taker max-size CU/bytes.
- ADV-36 indexer duplicate/restart/backfill/reorg exposes accurate History Completeness and gaps.
- ADV-37 multi-user maker/taker/both-redeem lifecycle.
- ADV-38 intraday `add_strike` at close-30m-1s and exactly close-30m succeeds; close-30m+1s rejects, including early close.
- ADV-39 share-changing Corporate Action Blackout rejects creation; late discovery permanently pauses without replacing identity.
- ADV-40 pre-issuance halt abandons; post-issuance halt pauses; missing Official Close becomes Settlement Disputed.
- ADV-41 Manual Settlement Override exact two-source agreement succeeds; any disagreement fails closed.
- ADV-42 later provider correction annotates but cannot mutate Settlement or payout.
- ADV-43 Emergency Expiry is unavailable unless every M0 recovery test passes; when enabled it is irreversible and recovery remains live.
- ADV-44 wrong Rent Refund Address rejects and no closure can redirect rent to a current role/collateral address.
- ADV-45 every pinned post-attach OpenBook Market-header edit path rejects without its Meridian/unsignable authority or is an explicitly allowlisted close-PDA wrapper; each order wrapper detects any mutated safety field before CPI.
- ADV-46 mutated or unexpected deployment ALT contents reject before signing.
- ADV-47 direct holder burn pays nothing; reconciliation can only lower liability to the exact state-dependent supply target and cannot transfer ownerless surplus.
- ADV-48 wrong `venue_market_authority`, direct caller-selected creation field, or alternate creation authority rejects; no post-create market-header mutation wrapper exists.
- ADV-49 Settlement Record padding mutation does not affect semantic digests, while any committed fixed field/order/width/domain mutation does.
- ADV-50 replayed, stale-timestamp, wrong-key-id, or byte-mutated alert webhook fails verification; structured-console fallback and idempotent retry remain available.
- ADV-51 finalized correction-monitor restarts/polls deduplicate by revision-hash incident key and never mutate Settlement.
- ADV-52 maker `mint_pair` basis remains paired; partial/full Yes sales consume paired inventory first and assign exact residual No basis, direct Pair Redemption/Settlement close or reassign the combined basis deterministically, and ambiguous transfer/burn gaps produce Unknown rather than fabricated P&L.

---

## 15. M0 Hard Gates

M0 validation may begin from this candidate. M1 does not begin until every non-waiverable gate below is green and the signed go/no-go report is approved. Executable/license safety, order authorization, time/pause enforcement, rollback, collateral integrity, Sell-No solvency, lot math, zero fees, atomic Settlement Record correctness, recovery, and refund destinations cannot be waived. Only first-use Buy-No-limit's one-approval source requirement has the named product-compliance waiver.

### G1 — Deployed OpenBook pin / license-safe integration

- confirm devnet program ID;
- confirm official v1.7 release commit `796a470`;
- confirm official build SHA-256;
- inspect and publish the executable owner, derived ProgramData address, deployment slot, executable SHA-256, and upgrade authority; dump the devnet executable and verify against the official verifiable-build artifact/hash path;
- require Upgradeable Loader ownership; record the upgrade-authority state. Per ADR-0030 (the artifact executes only at its compiled-in canonical program ID, so an immutable re-deployment is impossible), the canonical deployment's retained external authority is accepted as a monitored fail-closed risk: any changed owner/ProgramData/slot/hash remains a non-waiverable failure that halts Meridian and reopens the architecture, and automation must alert on any authority or deployment-state change;
- pin Rust CPI + TS client revisions;
- confirm fallback adapter can be generated from MIT IDL/client/account layouts only.
- enumerate every pinned instruction capable of mutating Market admin, fee, expiry, oracle, lot, mint, vault, or authority fields and record its exact signer requirements.
- golden-test the `create_venue_market` CPI discriminator, account order, signer/writable flags, and every pinned creation argument; prove the derived `venue_market_authority` is the sole authority signer and that no Meridian post-create mutation wrapper exists.
- prove `initialize_config` and every OpenBook CPI compare the supplied read-only ProgramData account to the immutable Config identity; final-demo preflight repeats the owner/ProgramData/slot/authority/hash check before any mutation.

### G2 — PDA universal order gate

Prove against deployed/pinned build:

- direct maker order without PDA fails;
- direct `place_take_order` without PDA fails;
- Meridian CPI succeeds;
- no alternate order-creation instruction used by V1 bypasses the admin;
- enumerate every pinned Market-header mutation instruction and prove no permissionless or operator/service-key path can replace `open_orders_admin`, alter another safety field, or bypass the Meridian PDA.

### G3 — Exact time/pause/mint gates

- order pre-open rejected;
- order paused rejected;
- order exact close rejected;
- OpenBook expiry exact boundary proven;
- mint pre-09:00 rejected;
- mint exact close rejected;
- mint Settled rejected;
- cancel/consume/settle funds still work;
- global pause rejects Outcome Market creation, Add Strike, Venue Market creation/attachment/activation, minting, and every maker/taker path;
- global pause preserves cancellation, event consumption, fund settlement, direct Pair Redemption, liability reconciliation, Settlement Record finalization, Outcome Market Settlement, and Outcome Redemption;
- resting orders survive pause and cannot fill again until explicit safe unpause;
- both `create_strike_market` and `add_strike` succeed at `close_ts - 1801` and `close_ts - 1800`, then reject at `close_ts - 1799` for the current Trading Day, including early closes;
- transport resolution keeps same-day Add Strike on current before a pending activation day, selects pending on the activation day, and promotes an already-effective pending version before another future schedule is installed;
- Created and attached-Active Markets can become Abandoned only while the monotonic `activity_started` flag is false and every liability/supply/order/EventHeap/balance is empty; first mint or successful order authorization makes abandonment permanently unavailable;
- the terminal Market tombstone prevents identity recreation.

Prove the complete Emergency Expiry recovery path. Expose the one-way fuse only if paused/pre-close authorization, immutable reason, cancellation, event consumption, fund settlement, Pair Redemption, Settlement, and Outcome Redemption all pass; otherwise remove it from V1.

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
- exact `q_atoms` Yes acquired;
- vault delta / liability delta invariant;
- 99-cent zero-fee corner;
- normal builder cannot knowingly self-cross and chooses cancel/settle/direct Pair Redemption;
- raced/adversarial self-cross remains solvent and is classified as Internal Unwind;
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

Keeper throughput must be at least twice the measured worst-case event generation rate. Calibrate tighter SLO thresholds from evidence; no product path may rely on unmeasured "keeper should be fast enough."

### G7 — Transaction feasibility / one-approval gate

Measure serialized bytes, ALTs, account count, CU, wallet simulation for:

1. **first-use Buy-No-limit**: with both outcome ATAs absent and a funded quote ATA present, OOI + OOA creation + `mint_pair` (including canonical Yes/No ATA initialization) + PostOnly order — **hard spec gate**;
2. first-use Buy-Yes-limit;
3. `redeem_pair_via_market` with max remaining maker accounts;
4. pre-consume + `take_full` with remaining maker accounts;
5. post-close cancel + settle + redeem helper;
6. batched settlement transaction;
7. first ticker/day `create_strike_market`, including Pending SettlementRecord initialization and two Metaplex metadata CPIs;
8. later-Strike `create_strike_market`, including exact existing-header match and two Metaplex metadata CPIs;
9. `create_venue_market` with the operator funding every required OpenBook account and the PDA signing the pinned creation CPI;
10. full intraday Add Strike create/`create_venue_market`/attach sequence.

If first-use Buy-No-limit cannot fit one approval, stop and request explicit stakeholder deviation. Do not silently pre-create accounts and claim compliance.

The deployment ALT's exact expected contents are published and checked by clients; it contains only stable program IDs, required sysvars, Config PDA, and pinned quote mint. All per-day/per-user addresses remain inline, and G7 must pass with that exact split. After the stable set passes M0, remove ALT authority and prove mutation is impossible.

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
- one permanent Pending/Final Settlement Record per eligible ticker and Trading Day (up to seven per day).
- the exact 64 reserved padding bytes in each Config, Settlement Transport Version, Settlement Record, and Outcome Market allocation.

Budget:

- 49 Outcome Markets/day plus up to seven permanent Settlement Records/day;
- five trading days;
- 20% funding reserve;
- best-case reclaimed vs worst-case locked rent;
- exact Rent Refund Address for every supported close path.

Every M0-supported venue prune/close wrapper must pin its accounts, sign only through the venue-close PDA, and return recoverable operator-funded rent only to the snapshotted destination. Unsupported close paths remain unavailable and count as locked rent.

The `create_venue_market` budget uses the operator as payer for every OpenBook Market/book/EventHeap/vault allocation and records no collateral-vault lamport path.

### G9 — Zero-fee venue enforcement

- prove the required fee-admin public key can use the exact unsignable sentinel on the pinned build;
- reject every alternative sentinel/admin and every nonzero maker/taker fee;
- prove every post-attach edit path for fee/admin/oracle/expiry/lot fields rejects without an unsignable or narrowly allowlisted Meridian PDA authority, and per-order revalidation fails closed on any changed field;
- run maker and Market Action sessions and assert all venue fee counters remain zero;
- prove the Meridian IDL contains no fee configuration, fee admin, treasury, collection, surplus withdrawal, or protocol-fee withdrawal instruction.
- prove `attach_venue` requires the exact derived market-authority PDA and that no post-create Meridian wrapper can mutate fee/admin/oracle/expiry/lot fields.

### G10 — Lot/price/order semantics

Prove with golden vectors:

- one whole Yes Token == one base lot;
- 1 price lot == 1 cent;
- price 1..99 maps $0.01..$0.99;
- PostOnly crossing behavior + returned order ID semantics;
- per-order expiry boundary;
- self-trade field serialization pinned to `AbortTransaction` for limit wrapper.

### G11 — Atomic Settlement Record / real oracle proof

Run `make oracle-e2e-devnet` and prove:

- provider calibration captures the Massive SIP unadjusted candidate record first and a paid Alpaca SIP raw-response cross-check at close+5m, +10m, +15m, and the next Trading Day, retaining every raw-response digest and observed revision;
- Nasdaq NOCP under the recorded Close Method, not a provider daily bar;
- one atomically bound immutable record contains ticker, Trading Day, Official Close, observation/publication times, provider revision, Close Method/status, record identity, and raw-response digest;
- each Settlement Transport Version publishes the Switchboard executable owner, program ID, derived ProgramData, deployment slot, executable SHA-256, and upgrade authority; normal finalization read-locks and validates the exact ProgramData/slot/authority, and wrong owner/address/slot/authority vectors reject;
- a post-registration Switchboard upgrade makes the old Pending version fail closed and use the delayed Manual path; only a newly registered version may select the new executable identity for a future Trading Day;
- fixed-width Header/Result Borsh commitments match golden vectors, exclude the 64 padding bytes, and enforce zero in every state-inapplicable result field;
- first Outcome Market creation initializes the canonical Pending header, later Strikes with any header mismatch reject, and a permissionless caller cannot substitute another registered transport version;
- one canonical PDA is shared by all Outcome Markets for the tuple and the first valid permissionless submission wins;
- normal result finalization may occur before +20m, but `settle_market` rejects at close+20m-1s and succeeds at exact close+20m and +1s using the immutable 1200-second devnet snapshot; future config cannot lower a live header;
- stale/latest-value laundering, wrong revisions, and separate price/time records reject;
- normal and manual timestamp-order predicates reject each boundary at -1 second and accept equality/+1 as applicable; neither path can finalize before `close_ts`, and future-dated provider observations reject;
- `max_stale_slots` checks delivery-update slot at submission; permissionless redelivery of the same identity/revision/raw digest succeeds while any changed bound field fails;
- V1 `max_sample_spread_bps=0` accepts only exact normalized sample equality and records actual delivery slot/sample count/spread;
- Config rejects quality parameters outside the compile-time sample/stale/band bounds; G11 publishes the signed selected values before M1, and checked-`u128` inclusive price-band vectors cover below/exact/above and overflow boundaries;
- provider finality and later-correction behavior match ADR-0012/0021/0023;
- missing Official Close produces Settlement Disputed;
- delayed manual source A/B exact-agreement/disagreement, reason/manifest digest, FinalManual population/zeroing, and explicit Override Authority HTTP-trust behavior pass.

Synthetic evidence cannot satisfy G11.

### G12 — Deployment identities, metadata, quote, and recovery

Prove:

- permanent ticker discriminants, schema versions, reserved padding, and golden PDA vectors;
- pinned Circle Devnet USDC owner/program/six decimals;
- each canonical Yes/No JSON and image digest, URI hash, and ordered `MERIDIAN_METADATA_V1` manifest root is verified through two gateways before mint creation; on-chain creation re-derives the root and validates immutable Metaplex accounts without claiming network access;
- two-step role rotation and published devnet upgrade trust;
- exact Squads V4 program/audited-commit/executable-hash and `@sqds/multisig@2.1.4` lockfile pin; devnet genesis hash and every SDK call's explicit program ID fail closed on mismatch;
- two independent derivations produce the published autonomous multisig and vault-index-0 PDA; finalized account state proves three members, threshold two, all-member Initiate/Vote/Execute permissions, null Config Authority, and zero devnet-only timelock;
- one approval cannot execute a loader fixture and two approvals can; the vault PDA, not a member or multisig account, satisfies the loader signer; a direct member also fails an isolated Meridian Override Authority fixture while a two-approved vault CPI succeeds;
- final-demo acceptance rejects a single upgrade key and proves the actual Meridian ProgramData authority is the published vault PDA after the hash-verified M6 upgrade flow;
- every account-close and Emergency Expiry recovery path uses only its snapshotted Rent Refund Address and preserves collateral/Redemption.

---

## 16. Devnet and Demo Strategy

### `make demo` — deterministic localnet smoke test

- local validator;
- pinned OpenBook clone/build;
- canonical synthetic Settlement Record fixture;
- two wallets;
- complete publish-fixture -> create -> mint -> trade -> finalize record -> settle -> redeem;
- exits zero only after exact Collateral Liability/supply/venue-state reconciliation.

### `make demo-devnet` — deterministic public-HTTPS devnet demo

- deployed Meridian devnet;
- deployed OpenBook v1.7;
- real Switchboard On-Demand transport accounts carrying a clearly labeled synthetic Settlement Record;
- pinned Circle Devnet USDC;
- two funded action wallets plus separately funded maker wallets;
- `DEMO_SOURCE_URL` must be public HTTPS and return the committed synthetic fixture bytes/digest.

Reject:

```text
localhost
127.0.0.0/8
RFC1918
.local
LAN-only hostnames
```

The command preflights program IDs/hashes, quote mint, ALT contents, public source digest, wallet balances, and all required accounts; it fails before mutation if a prerequisite is absent. Synthetic evidence demonstrates plumbing only and cannot satisfy Settlement correctness, provider finality, or production-readiness claims.

Required devnet demo includes:

- permanent metadata publication verification and one Outcome Market creation;
- `DEMO_ORDER_Q=1` whole token and at least two whole tokens of executable bid depth plus two whole tokens of executable ask depth, seeded by maker wallets distinct from the action wallets;
- PostOnly quote;
- Buy Yes;
- Buy No;
- Sell Yes;
- Sell No through `redeem_pair_via_market` and its OpenBook CPI path;
- maker event consumption;
- a separate insufficient-depth Market Action that proves whole-transaction rollback;
- shared synthetic Settlement Record finalization and Settlement;
- both-wallet redemption;
- exact accounting/supply/zero-fee reconciliation.

### `make oracle-e2e-devnet` — real Official Close M0 proof

Execute with an explicit completed eligible Trading Day:

```text
make oracle-e2e-devnet TICKER=META TRADING_DAY=YYYY-MM-DD
```

The command uses the real provider + Switchboard path and must prove Nasdaq NOCP, Close Method, atomic record binding, finality/revision, shared permissionless finalization, stale-value resistance, and correction/dispute behavior. It rejects synthetic data and exits nonzero on any G11 failure.

From a clean clone, `.env.example` is copied/configured once; each command above is otherwise non-interactive and exits nonzero on unmet acceptance criteria. The root `README.md` is an M6 artifact and must state prerequisites, `.env.example` setup, `make dev`, `make demo-devnet`, `make oracle-e2e-devnet`, the synthetic-versus-real evidence distinction, devnet-only scope, and risk/limitation boundaries. A clean-clone reviewer follows only that README and all three commands must pass. Solana execution and collateral remain devnet/test-value only. Production Arweave uploads and paid market-data access are accepted ancillary integration costs, budgeted separately from protocol funds; they do not authorize mainnet deployment or real trading funds.

---

## 17. Milestones

**Capacity assumption:** one senior engineer, full-time, AI-assisted.  
**Estimate:** **18–22 working days**, assuming M0 passes without architectural revision.

| Milestone | Days | Scope | Exit gate |
|---|---:|---|---|
| **M0** | D1–4 | G1–G12: venue pin/CPI, zero-fee sentinel, rollback, Sell-No, EventHeap, one-approval/ALT, rent/refunds, lot math, real atomic Settlement Record, identities/metadata/quote/recovery | signed go/no-go; every non-waiverable gate green |
| **M1** | D5–7 | versioned Config/roles/transport; frozen Outcome Market + Settlement Record accounts/digests; create/add-strike; permanent metadata; atom liability/reconciliation; Redemption; stable pause events | program + strike + Settlement Record core green |
| **M2** | D8–11 | PDA-authorized `create_venue_market`/attach; PostOnly limit wrapper; take-full; market-assisted Pair Redemption; OpenOrders discovery; EventHeap keeper | localnet full four-path + multi-user green |
| **M3** | D12–14 | provider/transport integration; NYSE + corporate-action/symbol-status automation; Settlement/override/dispute/correction runbooks; signed alert delivery | `make oracle-e2e-devnet` + oracle/automation ADV green |
| **M4** | D15–17 | 5 `frontend/` pages; Market Phases; Directional Guardrail; Recovery-only Mode; first-use OO UX; Live Underlying Price | Playwright green |
| **M5** | D18–19.5 | finalized account/event/SIP indexer inputs, ladder WS, History, P&L, crank health, incidents API | scripted accounting/P&L + restart/backfill/incident sequence green |
| **M6** | D20–22 | deterministic devnet E2E, oracle proof rerun, cleanup, root README, risk note, final traceability audit, 2-of-3 upgrade-authority transfer | README-guided clean-clone `make dev`, `make demo-devnet`, and `make oracle-e2e-devnet` succeed, and on-chain upgrade authority is verified as the required 2-of-3 multisig |

### Non-compliant deviations

The only named product-compliance waiver is two approvals for first-use Buy-No-limit if G7 proves one approval impossible. It requires explicit stakeholder acceptance and must be labeled non-compliant. Safety gates are never waiverable. Any other reduction in source scope requires a new PRD/ADR revision rather than an implicit deviation.

---

## 18. Risk Register

| Risk | L | I | Mitigation |
|---|---|---|---|
| EventHeap backlog blocks/raises cost of exits near close | M | H | inline maker accounts, pre-consume, numeric keeper SLO, fail-closed path, G6/G7 |
| First-use Buy-No-limit exceeds tx limits | M | H | v0+ALT + hard G7; stakeholder waiver required if impossible |
| Venue created with a fee/admin backdoor | L | H | PDA-only pinned creation wrapper, zero maker/taker fees + unsignable sentinel, exact-authority attach rejection, no mutation wrapper, G1/G9 |
| OpenBook large-account rent | H | M | G8; cleanup; devnet funding model |
| Deployed/client revision mismatch | L | H | G1 program/release/build verification |
| CPI adapter accidentally derives GPL implementation | L | M | MIT IDL/client-only fallback rule + review |
| `redeem_pair_via_market` vault spend bug | L | H | account pinning, exact atom deltas, zero fee, rollback, G5 |
| Economic self-cross in Sell No surprises user | M | L | normal builder cancel/settle/direct Pair Redemption; raced occurrence labeled Internal Unwind |
| OpenBook EventHeap penalty surprises user | M | L | disclose small SOL penalty possibility; inline makers minimize; wallet pays |
| Provider unavailable or evidence disagrees | M | H | preflight, normal polling, exact two-source override; Settlement Disputed rather than fabricated result |
| Atomic binding/finality cannot be proven | M | H | non-waiverable G11 before M1; reopen transport/provider design |
| stale observation laundered by fresh publication | L | H | record identity/revision/raw digest + atomic quality predicate |
| later Official Close correction | L/M | H | immutable payout; visible incident annotation and explicit as-of limitation |
| live Outcome Market changed by admin | L | H | explicit snapshots + future-Trading-Day config |
| DST/holiday/early-close error | M | H | NYSE authority + Alpaca cache checked against fixtures |
| late-discovered corporate action | L | H | two-source blackout; permanently pause new activity, preserve recovery, settle literal terms if Official Close exists |
| halt ends with no Official Close | L/M | H | pause/recovery + Settlement Disputed; never substitute an unofficial price |
| metadata becomes unavailable despite immutable URI | L | M | production Arweave first, two-gateway byte verification, content hashes; pinned-IPFS fallback only |
| stale/partial indexed Position State permits conflicting intent | M | H | worst-case Exposure Interval; Unknown/Mixed fail closed; Recovery-only Mode |
| direct classic-SPL burn desynchronizes cached liability | M | M | no payout on burn; permissionless supply-based monotonic reconciliation; ownerless surplus |
| unsigned/replayed alert spoofing | M | H | exact-body HMAC, timestamp/key-id headers, 300-second replay window, stable alert IDs, structured-console fallback |
| upgrade authority compromises devnet proof | L | H | published key/program-data/hash/slot; mandatory 2-of-3 transfer and verification before final-demo acceptance; multisig required outside demo |
| regulatory/legal | — | — | devnet only; neutral risk note; no compliance claims |

---

## 19. Decision Status and Deployment Inputs

The V1 product decision frontier is empty. ADRs 0001–0028 and `CONTEXT.md` settle the former Q1, fees, ATM default, metadata, Settlement, lifecycle, guardrail, self-cross, corporate-action, halt, recovery, and demo branches.

The remaining values are validation or deployment inputs, not open product decisions:

1. real Official Close provider/transport selection must pass G11 without weakening the Settlement Record contract;
2. the actual receiver/on-call owner behind the fixed signed `ALERT_WEBHOOK_URL` contract must be selected before unattended operation;
3. the three published M6 Squads member pubkeys/custody owners plus create-key, multisig, and independently derived vault addresses are deployment inputs under the frozen program/configuration contract;
4. the one-approval Buy-No-limit waiver is considered only if G7 proves the compliant path impossible.

---

## 20. Requirements Traceability Matrix

| Source requirement | v0.7 mechanism / accepted clarification | Acceptance evidence |
|---|---|---|
| Solana chain fast enough for real-time on-chain CLOB | Solana + OpenBook V2 | M0 latency / local+devnet lifecycle |
| 7 MAG7 tickers | permanent IDs + strike job; explicit Corporate Action Blackout / halt exception | automation tests / Markets UI / ADV-39/40 |
| ±3/6/9 Strikes, nearest $10, dedupe, and ATM | §6; rounded prior-close ATM enabled by default | META/AAPL verbatim vectors |
| Add Strike intraday | `add_strike` until close-30m, including early closes | ADV-38 |
| contracts/order books before open | 08:30 create + attach | lifecycle E2E |
| minting starts 09:00 | ID-013 + I9 | mint boundary tests |
| trading starts 09:30 | trade PDA wrapper | direct pre-open ADV |
| pause minting + trading | mint + order gates | pause tests |
| no trading after close | wrapper + OpenBook expiry | close boundary tests |
| $1 collateral invariant | atom-denominated Collateral Liability / I1 | fuzz + reconciliation |
| Yes+No payout=$1 | I2 | exhaustive settle tests |
| creation only via mint pair | I3 | authority/path tests |
| destruction only via Redemption | Meridian/PDA burns only through Redemption; classic-SPL holder burn is unsupported forfeiture with supply-based liability reconciliation | I1/I3/I7a + ADV-47 |
| settlement immutable | I4 | race/write-once tests |
| one Yes/USDC book per strike | PDA-authorized `create_venue_market` + exact-authority attach, ID-002 | G1/G7/G8/G9 + attach validation |
| Buy Yes market | take_full Bid | integration |
| Buy Yes limit | PostOnly Bid | integration |
| Buy No market atomic / one approval | mint + take_full one tx | rollback + tx builder |
| Buy No limit atomic / one approval | OOI+OOA+mint+PostOnly ask | **G7 hard gate** |
| Sell Yes market/limit | take_full Ask / PostOnly Ask | integration |
| Sell No automatic close | `redeem_pair_via_market` | G5 / integration |
| position-aware constraint | worst-case Exposure Interval Directional Guardrail, ADR-0009/0019 | Playwright state matrix |
| oracle on-chain Settlement read | one shared atomic Settlement Record, ADR-0012/0021/0023 | G11 + `make oracle-e2e-devnet` |
| staleness/quality | delivery-slot freshness + immutable identity/revision hash/raw digest + exact-equality sample predicate | ADV oracle suite / G11 |
| previous close off-chain allowed | prior Official Close strike job + Corporate Action Blackout | automation test |
| retry after provider failure | polling begins +15m and continues after the +25m incident | job/runbook test |
| source 10-minute Settlement target | accepted devnet finality policy: earliest +20m, incident +25m; correctness outranks latency | ADR-0012 + G11 finality evidence |
| override >=1h | snapshot + compile-time floor; equal normalized values and manifest digest enforced on-chain, HTTP authenticity explicitly trusted to offline authority/runbook | ADV-30/41 + G11 |
| indefinite redemption | no protocol Redemption deadline; atom-level recovery while deployment remains available | E2E |
| no KYC | no identity/KYC dependency, account, API, or route; wallet-only protocol access | dependency/config/route scan |
| no margin/leverage | no lending/borrow CPI or liability path; fully collateralized Pair minting only | IDL/CPI/dependency scan + collateral invariants |
| Landing live prices | timestamped Live Underlying Price, 15s stale threshold, entitlement label | Playwright |
| Markets 7-stock live grid | §12 Markets | Playwright |
| Outcome Market cards / implied probability / implied No | fresh executable bid/ask + two-sided Mark Price rules | component+Playwright |
| both book perspectives | mirrored ladder | Playwright |
| payoff sentence | exact at-or-above payout copy + separate entry cost | Playwright snapshot |
| Portfolio entry/mark/P&L/redeem | §12 Portfolio + indexer | Playwright/scripted sequence |
| History execution log | genesis backfill + visible History Completeness | test |
| multi-user maker/taker/both redeem | §13.4 | integration/ADV-37 |
| devnet full lifecycle | deterministic `make demo-devnet`; real Official Close proof separated | clean-clone demo + `make oracle-e2e-devnet ...` |
| secrets via env | Appendix C | repo review |
| risks/limitations | §18 + README | final doc audit |

---

## Appendix A — User Intent to Transaction Composition

| Intent | Mode | Composition | Notes |
|---|---|---|---|
| Buy Yes | Market | `[consume? , meridian.take_full(Bid)]` | full-fill or rollback |
| Buy Yes | Limit | `[OO setup if needed, meridian.place_limit_order(PostOnly Bid)]` | no crossing; zero protocol fee |
| Buy No | Market | `[meridian.mint_pair, consume?, meridian.take_full(Ask)]` | one approval; `q_atoms` temporary USDC funding |
| Buy No | Limit | `[OOI?, OOA?, meridian.mint_pair(init_if_needed Yes/No ATAs), meridian.place_limit_order(PostOnly Ask @ 100-No)]` | **first-use one-approval G7; funded quote ATA prerequisite only** |
| Sell Yes | Market | `[consume?, meridian.take_full(Ask)]` | directional trading; paused when market paused |
| Sell Yes | Limit | `[meridian.place_limit_order(PostOnly Ask)]` | directional trading |
| Sell No | Market | `[cancel/settle own match?, direct redeem_pair OR consume?, meridian.redeem_pair_via_market]` | normal builder never knowingly self-crosses; full-fill or rollback |
| Sell No | Limit | Not V1 | no claim |
| Pair unwind | before/after Settlement | `[meridian.redeem_pair]` | atom-level recovery, not directional trade |
| Cancel | any state | direct OpenBook cancel | recovery |
| Settle OO funds | any state | `[meridian.settle_openbook_funds]` | recovery |
| Finalize Settlement Record | post-close | `[meridian.finalize_settlement_record]` | permissionless, one canonical record per ticker/Trading Day |
| Manual Settlement Record | after delay | `[meridian.finalize_manual_settlement_record]` | Override Authority + exact two-source evidence agreement |
| Outcome redeem | post-Settlement | `[meridian.redeem_outcome]` | atom-level; no protocol deadline |

---

## Appendix B — Repository Layout

```text
meridian/
├─ programs/
│  └─ meridian/
│     ├─ src/
│     │  ├─ lib.rs
│     │  ├─ constants.rs
│     │  ├─ error.rs
│     │  ├─ events.rs
│     │  ├─ state/
│     │  │  ├─ config.rs
│     │  │  ├─ feed_version.rs
│     │  │  ├─ settlement_record.rs
│     │  │  └─ market.rs
│     │  ├─ instructions/
│     │  │  ├─ admin/
│     │  │  ├─ market/
│     │  │  ├─ trading/
│     │  │  └─ settlement/
│     │  ├─ openbook/
│     │  │  ├─ cpi.rs
│     │  │  ├─ validation.rs
│     │  │  └─ math.rs
│     │  └─ settlement/
│     │     ├─ verifier.rs
│     │     └─ quality.rs
│     └─ Cargo.toml
│
├─ packages/
│  ├─ common/
│  ├─ meridian-client/          # generated/Codama Umi client
│  └─ openbook-adapter/
│
├─ services/
│  ├─ automation/
│  │  ├─ src/jobs/
│  │  ├─ src/keeper/
│  │  ├─ src/calendar/
│  │  ├─ src/settlement/correction-monitor/
│  │  └─ src/alerts/
│  ├─ indexer/
│  │  ├─ src/ingest/
│  │  ├─ src/projections/
│  │  ├─ src/api/
│  │  └─ migrations/
│  └─ demo-source/              # labeled public-HTTPS synthetic record source
│
├─ frontend/
│  ├─ app/
│  ├─ components/
│  ├─ domain/
│  ├─ data/
│  └─ transactions/
│
├─ scripts/
│  ├─ deploy/
│  ├─ openbook/
│  ├─ feeds/
│  ├─ multisig/
│  └─ demo/
│
├─ tests/
│  ├─ strike-engine/
│  ├─ program/
│  ├─ openbook-integration/
│  ├─ adversarial/
│  ├─ oracle/
│  ├─ devnet/
│  └─ playwright/
│
├─ docs/
│  ├─ adr/
│  ├─ runbooks/
│  ├─ PRD.md
│  ├─ ARCHITECTURE.md
│  └─ REQUIREMENTS.md
│
├─ README.md
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
OPENBOOK_EXECUTABLE_SHA256=
OPENBOOK_PROGRAMDATA_ADDRESS=
OPENBOOK_DEPLOYMENT_SLOT=
OPENBOOK_UPGRADE_AUTHORITY=none

# Published by G11 and frozen into each Settlement Transport Version.
SWITCHBOARD_PROGRAM_ID=
SWITCHBOARD_PROGRAMDATA_ADDRESS=
SWITCHBOARD_DEPLOYMENT_SLOT=
SWITCHBOARD_EXECUTABLE_SHA256=
SWITCHBOARD_UPGRADE_AUTHORITY=

# Secret-mounted paths outside the repository.
OPERATOR_KEYPAIR_PATH=/run/secrets/meridian/operator.json

# Offline deploy/runbook shells only; never injected into automation/frontend.
GOVERNANCE_KEYPAIR_PATH=/secure/offline/meridian/governance.json
PAUSE_AUTHORITY_KEYPAIR_PATH=/secure/offline/meridian/pause.json
OVERRIDE_AUTHORITY_KEYPAIR_PATH=/secure/offline/meridian/override.json
UPGRADE_AUTHORITY_KEYPAIR_PATH=/secure/offline/meridian/upgrade.json

# Public M6 Squads V4 deployment manifest; no private key material.
SOLANA_DEVNET_GENESIS_HASH=
SQUADS_V4_PROGRAM_ID=SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
SQUADS_V4_AUDITED_COMMIT=64af7330413d5c85cbbccfd8c27a05d45b6e666f
SQUADS_V4_SDK_VERSION=2.1.4
UPGRADE_MULTISIG_CREATE_KEY=
UPGRADE_MULTISIG_PUBKEY=
UPGRADE_MULTISIG_VAULT_PUBKEY=
UPGRADE_MULTISIG_MEMBER_1=
UPGRADE_MULTISIG_MEMBER_2=
UPGRADE_MULTISIG_MEMBER_3=
UPGRADE_MULTISIG_THRESHOLD=2
UPGRADE_MULTISIG_CONFIG_AUTHORITY=null
UPGRADE_MULTISIG_VAULT_INDEX=0
UPGRADE_MULTISIG_TIMELOCK_SECS=0

QUOTE_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
MASSIVE_SIP_API_KEY=
ALPACA_API_KEY=
ALPACA_API_SECRET=
LIVE_UNDERLYING_SOURCE=alpaca_sip
LIVE_UNDERLYING_ENTITLEMENT=real_time
CORPORATE_ACTION_SOURCE_A_API_KEY=
CORPORATE_ACTION_SOURCE_B_API_KEY=
ARWEAVE_UPLOADER_KEY_PATH=/run/secrets/meridian/arweave.json
METADATA_GATEWAY_A_URL=
METADATA_GATEWAY_B_URL=
ALERT_WEBHOOK_URL=
ALERT_WEBHOOK_KEY_ID=
ALERT_WEBHOOK_HMAC_SECRET_PATH=/run/secrets/meridian/alert-webhook-hmac
ALERT_WEBHOOK_REPLAY_WINDOW_SECS=300
DEPLOYMENT_ALT_ADDRESS=
DEPLOYMENT_ALT_CONTENTS_SHA256=

# Public HTTPS only when used on devnet.
DEMO_SOURCE_URL=
DEMO_SOURCE_SHA256=

# Keeper thresholds are calibrated by G6; defaults are upper safety bounds.
HEAP_WARN_PERCENT=50
HEAP_CRITICAL_PERCENT=75
HEAP_NORMAL_MAX_AGE_MS=5000
HEAP_CLOSE_MAX_AGE_MS=2000
```

The real `.env`, `keys/`, and all secret mounts are gitignored. Automation receives only `OPERATOR_KEYPAIR_PATH` plus non-authority API/storage credentials and the alert HMAC secret mount; governance, Pause Authority, Override Authority, and upgrade-key variables are consumed only by offline deployment or runbook commands. `LIVE_UNDERLYING_ENTITLEMENT` is `real_time` or `delayed` and controls labeling, never protocol behavior. The final devnet-demo acceptance script verifies the deployed program's upgrade authority is the designated 2-of-3 multisig rather than the earlier cold single key.

---

## Appendix D — M0 OpenBook Evidence File

M0 must create `docs/adr/openbook-v2-pin.md` containing exact pinned-source evidence for:

- deployed program ID/tag/commit/build hash;
- license boundary (`client`/`cpi` MIT path);
- Market admin fields;
- expiry predicate;
- `place_order` admin signer;
- `place_take_order` admin signer and immediate transfer;
- required `collect_fee_admin` field and the exact M0-proven unsignable sentinel;
- exact zero maker/taker fee encoding and rejection of alternatives;
- SelfTradeBehavior enum;
- PostOnly semantics;
- remaining-account inline fill limit;
- EventHeap penalty and penalty payer;
- `consume_events` authority;
- `set_market_expired` / prune / close authority;
- close-market preconditions;
- every close instruction's recipient and Rent Refund Address behavior;
- lot/tick math;
- market/book/EventHeap sizes and rent.

Every golden test must name the pinned evidence item it protects.

---

## Appendix E — Source Set Used for v0.7 Reconciliation

Product requirements and accepted decisions:

- `docs/REQUIREMENTS.md`, converted from the source PDF;
- `CONTEXT.md`;
- `docs/adr/0001-*.md` through `docs/adr/0028-*.md`.

Primary OpenBook sources to be re-verified by M0:

- official `openbook-dex/openbook-v2` repository README / deployed versions;
- official GitHub v1.7 release metadata;
- `idl/openbook_v2.json`;
- `programs/openbook-v2/src/state/market.rs`;
- `programs/openbook-v2/src/state/orderbook/book.rs`;
- `programs/openbook-v2/src/instructions/place_take_order.rs`;
- `programs/openbook-v2/src/accounts_ix/place_take_order.rs`;
- `programs/openbook-v2/src/instructions/settle_funds.rs`;
- `programs/openbook-v2/src/accounts_ix/settle_funds.rs`.

The source PDF, represented in-repo by `docs/REQUIREMENTS.md`, remains the upstream authority for Meridian product requirements. Accepted clarifications and explicit deviations are recorded in `CONTEXT.md` and ADRs 0001–0028.
