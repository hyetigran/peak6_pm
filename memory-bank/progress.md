# Progress

## Status

**Phase:** Reconciled product/architecture freeze (PRD v0.7, ARCHITECTURE v1.1, ADRs 0001–0028). **M0 authorized. Implementation not started.**

Date: 2026-08-19 evening.

## What works (documentation)

- Source requirements in `docs/REQUIREMENTS.md` (and `design mockups/uploads/meridian-spec.md`).
- Product plan **v0.7** in `docs/PRD.md` — OpenBook V2 retained; Rounds 1–6 ADRs absorbed; M0 may begin.
- Architecture **v1.1** in `docs/ARCHITECTURE.md` — fee subsystem gone, SettlementRecord topology, G1–G12, Squads/ALT/metadata/USDC pins.
- Expanded glossary in `CONTEXT.md`.
- Accepted ADRs **0001–0028**.
- Agent docs: issue tracker, triage labels, domain layout, Squads V4 research.
- Design mockups: standalone HTML wireframes under `design mockups/`.
- Memory Bank and `.cursor/rules/` updated to the v0.7/v1.1 freeze.

## What does not exist yet

- `programs/meridian` (Anchor program).
- Settlement quality calibration ADR (`docs/adr/settlement-quality-calibration.md`).
- `packages/common`, generated Meridian client, `packages/openbook-adapter`.
- `services/automation`, `services/indexer`, `services/demo-source`.
- Frontend app (empty `frontend/` only).
- Makefile, `.env.example`, scripts, tests, README, runbooks.
- Any M0 gate evidence (G1–G12 unproven). Signed go/no-go report does not exist.
- Git commit of the freeze (origin `main` is still `e1ef575 init docs`).

## Milestone board

| Milestone | State |
| --- | --- |
| Source spec conversion | Done |
| Domain glossary + ADRs 0001–0028 | Done in working tree; **untracked** |
| PRD v0.7 / ARCHITECTURE v1.1 reconciliation | Done in working tree; **unstaged** |
| Design mockups | Present; untracked |
| Memory Bank | Updated to current freeze |
| M0 G1–G12 | **G1,G2,G3,G4,G5,G6,G7,G8,G9,G10,G12 green** (harness, 57 tests, all code-reviewed). G11 blocked on provider #9. Signed go/no-go #17 pending |
| M1 program core | Blocked on signed M0 go/no-go |
| M2 OpenBook integration | Blocked |
| M3 oracle/settlement | Blocked; provider unchosen |
| M4 frontend | Blocked |
| M5 indexer | Blocked |
| M6 synthetic demo + Squads transfer | Blocked |

## Services + frontend + localnet demo (NEW, 2026-08-20)

- **Indexer** (`services/indexer`): polls `getProgramAccounts` for OutcomeMarket accounts, byte-decodes them, upserts into SQLite, serves a JSON API (`/markets`, `/markets/:pk`, `/portfolio/:wallet` live Position State, `/health` History Completeness). Proven decoding real on-chain markets.
- **Frontend** (`frontend/`, Next.js 14 App Router): built to `design mockups/` — paper theme (`#faf9f5`/navy/YES-blue/NO-coral/green), Space Grotesk + IBM Plex Mono. Five pages (Landing, Markets, Trade with mirrored YES/NO + payoff sentence, Portfolio, History). Reads live indexer data; a managed localnet burner wallet makes mint/redeem/claim work. `next build` green; **browser-verified** against the mockup (docs/screenshots/).
- **One-command demo**: `make demo` → validator (all programs) + seed 7 Active markets across AAPL/NVDA/MSFT + indexer (:8787) + frontend (:3100). `scripts/seed-demo.ts`, `scripts/demo.sh`.

**Full stack is live on localnet**: create → mint → trade → settle → redeem, clickable in the browser. Remaining polish: market-assisted Sell-No, real Switchboard oracle, Metaplex metadata, automation/keeper + demo-source services, order-book depth in the Trade UI. M0 gate items #8/#9/#15/#16/#17 still open (human inputs / go-no-go).

## programs/meridian — the real V1 program (NEW, 2026-08-20)

Per the user's direction (build the program → services → frontend, localnet first), the production Anchor program now EXISTS and is functionally complete for V1, built on the M0-validated OpenBook integration. 13/13 meridian tests green on localnet across three suites (`make meridian-test`):

- **Foundation** (6/6): Config (versioned, 4 two-step roles, pinned OpenBook identity, quote-mint pin, quality bounds, fee-free), register_transport (FeedVersion), create_outcome_market (Pair mints + collateral vault under the market PDA + init-or-match shared SettlementRecord), Add Strike, abandon.
- **Trading** (4/4): create_venue_market (OpenBook venue, OutcomeMarket PDA as sole authority), mint_pair, place_limit_order (PostOnly, fail-closed), place_take_order (full-fill-or-revert), redeem_pair_direct. Vault>=liability invariant on-chain.
- **Settlement** (3/3): finalize_settlement_normal/manual (record Pending→Final, quality bounds, override), settle_market (derive winner, at-or-above→Yes), redeem_winning (Outcome Redemption, $1 complement).

Program id `HiREMEBW…`. Authority model: the OutcomeMarket PDA is mint authority + vault owner + OpenBook admin (one PDA per market). `localnet` build feature relaxes only timing floors for tests/demo; devnet build is strict. Settlement delivery is mocked on localnet, real Switchboard on devnet (ADR-0028).

**Still TODO for the full stack:** market-assisted Sell-No (redeem_no_via_market) port; real Switchboard oracle read; Metaplex metadata CPI; services (automation/indexer/demo-source); frontend (5 pages); localnet demo wiring. M0 gates #8/#9/#15/#16/#17 remain (human inputs / go-no-go).

## Timeline budget (PRD v0.7 §17)

Capacity assumption: **one senior engineer, full-time, AI-assisted. 18–22 working days total**, and only if M0 passes without architectural revision.

| Milestone | Days |
| --- | --- |
| M0 gates G1–G12 | D1–4 |
| M1 program core | D5–7 |
| M2 OpenBook integration | D8–11 |
| M3 provider/settlement/automation | D12–14 |
| M4 frontend (5 pages) | D15–17 |
| M5 indexer/History/P&L | D18–19.5 |
| M6 demo, oracle rerun, Squads transfer | D20–22 |

Day 0 has not started. The schedule has no slack for an M0 failure that reopens transport or venue design; treat a red non-waiverable gate as a plan revision, not a delay.

## Ticket board (GitLab, 2026-08-20)

M0 broken into issues #1–#17 (probe #7 closed). Frontier (#1,#2,#3,#4,#5,#6 G12,#12,#13,#14 done 2026-08-20):   #8 G2-devnet; humans: #9 provider, #10 webhook, #11 Squads members. #12 G5, #13 G6, #14 G7 done 2026-08-20. Blocked: #15 EE-decision←#1, #16 G11←#9, #17 go/no-go←all gates. Triage role is the first description line (bot cannot set labels); blocking edges live in descriptions.

## Known issues / risks to track

### Freeze not on origin (High, process)

PRD v0.7, ARCHITECTURE v1.1, CONTEXT, ADRs, mockups, and Memory Bank live only in the working tree. A fresh clone still sees v0.6 + fee subsystem.

### Empty `.gitignore`

Will not protect `.env` or keypairs once they appear.

### M0 technical risks

- **G6 measured:** inline capacity 11 (not 15; SBF heap bound, contiguous probe), consume 8/ix + owner-OO-required, 600-heap drains <1s — keeper SLO trivially met. EventHeap-full fills panic (fail-closed).
- **G7 RESOLVED: first-use Buy-No-limit fits ONE approval (936B/148.7k CU) — the named waiver is NOT needed.** Operator venue creation is a 2-tx flow (1-tx variant impossible at 1319B).
- **G8 measured:** 5-day+20% budget ≈ 567 SOL, ~1.9 SOL/Venue Market in books/heap; locked only ~0.93 SOL/day; ~93.6 SOL/day reclaimable via close. Devnet faucet strategy or recycling needed.
- **G1 REOPENED:** ADR-0029 copy (`923gYkFC…`) is inert — v1.7 declare_id check binds the artifact to canonical `opnb2LAf…` only; byte-patch unprovable (second inlined ID). 7.21 SOL sunk on the inert deployment. Resolved by ADR-0030: canonical deployment + monitored fail-closed checks; PRD v0.7.1 G1 clause revised.
- GPL contamination of CPI adapter.
- `redeem_pair_via_market` vault-spend bugs; knowing self-cross must be avoided (G5).
- Provider cannot supply same-record Nasdaq NOCP (G11 go/no-go).
- Switchboard executable upgrade after transport registration (fail closed / future-day version).
- DST/holiday/early-close vs NYSE fixtures vs Alpaca Calendar API.
- Missing Official Close → Settlement Disputed with unmatched directional lockup.
- Late-discovered corporate action after issuance.
- HTTP evidence for Manual Settlement Override is authority-attested, not chain-authenticated.
- Freely transferred tokens / Direct Holder Burn bypass UI guardrail (documented; economically handled via reconcile + surplus lock).

### Remaining human inputs

- Official-Close provider.
- Alert webhook receiver.
- Three M6 Squads member pubkeys.
- Emergency Expiry G3 disposition.

## Closed since last Memory Bank

- Documentation drift between ADRs and freeze (PRD/ARCHITECTURE now absorb 0001–0028).
- Q1 Redemption-family interpretation (closed with Direct Holder Burn boundary).
- ATM default (enabled).
- Quote asset (Circle Devnet USDC).
- Calendar authority (NYSE + Alpaca operational).
- Fee/referrer conservation as a fee-on path (replaced by zero-fee + unsignable sentinel).
- Post-settlement Pair Redemption ban (allowed; no claim fee).

## Definition of done for the next slice

Signed M0 go/no-go covering G1–G12, including `docs/adr/openbook-v2-pin.md`, G11 `make oracle-e2e-devnet` (not synthetic), G3 Emergency Expiry disposition, and G11 settlement-quality calibration ADR. No M1 feature code until that report is approved.
