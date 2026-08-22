# System Patterns

Use `CONTEXT.md` vocabulary. `docs/PRD.md` v0.7.1 and `docs/ARCHITECTURE.md` v1.1.1 are reconciled with ADR-0001 through ADR-0033.

## System shape

```text
User wallet → Next.js frontend → Solana RPC
Automation (operator key only)     → Solana RPC
Governance / pause / override      → Solana RPC

RPC → Meridian ──CPI──► OpenBook V2 v1.7
            ──CPI──► SPL Token / ATA / Metaplex
            ──read─► owner-pinned delivery account (localnet: harness mock feed | Pyth adapter delivery PDA; devnet: Pyth adapter)
            ──finalize/consume─► SettlementRecord PDA

Indexer (read-only) ← accounts/logs
Frontend ← REST ← Indexer
```

Write path is on-chain. Read path is indexer projections. Indexer never holds protocol keys. Localnet admin routes are a demo exception: they sign with `.demo-config.json` role keys.

## Component boundaries (intended vs actual)

| Component | Does | Must not | Actual (2026-08-22) |
| --- | --- | --- | --- |
| `programs/meridian` | Config, transport versions, Settlement Records, Outcome Market lifecycle, collateral, mint/redeem, order gateway, `create_venue_market` | HTTP, NYSE calendar, P&L, arbitrary CPI, fee/treasury state | **Exists.** Anchor 0.31.1. Id `HiREMEBW…`. |
| `programs/m0-harness` | G1–G12 validation scaffolding + `publish_mock_feed` | Ship to devnet | Exists. Localnet-only. Id `3MmdMxRU…`. |
| `packages/sdk` | Shared instruction builders + PDA helpers | Secrets | **Exists** as `@meridian/sdk`. Intended `common` / `meridian-client` / `openbook-adapter` were not created. Frontend still has a duplicate `frontend/lib/meridian.ts` (#18). |
| `services/keeper` | Localnet EventHeap crank + mock-feed settle loop | Load any key except operator; hold Pause/Override | **Exists.** 5s poll. Not the production shape (ADR-0031). |
| `services/marketmaker` | Demo liquidity | Protocol authority | **Exists.** 24/7-while-open under ADR-0033. |
| `services/indexer` | Projections, book, fills, portfolio, health | Write protocol state | **Exists.** SQLite + HTTP. Localnet also hosts faucet + admin settle/pause. |
| `frontend/` | Wallet UX, books, four intents | Direct OpenBook order-creation txs | **Exists.** Next.js 14 App Router. Dark theme. |

Intended `services/automation` (scheduled jobs) and `services/demo-source` are not built. Production topology is documented in `docs/PRODUCTION_INFRA.md`; issues #19–#21 track the keeper rewrite.

## Account topology (as implemented)

Seeds in `programs/meridian/src/constants.rs` / `@meridian/sdk`:

```text
Config                     ["config"]
OutcomeMarket              ["outcome_market", ticker_u8, trading_day_le_u32, strike_1e6_le_u64]
SettlementRecord           ["settlement_record", ticker_u8, trading_day_le_u32]
FeedVersion                ["transport_version", ticker_u8, version_id_le_u32]
Yes mint                   ["yes_mint", market_pubkey]
No mint                    ["no_mint", market_pubkey]
```

Collateral vault = ATA(Market PDA, quote mint). Program Yes-trade ATA = ATA(Market PDA, yes mint).

**Authority simplification vs the architecture sketch:** the OutcomeMarket PDA is mint authority, vault owner, and OpenBook `open_orders_admin` **and** `close_market_admin`. A `VENUE_MARKET_AUTHORITY_SEED` constant exists but `create_venue_market` signs the CPI with the market PDA. There are no separate venue-trade / venue-close PDAs in the live program.

No treasury PDA. No venue-fee PDA. OpenBook `collect_fee_admin` is the G9-proven unsignable sentinel `EhAss6gb…`. Operator-funded closable accounts snapshot a Rent Refund Address at creation.

Wire discriminants (never reused):

```text
TickerId: 0 Invalid, 1 AAPL, 2 AMZN, 3 GOOGL, 4 META, 5 MSFT, 6 NVDA, 7 TSLA
MarketState: 0 Uninitialized, 1 Created, 2 Active, 3 Settled, 4 Abandoned
Outcome: 0 Unset, 1 Yes, 2 No
SettlementRecordState: 0 Pending, 1 FinalOracle, 2 FinalManual
HaltOrContingencyStatus: 0 Invalid, 1 NormalOfficialClose, 2 OfficialCloseAfterHalt, 3 OfficialContingencyClose
```

Config, FeedVersion, SettlementRecord, and Market carry `schema_version: u8` and `[u8; 64]` reserved padding. User-visible Market Phase is a projection, not `MarketState`.

## Market state machine

```text
Created  --create_venue_market--> Active --settle_market(SettlementRecord)--> Settled
Created|empty-Active  --abandon_market--> Abandoned   (activity_started == false)
```

`activity_started` is monotonic; first successful mint or Meridian order authorization sets it. Abandoned is a terminal tombstone; V1 never recreates ticker/Strike/Trading Day after issuance (ADR-0011).

Time overlay on Active (ADR-0033): `mint_open_ts = creation`; `trade_open_ts = creation + 1800`; both stop at `close_ts` (NYSE session close). Pause blocks mint and new Directional Intents, preserves resting orders, keeps cancel / consume / settle_funds / Redemption / liability reconcile / Settlement.

Strict-build schedule (`validate_schedule`, `not(feature = "localnet")`):

- `mint_open < trade_open < close`
- `trade_open − mint_open == 1800`
- `0 < (close − trade_open) ≤ MAX_SESSION_SECS` (`432_000` = 5 days) — **uncommitted as of 2026-08-22**, issue #22
- `now ≤ close − MIN_ADD_STRIKE_LEAD_SECS`

Localnet feature skips those floors so the demo can run in one sitting.

Emergency Expiry (ADR-0018) is a **conditional one-way fuse**. G3 proved OpenBook `set_market_expired`. The Meridian program stores `emergency_expired*` fields but does **not** yet expose an `emergency_expire` instruction. ADR-0033 chose the recovery path for post-live gap risk; adopt/omit is still issue #15.

## Trading patterns

1. **Meridian is the only order gateway.** Direct OpenBook place/take without the market PDA as `open_orders_admin` fails.
2. **`create_venue_market`** is the only attachable venue path. Operator pays rent only; no post-create header-mutation wrapper.
3. **Limits are PostOnly** with `AbortTransaction` and `expiry_timestamp = close_ts - 1`. Crossing is a venue silent no-op — wrappers require the returned order id or revert (`LimitWouldCross`).
4. **Market Actions are `take_full`:** CPI `place_take_order`, exact base-delta assertion; partial fill rolls back.
5. **EventHeap:** practical inline maker cap is **11** (SBF heap), not 15. `consume_events` max 8/ix; owners must be present. Full-heap fills panic (600). Keeper capacity ≥ 2× measured worst-case.
6. **Buy No market** = `mint_pair` + `take_full(Ask)` in one tx.
7. **Buy No limit** = OOI? + OOA? + `mint_pair` + PostOnly Ask in one first-use approval (G7 passed; no waiver).
8. **Sell No** = `redeem_no_via_market` unless the builder can cancel own matching Yes and use direct Pair Redemption. Vault never pays SOL. Cost bound uses Worst Execution Price; `yes_cost_atoms <= 99*q/100`.

Lots: 1 whole Yes = 1 base lot (1_000_000 atoms); quote lot = $0.01; prices 1–99 cents. Venue actions require whole-contract quantities; mint / direct Pair Redemption / Outcome Redemption operate on any positive atom count (ADR-0008).

Deployment ALT (ADR-0025) holds **only** stable global addresses. Per-day/per-user accounts stay inline. After M0, ALT authority is removed. The frozen ALT is **not yet created on-chain** (DEVNET_DEPLOY Phase 2).

## Collateral pattern

`collateral_liability_atoms` is conservative and supply-derived (ADR-0002):

```text
before Settlement (outcome Unset):  max(yes_supply, no_supply)
after outcome set:                  winning_supply
```

`reconcile_collateral_liability` is specified as permissionless and pause-available; it is **not** a live instruction in `programs/meridian` yet. Direct Holder Burn is unsupported SPL forfeiture. Surplus is observable and **non-withdrawable** in V1 (ADR-0013).

Settlement reconciles liability to winning supply but transfers no collateral; only Redemption pays users.

## Redemption family (ADR-0003)

- **Pair Redemption** — `redeem_pair_direct`; before and after Settlement.
- **Market-assisted Pair Redemption** — `redeem_no_via_market`; live session only.
- **Outcome Redemption** — `redeem_winning`; winner $1 / loser $0.

## Settlement pattern

One SettlementRecord PDA per ticker + Trading Day (ADR-0012, 0023). First Outcome Market initializes the immutable **Pending** header; later Strikes must match it exactly. Anyone may refresh/redeliver the same public-feed identity and submit a verified result; first valid finalization wins (`FinalOracle`, or `FinalManual` after delay).

Quality predicate includes delivery freshness, exact V1 sample agreement (`max_sample_spread_bps = 0`), qualifying-trade, final/unadjusted, and prior-close sanity. Official Close is Nasdaq NOCP under the recorded Close Method (ADR-0021).

The program **pins the delivery feed by owner** (`WrongDeliveryOwner`): the feed account owner must equal `record.oracle_program_id`. The read happens in BOTH builds (A1); caller args are advisory. The strict build additionally enforces the close window on the feed's `observed_ts` (`[close−60s, close+900s]`, `ObservedOutsideCloseWindow`, ADR-0034 §Capture window); `localnet` skips that one check. Transports: harness mock feed + `publish_mock_feed` (localnet default), or the **Pyth adapter** (`programs/pyth-adapter`, delivery PDA `[b"delivery", ticker]`, same byte layout) — proven end-to-end by `make pyth-settle-e2e`. Pyth is the transport (ADR-0034). Pyth equity prices are last trades, not the Nasdaq Official Close, so a Pyth settle is **not** G11 until calibrated via provider #9 + `make oracle-e2e-devnet`.

Timing (devnet): preflight close−5m; poll from +15m; `settle_market` no earlier than +20m (snapshotted ≥1200s); SLO +25m; override ≥1h.

Manual override (ADR-0005): two agreeing evidenced values; program binds the manifest digest and derives the winner. HTTP authenticity is an Override Authority / runbook trust assumption.

If evidence never converges → **Settlement Disputed** indefinitely (ADR-0026).

## Automation pattern (ADR-0031–0033)

Production keeper is **not** a poll:

- **Settlement job** — scheduler at `close_ts + normal_settlement_delay_secs`, gated on Official Close published; backoff if the feed is missing.
- **Market-open / `add_strike` job** — fires at resolution + 5m off settlement completion (ADR-0032).
- **EventHeap crank** — `onAccountChange` per active heap; minutes-scale reconcile backstop.

Every action is idempotent on-chain, so at-least-once scheduling is safe. Localnet `services/keeper` remains a 5s `setInterval` that also fabricates the Official Close via the harness mock feed.

## Fee pattern (V1)

Zero maker, taker, and redemption fees. No fee_admin, fee snapshots, treasury, collection, or withdrawal (ADR-0001, 0007).

## Directional Guardrail (ADR-0009, 0019)

Frontend-enforced from fresh Position State. Mixed/Unknown fail closed. Missing indexed state → Recovery-only Mode. Tokens remain freely transferable on-chain. **Not yet implemented** beyond the indexer-lag banner.

## Trust and roles

Two-step rotation: governance proposes; incoming key accepts; operational roles cannot rotate themselves (ADR-0024). Implemented as `propose_role` / `accept_role`. Custody, labeled-demo collapse, and which process may load which key: `docs/GOVERNANCE.md`.

| Role | Hot/cold | Can | Cannot |
| --- | --- | --- | --- |
| operator | hot automation | create/add/create-venue/abandon empty markets; pay rent; keeper/calendar | hold venue authority, pause issued markets, settle by privilege, override, withdraw collateral |
| pause_authority | separate | global/per-market pause, one-way bounded-reason permanent pause, conditional Emergency Expiry | settle or mutate terms |
| override_authority | isolated cold on demo; **mandatory multisig for non-demo** | after delay, attest two equal manual values + evidence manifest | bypass delay/equality, choose outcome bit, create, trade |
| governance | cold | two-step role rotation, future params, transport version register/activate | rewrite Market or SettlementRecord snapshots |
| program upgrade | dedicated cold until M6 | upgrades during PoC; publish ProgramData/hash/slot | live in services; non-demo without multisig |

M6 gate: Squads Protocol V4 `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, audited commit `64af7330413d5c85cbbccfd8c27a05d45b6e666f`, `@sqds/multisig@2.1.4`. Autonomous 3-member, threshold 2, `configAuthority = null`, vault-index-0 PDA becomes Upgradeable Loader authority. G12 proved the 2-of-3 loader drill on localnet against the immutable mainnet fixture.

CPI allowlist: SPL Token, ATA, Metaplex Token Metadata, pinned OpenBook. MIT IDL/client/layouts only.

## Implementation milestones

| Milestone | Scope | Exit | State |
| --- | --- | --- | --- |
| **M0** | G1–G12 | signed go/no-go | G1–G10, G12 localnet green. G11 / #17 / #8 / human inputs open. |
| **M1** | Config/roles/feeds, create/add-strike, collateral, mint/redeem, pause | program + strike + ADV core | **Built** in `programs/meridian` (ahead of signed go/no-go, per user direction). |
| **M2** | OpenBook attach, wrappers, keeper, four paths | localnet green | **Built** on localnet, including Sell No. |
| **M3** | Pyth transport, calendar, settlement, override | oracle-e2e + settlement ADV | Partial: feed-read settle + owner pin + Pyth adapter (proven locally). G11 calibration (#16/#9) and calendar/blackout not done. |
| **M4** | Pages, guardrail, live prices | Playwright | Pages exist. No Playwright. Guardrail/SIP incomplete. |
| **M5** | Indexer, WS, History Completeness, P&L | scripted P&L | Indexer REST + book/fills/health. No WS, no P&L. |
| **M6** | Devnet E2E, synthetic demo, Squads transfer | `make demo-devnet` + upgrade-authority proof | `make build-devnet` done (#23). Seed `make demo-devnet` landed (#24, issue still open). No deploy, no oracle-e2e, no Squads transfer. |
