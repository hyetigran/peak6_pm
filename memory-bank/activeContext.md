# Active Context

## Current focus

Product and architecture are **reconciled through ADR-0028**. The working freeze is PRD **v0.7** and ARCHITECTURE **v1.1**. The product decision frontier is empty. **M0 (G1–G12) is authorized to begin.** M1 starts only after a signed go/no-go report. There is still no program, services, or app code.

## What is true right now (2026-08-19 evening)

- Branch: `main`, tracking `origin/main`.
- Still one commit: `e1ef575 init docs`.
- Unstaged: `docs/PRD.md` (v0.6 → v0.7, large reconciliation) and `docs/ARCHITECTURE.md` (v1.0 → v1.1).
- Untracked and **not on origin**: `CONTEXT.md`, `docs/adr/` (0001–0028), `docs/agents/`, `AGENTS.md`, `memory-bank/`, `.cursor/rules/`, `design mockups/`.
- Empty `frontend/` placeholder. `.gitignore` still empty.
- Source spec also lives at `design mockups/uploads/meridian-spec.md`. HTML wireframes exist under `design mockups/`.
- Squads V4 research is written: `docs/agents/squads-v4-multisig-research.md`.

A clone of `main` alone still shows only the original v0.6 docs. Treat the working tree as the real freeze until this is committed.

## Working document stack

1. **`CONTEXT.md`** — glossary (expanded: Market Phase, Executable Depth, Worst Execution Price, Recovery-only Mode, Live Underlying Price, Direct Holder Burn, Close Method, Settlement Quality Predicate, Settlement Disputed, Emergency Expiry, Corporate Action Blackout, History Completeness, Platform-execution P&L, Internal Unwind, Rent Refund Address).
2. **`docs/adr/0001`–`0028`** — accepted Rounds 1–6 decisions.
3. **`docs/ARCHITECTURE.md` v1.1** — implementation architecture; M0 validation candidate.
4. **`docs/PRD.md` v0.7** — reconciled product behavior and acceptance.
5. **`docs/REQUIREMENTS.md`** — converted source spec; PDF remains upstream source of truth.

**Conflict rule:** implement to the v0.7/v1.1 freeze + ADRs. The earlier “ADR vs freeze” drift is closed. New contradictions still get called out explicitly.

## What changed since Memory Bank init

- Fees, surplus withdrawal, treasury, and `fee_admin` removed from architecture, not just from ADRs.
- Collateral liability is `collateral_liability_atoms`, supply-derived, with permissionless reconcile and locked surplus.
- One SettlementRecord PDA per ticker/day; permissionless first-valid finalization; Nasdaq NOCP; Settlement Disputed if no Official Close.
- Settlement clock moved: earliest automated Settlement **close+20m** (devnet), SLO **+25m**, preflight **close−5m**, poll from **+15m**.
- Manual override requires **two agreeing evidenced sources** and a bound manifest digest.
- `create_venue_market` with dedicated venue-market-authority PDA; unsignable fee-admin sentinel.
- Sell No must not knowingly self-cross; Internal Unwind is the adversarial leftover.
- M0 expanded to **G1–G12**; safety gates non-waiverable; only Buy-No one-approval has a named product waiver.
- Two demo paths: synthetic `make demo-devnet` vs real `make oracle-e2e-devnet`.
- Circle Devnet USDC pin, Arweave metadata-before-mint, frozen ALT, snapshotted rent refunds, NYSE calendar authority, corporate-action blackout, two-step role rotation, Squads V4 M6 upgrade gate.
- ATM Strike default is **on**.

## Active decisions to carry forward

- OpenBook V2 v1.7, no fork, MIT CPI/client only, `upgrade_authority == None`.
- One Yes/USDC Venue Market per Outcome Market. Sell No limit is not V1.
- Limits PostOnly; Market Actions full-fill-or-revert; fail closed.
- Directional Guardrail is UI from fresh Position State, not an on-chain token lock.
- Synthetic demo cannot satisfy settlement-correctness or provider-finality claims.
- Frontend lives under `frontend/`.
- Do not scaffold dormant fee or collateral-withdrawal switches.

## Next steps (priority)

1. **Commit the freeze** (PRD v0.7, ARCHITECTURE v1.1, CONTEXT, ADRs 0001–0028, agent docs, Memory Bank) so origin matches the working tree. User has not asked yet.
2. **Start M0**, not M1: pin OpenBook (`docs/adr/openbook-v2-pin.md`), prove G1–G12, write `docs/adr/settlement-quality-calibration.md` as part of G11, produce a signed go/no-go report.
3. Fill `.gitignore` before any keys or `.env` appear.
4. Choose Official-Close provider against the frozen Settlement Record contract; do not weaken checks to fit a vendor.
5. Supply M6 Squads member pubkeys when that gate is in scope. Adopt or omit Emergency Expiry only after G3.

## Open questions still owned by humans

- Official-Close provider (G11 go/no-go; Massive SIP + Alpaca SIP cross-check specified as calibration method).
- Alert webhook receiver before unattended operation.
- Three M6 Squads members / create-key / published vault addresses.
- Emergency Expiry in or out after G3.
- Whether first-use Buy-No-limit fits one approval (G7); two-approval needs the named stakeholder waiver.

## Considerations while building

- Prefer fail-closed over partial synthetic exposure.
- Collateral vault never pays SOL/rent/penalties.
- Never trust client-supplied OpenBook/market/vault/admin accounts.
- Operator hot key cannot pause issued markets, override, or touch collateral.
- HTTP settlement evidence is not on-chain-authenticated; Override Authority is a delayed price trust root.
- Use glossary terms in issues, tests, and UI copy.
- GitLab issues via `glab`; do not treat MRs as triage.
