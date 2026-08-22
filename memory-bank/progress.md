# Progress

## Status

**Phase:** Localnet demo live. V1 program + indexer + frontend + keeper + market-maker exist. Devnet path started. M0 not signed off.

Date: 2026-08-22.

`main` @ `2d74f47` tracks `origin/main`. Uncommitted: ADR-0033 schedule bound in `programs/meridian` (#22).

## What works

### On-chain

- **`programs/meridian`** (Anchor 0.31.1, id `HiREMEBW…`): Config + two-step roles, `register_transport`, `create_outcome_market` (Pair mints + ATA vault + shared SettlementRecord), `publish_metadata`, `create_venue_market`, `mint_pair`, `redeem_pair_direct`, PostOnly `place_limit_order`, full-fill `place_take_order`, `redeem_no_via_market`, `finalize_settlement_{normal,manual}`, `settle_market`, `redeem_winning`, `abandon_market`, `set_global_pause`.
- Settlement **reads the Official Close from the owner-pinned feed account in BOTH builds** (A1, `20f1545`) and rejects a wrong-owner feed (`WrongDeliveryOwner`); caller args are advisory. Localnet feed is the harness mock or the Pyth adapter delivery PDA.
- **`programs/pyth-adapter`** (`Egc4yk…`): `crank(feed_id, max_age, ticker)` reads a Pyth `PriceUpdateV2`, writes the per-ticker delivery PDA in Meridian's delivery layout (halt=1, samples=255 Full). Unit tests 6/6.
- **`programs/m0-harness`**: G2–G10, G12 suites green on localnet against pinned OpenBook v1.7 bytes.

### Off-chain / app

- **`@meridian/sdk`**: shared builders used by tests/scripts/services.
- **Indexer** (`:8787`): GPA ingest, SQLite, markets/book/fills/orders/portfolio/health. Localnet faucet + admin settle/pause/override.
- **Frontend** (`:3100`): dark theme, Markets (no Landing), Trade 3-column with live book / open orders / fills, Portfolio, History, Admin. Recovery-only banner from indexer lag. Test-wallet + `+1000 USDC` faucet.
- **Keeper**: 5s poll — consume EventHeap, publish mock Official Close, finalize + settle after `close_ts`.
- **Market-maker**: seeds a deep book; intended 24/7-while-open (ADR-0033).
- **`make demo`**: one-command localnet lifecycle.
- **`make build-devnet`**: strict SBF + manifest (#23, closed).
- **`make demo-devnet`**: `resolveSeedConfig` + `DEMO_MODE=devnet` seed (#24 landed on main; issue still open).
- **`tests/seed-config.test.ts`**: resolver unit tests, no validator.
- Docs: ADRs 0001–0033, PRODUCTION_INFRA, DEVNET_DEPLOY, DEPLOYMENT, GOVERNANCE, UI_WALKTHROUGH, README (README/walkthrough have stale sentences — see Known issues).

## Pyth oracle adapter (#16 synthetic track) — proven 2026-08-22

- Keeper `KEEPER_ORACLE=pyth`: Hermes pull → post PriceUpdateV2 → adapter crank → finalize → settle (`services/keeper/src/pyth-{adapter,crank}.ts`). `scripts/register-pyth-transports.ts` pins adapter + delivery PDAs on devnet (governance-signed); seed `DEMO_ORACLE=pyth` does the same on localnet.
- `make pyth-settle-e2e` green (`scripts/pyth-settle-e2e.sh` + `pyth-settle-check.ts`): record close == Pyth delivery close (GOOGL $344.7252, TSLA $362.7951), 10/10 markets settled, nonzero on failure. Needs network (devnet clone of Pyth receiver/Wormhole via `scripts/pyth-local.sh`, Hermes).
- Not G11 (ADR-0028): still needs the Official-Close provider (#9) + `oracle-e2e-devnet`.

## What does not exist yet

- Switchboard / Official-Close-provider transport for G11 (#16, blocked on #9). (The Pyth adapter transport exists and is proven — see below — but is demo-grade, not Official Close.)
- `make oracle-e2e-devnet` and `docs/adr/settlement-quality-calibration.md` (G11).
- Signed M0 go/no-go (#17).
- G2 devnet evidence against the canonical deployment (#8).
- Identity-drift monitor (#25).
- Production keeper: scheduled settlement + market-open jobs (#19), heap subscription (#20), pre-open re-validation (#21).
- Frozen on-chain deployment ALT (ADR-0025).
- `packages/common`, Codama Umi client, `packages/openbook-adapter`.
- NYSE calendar + corporate-action blackout automation.
- Directional Guardrail (Exposure Interval) and SIP Live Underlying Price.
- History Completeness / Platform-execution P&L as specified for M5.
- Playwright.
- Devnet program deploy, Squads upgrade-authority transfer (M6).
- `reconcile_collateral_liability` instruction; Meridian `emergency_expire` instruction.
- Keeper reading `OPERATOR_KEYPAIR_PATH` (still `.demo-config.json`).

## Milestone board

| Milestone | State |
| --- | --- |
| Source spec + glossary + ADRs 0001–0028 | Done and on origin |
| PRD v0.7.1 / ARCHITECTURE v1.1.1 | Done and on origin |
| ADRs 0029–0030 (OpenBook identity) | Done |
| ADRs 0031–0033 (keeper / roll / open-when-exists) | **Accepted in docs.** Program bound for 0033 is **uncommitted** (#22). Keeper rewrite is #19–#21. |
| M0 G1–G12 | G1–G10, G12 localnet green. G11 blocked on #9. #17 unsigned. |
| M1 program core | **Built** (ahead of signed go/no-go) |
| M2 OpenBook + four paths | **Built** on localnet, including Sell No |
| M3 oracle / settlement / automation | Partial: feed-read settlement + owner pin + **Pyth adapter proven locally** (`make pyth-settle-e2e`). Official-Close provider / calendar / scheduled keeper missing |
| M4 frontend | Pages exist. No Playwright. Guardrail/SIP incomplete |
| M5 indexer | REST + book/fills/health. No WS / P&L |
| M6 demo + Squads | `build-devnet` done. Seed `demo-devnet` landed. No deploy, no oracle-e2e, no Squads transfer |

## Ticket board (GitLab, 2026-08-22)

**Closed:** #1 G3, #2 G4, #3 G8, #4 G10, #5 G9+G1 residuals, #6 G12, #7 probe, #12 G5, #13 G6, #14 G7, **#23 build-devnet**.

**Open — human / gates:**

| # | Title | Notes |
| --- | --- | --- |
| 8 | G2 devnet evidence | Needs funded canonical-deployment run |
| 9 | Official-Close provider | Blocks #16 / G11 |
| 10 | Alert webhook receiver | Blocks unattended ops |
| 11 | Three Squads V4 member pubkeys | M6 input |
| 15 | Emergency Expiry adopt/reject | G3 proved the fuse; ADR-0033 already uses the recovery path for live gaps |
| 16 | G11 / real oracle proof | Blocked by #9. Owner pin is in the program |
| 17 | Signed M0 go/no-go | Blocked on remaining gates |

**Open — engineering:**

| # | Title | Notes |
| --- | --- | --- |
| 18 | Reconcile `frontend/lib/meridian.ts` with `@meridian/sdk` | Post-v1 |
| 19 | Scheduled settlement + market-open jobs | ADR-0031 |
| 20 | EventHeap `onAccountChange` crank | ADR-0031 |
| 21 | Pre-open eligibility/blackout re-validation | ADR-0032 |
| 22 | `validate_schedule` bounded window + 24/7 MM | **In working tree** |
| 24 | Devnet seed + `make demo-devnet` | Code on main; issue not closed |
| 25 | Identity-drift monitor | ADR-0030 Phase 7 |

## Known issues / risks to track

### Doc drift (process)

README still says `make demo-devnet` is not implemented and lists a Landing page / ADRs only through 0030. UI_WALKTHROUGH still mentions a landing page and a Mint/Redeem slip section that was removed. Treat Makefile + ADRs + this file as current.

### Glossary drift

Markets page subtitle: “Binary contracts on MAG7 daily closes.” Avoid “contract.”

### M0 / settlement

- G11 still unsigned. Strict-build settle-from-args is **not** Official Close proof.
- Provider may be unable to supply same-record Nasdaq NOCP.
- Switchboard executable upgrade after transport registration fails closed / needs a future-day version.
- HTTP evidence for Manual Settlement Override is authority-attested, not chain-authenticated.

### Venue / keeper

- Inline capacity 11; EventHeap-full fills panic (fail-closed). Stalled keeper freezes maker OO slots.
- Localnet keeper poll can re-enter and re-send settle/consume (the hazard ADR-0031 records).
- Canonical OpenBook on public clusters retains an external upgrade authority (ADR-0030).

### Product / UX gaps vs freeze

- No Exposure Interval / Mixed-Unknown fail-closed on new intents.
- Live Underlying Price is static demo REF data.
- History / P&L thinner than M5.
- Admin pause/settle is a demo convenience and must not ship as the production authority model.

### Remaining human inputs

- Official-Close provider (#9).
- Alert webhook receiver (#10).
- Three M6 Squads member pubkeys (#11).
- Emergency Expiry G3 disposition (#15).
- Scheduling substrate (PRODUCTION_INFRA §2).

## Closed since last Memory Bank rewrite

- “Docs-only / implementation not started” — false as of 2026-08-20+.
- Freeze not on origin — `main` is committed and pushed through the seed/devnet work.
- Empty `.gitignore` — filled; `wallets/`, `.env`, demo artifacts ignored.
- G7 waiver question — one-approval path fits; waiver not needed.
- G1 re-ID attempt (ADR-0029) — superseded by ADR-0030 canonical + monitored identity.
- Sell-No port to meridian — T5 green.
- Metaplex `publish_metadata` — localnet-verified.
- Feed owner-pin — S4 green.
- `make build-devnet` (#23).
- Devnet-ready seed resolver (#24 code).
- Lifecycle ADRs 0031–0033 accepted in docs; UI/PRD/ARCH updated to 24/7 roll.
- pnpm workspace + `@meridian/sdk` extraction.
- Frontend rebuilt to mockup (dark, Markets-first, live book).

## Definition of done for the next slice

Land #22 (ADR-0033 `validate_schedule` + tests) without breaking `make demo` / `make meridian-test`. Then the honest remaining code gaps before a labeled synthetic **devnet** demo are: deploy the strict binary (ops), #16 Switchboard adapter (blocked on #9), and #25 identity-drift monitor. G11 / #17 stay blocked on the human provider choice. Do not treat a seeded `make demo-devnet` as oracle proof.
