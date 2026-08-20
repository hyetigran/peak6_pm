# System Patterns

Use `CONTEXT.md` vocabulary. `docs/PRD.md` v0.7 and `docs/ARCHITECTURE.md` v1.1 are reconciled with ADR-0001 through ADR-0028.

## System shape

```text
User wallet → Next.js/Umi frontend → Solana RPC
Automation (operator key only)     → Solana RPC
Governance / pause / override      → Solana RPC

RPC → Meridian ──CPI──► OpenBook V2 v1.7
            ──CPI──► SPL Token / ATA / Metaplex
            ──read─► Switchboard On-Demand (delivery, not source of truth)
            ──finalize/consume─► SettlementRecord PDA

Indexer (read-only) ← logs/accounts
Frontend ← REST/WS ← Indexer
```

Write path is on-chain. Read path is indexer projections. Indexer never holds protocol keys.

## Component boundaries

| Component | Does | Must not |
| --- | --- | --- |
| `programs/meridian` | Config, transport versions, Settlement Records, Outcome Market lifecycle, collateral, mint/redeem, order gateway, `create_venue_market` | HTTP, NYSE calendar, P&L, arbitrary CPI, fee/treasury state |
| `packages/common` | Strike engine, NYSE calendar, fixed-point, address derivation, shared types | Secrets |
| `packages/openbook-adapter` | Pinned OpenBook decode/derive/recovery IX; golden-tested v1.7 client | Leak raw OpenBook types into app |
| `services/automation` | Creation, add-strike, keeper, feed update, settle, corporate-action checks, correction monitor, cleanup | Load any key except operator; hold Pause/Override |
| `services/indexer` | Projections, book WS, P&L, History Completeness, crank health | Write protocol state |
| `frontend/` | Wallet UX, Directional Guardrail, Recovery-only Mode, Meridian tx construction | Direct OpenBook order-creation txs |

## Account topology (canonical seeds)

```text
Config                     ["config"]
Market                     ["market", ticker_u8, strike_1e6_le_u64, trading_day_yyyymmdd_le_u32]
SettlementRecord           ["settlement-record", ticker_u8, trading_day_yyyymmdd_le_u32]
Yes mint                   ["yes", market_pubkey]
No mint                    ["no", market_pubkey]
FeedVersion (transport)    ["feed-version", ticker_u8, version_id_le_u32]
Venue market authority     ["venue-market-authority", market_pubkey]  # sole create-venue signer
Venue trade                ["venue-trade", market_pubkey]             # open_orders_admin
Venue close                ["venue-close", market_pubkey]             # close_market_admin
```

No treasury PDA. No venue-fee PDA. OpenBook `collect_fee_admin` is an M0-proven **unsignable sentinel**. Collateral vault = ATA(Market PDA, quote mint). Program Yes-trade ATA = ATA(Market PDA, yes mint). Operator-funded closable accounts snapshot a Rent Refund Address at creation.

Wire discriminants (never reused; declaration order is not implicit serialization):

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
Created  --attach_venue--> Active --settle_market(SettlementRecord)--> Settled
Created|empty-Active  --abandon_market--> Abandoned   (activity_started == false)
```

`activity_started` is monotonic; first successful mint or Meridian order authorization sets it. Abandoned is a terminal tombstone; V1 never recreates ticker/Strike/Trading Day after issuance (ADR-0011).

Time overlay on Active: mint from `mint_open_ts`; trade from `trade_open_ts`; both stop at `close_ts`. Pause blocks mint and new Directional Intents, preserves resting orders, keeps cancel / consume / settle_funds / Redemption / liability reconcile / Settlement.

Emergency Expiry (ADR-0018) is a **conditional one-way fuse**: Pause Authority + venue-close signer, only if M0 proves the full recovery path; otherwise omit the instruction.

## Trading patterns

1. **Meridian is the only order gateway.** Direct OpenBook place/take without the venue-trade PDA fails.
2. **`create_venue_market`** is the only attachable venue path. Venue-market-authority PDA signs creation; operator pays rent only; no post-create header-mutation wrapper.
3. **Limits are PostOnly** with `AbortTransaction` and `expiry_timestamp = close_ts - 1`. Crossing → `LimitWouldCross`, whole tx reverts.
4. **Market Actions are `take_full`:** CPI `place_take_order`, exact base-delta assertion; partial fill rolls back.
5. **EventHeap:** ≤15 maker remaining accounts; prepend bounded `consume_events` under pressure; fail closed if the safe tx cannot fit. Keeper capacity ≥ 2× measured worst-case throughput.
6. **Buy No market** = `mint_pair` + `take_full(Ask)` in one tx.
7. **Buy No limit** = OOI? + OOA? + `mint_pair` (may init outcome ATAs) + PostOnly Ask in one first-use approval (G7; only named waiver).
8. **Sell No** = `redeem_pair_via_market` unless the builder can cancel own matching Yes and use direct Pair Redemption. Vault never pays SOL. Cost bound uses Worst Execution Price; `yes_cost_atoms <= 99*q/100`.

Lots: 1 whole Yes = 1 base lot (1_000_000 atoms); quote lot = $0.01; prices 1–99 cents. Venue actions require whole-contract quantities; mint / direct Pair Redemption / Outcome Redemption operate on any positive atom count (ADR-0008).

Deployment ALT (ADR-0025) holds **only** stable global addresses (programs, sysvars, Config, quote mint). Per-day/per-user accounts stay inline. After M0, ALT authority is removed.

## Collateral pattern

`collateral_liability_atoms` is conservative and supply-derived (ADR-0002, refined in v1.1):

```text
before Settlement (outcome Unset):  max(yes_supply, no_supply)
after outcome set:                  winning_supply
```

`reconcile_collateral_liability` is permissionless, pause-available, and may only decrease stored liability monotonically to the target. Direct Holder Burn is unsupported SPL forfeiture; reconciliation turns the released obligation into ownerless **Collateral Surplus**. Surplus is observable and **non-withdrawable** in V1 (ADR-0013). No treasury, no skim.

Settlement reconciles liability to winning supply but transfers no collateral; only Redemption pays users.

## Redemption family (ADR-0003)

- **Pair Redemption** — equal Yes+No for matching collateral; **before and after** Settlement.
- **Market-assisted Pair Redemption** — Sell No; live session only; same pair-redemption primitive.
- **Outcome Redemption** — after Settlement; winner $1 / loser $0.

## Settlement pattern

One SettlementRecord PDA per ticker + Trading Day (ADR-0012, 0023). First Outcome Market initializes the immutable **Pending** header; later Strikes must match it exactly. Anyone may refresh/redeliver the same public-feed identity and submit a verified result; first valid finalization wins (`FinalOracle`, or `FinalManual` after delay).

Quality predicate includes delivery freshness, exact V1 sample agreement (`max_sample_spread_bps = 0`), qualifying-trade, final/unadjusted, and prior-close sanity. Official Close is Nasdaq NOCP under the recorded Close Method (ADR-0021) — never a generic daily bar.

Timing (devnet): preflight close−5m; poll from +15m; `settle_market` no earlier than +20m (snapshotted ≥1200s); SLO +25m; override ≥1h. Twenty-minute cutoff is devnet-specific.

Manual override (ADR-0005, refined): two `ManualSourceEvidenceV1` entries (SIP-consolidated + distinct second source) must agree on normalized close and halt status. Program binds the ordered-manifest digest and derives the winner. HTTP authenticity is an Override Authority / runbook trust assumption, not an on-chain proof.

If evidence never converges → **Settlement Disputed** indefinitely (ADR-0026).

Switchboard is the initial **delivery path**. A post-registration executable upgrade fails closed for old Pending transport; only a newly registered future-day version may follow the changed identity.

## Fee pattern (V1)

Zero maker, taker, and redemption fees. No fee_admin, fee snapshots, treasury, collection, or withdrawal (ADR-0001, 0007). Wallet/operator SOL, rent, and EventHeap penalties are not protocol fees and are excluded from Platform-execution P&L.

## Directional Guardrail (ADR-0009, 0019)

Frontend-enforced from fresh Position State (Exposure Interval across holdings, venue balances, resting **and locally pending** orders). Mixed/Unknown fail closed. Missing indexed state → Recovery-only Mode. Tokens remain freely transferable on-chain.

## Trust and roles

Two-step rotation: governance proposes; incoming key accepts; operational roles cannot rotate themselves (ADR-0024).

| Role | Hot/cold | Can | Cannot |
| --- | --- | --- | --- |
| operator | hot automation | create/add/create-venue/attach/abandon empty markets; pay rent; keeper/calendar | hold venue authority, pause issued markets, settle by privilege, override, withdraw collateral |
| pause_authority | separate | global/per-market pause, one-way bounded-reason permanent pause, conditional Emergency Expiry | settle or mutate terms |
| override_authority | isolated cold on demo; **mandatory multisig for non-demo** | after delay, attest two equal manual values + evidence manifest | bypass delay/equality, choose outcome bit, create, trade |
| governance | cold | two-step role rotation, future params, transport version register/activate | rewrite Market or SettlementRecord snapshots |
| program upgrade | dedicated cold until M6 | upgrades during PoC; publish ProgramData/hash/slot | live in services; non-demo without multisig |

M6 gate: Squads Protocol V4 `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, audited commit `64af7330413d5c85cbbccfd8c27a05d45b6e666f`, `@sqds/multisig@2.1.4`. Autonomous 3-member, threshold 2, `configAuthority = null`, vault-index-0 PDA (not the multisig account) becomes Upgradeable Loader authority. One approval cannot execute; two can hash-verified upgrade.

CPI allowlist: SPL Token, ATA, Metaplex Token Metadata, pinned OpenBook. MIT IDL/client/layouts only for any fallback adapter.

## Implementation milestones

| Milestone | Scope | Exit |
| --- | --- | --- |
| **M0** | G1–G12 pin, CPI, PostOnly, EventHeap, Buy-No-limit size, Sell-No, rent, zero-fee sentinel, atomic Settlement Record / real oracle, identities/metadata/quote/recovery | signed go/no-go; safety gates non-waiverable |
| **M1** | Config/roles/feeds, create/add-strike, collateral, mint/redeem, MockOracle, pause | program + strike + ADV core |
| **M2** | OpenBook attach, wrappers, keeper, four paths, multi-user | localnet green |
| **M3** | Switchboard, provider calibration, calendar, settlement, override | oracle-e2e + settlement ADV |
| **M4** | Five pages, UI elements, guardrail, live prices | Playwright |
| **M5** | Indexer, WS, History Completeness, P&L, crank health | scripted P&L |
| **M6** | Devnet E2E, synthetic demo, Squads transfer, docs | `make demo-devnet` + upgrade-authority proof |

Do not start M1 until the signed M0 report is approved (ADR-0020).
