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
| M0 G1–G12 | Started 2026-08-19. **G1 RED** (retained OpenBook upgrade authority — non-waiverable; `docs/adr/openbook-v2-pin.md`). Executable/commit/hash verified PASS. G2–G12 pending |
| M1 program core | Blocked on signed M0 go/no-go |
| M2 OpenBook integration | Blocked |
| M3 oracle/settlement | Blocked; provider unchosen |
| M4 frontend | Blocked |
| M5 indexer | Blocked |
| M6 synthetic demo + Squads transfer | Blocked |

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

## Known issues / risks to track

### Freeze not on origin (High, process)

PRD v0.7, ARCHITECTURE v1.1, CONTEXT, ADRs, mockups, and Memory Bank live only in the working tree. A fresh clone still sees v0.6 + fee subsystem.

### Empty `.gitignore`

Will not protect `.env` or keypairs once they appear.

### M0 technical risks

- EventHeap backlog near close (inline makers + pre-consume + fail-closed; keeper ≥2× throughput).
- First-use Buy-No-limit exceeds tx limits (G7; only named waiver).
- OpenBook rent + permanent SettlementRecord/metadata (G8; 49/day × 5 days + 20%).
- **REALIZED:** OpenBook devnet upgrade authority is retained (`Cax5s8Cj…`); mainnet likewise (`CZoAmQEr…`). G1 red pending a human decision (own immutable deployment / G1 revision / stop). Bytes+hash+commit verified clean.
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
