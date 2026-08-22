# Active Context

## Current focus

**Localnet is a working product demo. The engineering target is a strict-build devnet path plus the 24/7 lifecycle ADRs.**

Freeze: PRD **v0.7.1** + ARCHITECTURE **v1.1.1** + ADRs **0001–0033**. `main` is at `2d74f47` and tracks `origin/main` — the freeze **is** on origin (the old “docs-only working tree” fact is dead).

Working-tree (uncommitted, 2026-08-22): ADR-0033 program change in `programs/meridian` — `MAX_SESSION_SECS = 432_000`, `validate_schedule` bounds the session instead of pinning 3.5h/6.5h, plus `not(localnet)` unit tests. This is issue **#22**. Docs (PRD §5, ARCH §4.4, PRODUCTION_INFRA, UI_WALKTHROUGH) already describe the 24/7 roll.

M0 is **not** closed. G1–G10 and G12 are localnet-green (`make m0`). **G11 and the signed go/no-go (#17) are still open.** The user directed building the V1 program → services → frontend on localnet anyway. Do not pretend ADR-0020 is satisfied.

## What is true right now (2026-08-22)

- Branch: `main` → `origin/main` @ `de57f99` (Pyth chain `1198968`…`de57f99` landed; ADR-0033 #22 change landed in `c99e7a1`).
- Uncommitted in the main checkout: doc/README/.env.example/.cursor rewrites (being reconciled to the Pyth track, ADR-0034).
- `make demo` brings up validator + seed + indexer `:8787` + keeper + market-maker + frontend `:3100`.
- `make build-devnet` exists and is closed as #23 (strict, no `localnet` feature, writes a manifest).
- `make demo-devnet` exists as a **seed** (`DEMO_MODE=devnet` + `resolveSeedConfig`). It is not a clean-clone E2E and does not replace `make oracle-e2e-devnet`.
- Meridian tests last recorded: foundation 6/6, trading 5/5 (includes Sell No), settlement 4/4 (includes feed owner-pin).
- Frontend: dark theme; `/` → `/markets`; Trade is the 3-column mockup; Mint/Redeem-pair buttons removed from the slip; Admin is a localnet console.
- Keeper is still a 5s poll that writes the harness mock feed. Production shape is ADR-0031 (issues #19–#21).
- **Pyth adapter (#16, synthetic-demo track) is proven through Meridian settlement on localnet** (2026-08-22, `de57f99`): `make pyth-settle-e2e` — Pyth-cloned validator → seed `DEMO_ORACLE=pyth` → keeper `KEEPER_ORACLE=pyth` (Hermes pull → post PriceUpdateV2 → adapter crank → finalize → settle); record close == real Pyth close (GOOGL $344.73, TSLA $362.80), 10/10 settled, keeper's advisory arg ignored (A1 holds under real data). Adapter `Egc4yk…`; devnet wiring = deploy adapter + `scripts/register-pyth-transports.ts`. **Not G11**: Pyth equity is a last trade, not the Nasdaq Official Close — the Official-Close provider (#9) + `oracle-e2e-devnet` remain.
- Identity-drift monitor is #25 (new).
- `.gitignore` and `.env.example` exist. `wallets/` is gitignored.

## Working document stack

1. **`CONTEXT.md`** — glossary.
2. **`docs/adr/0001`–`0033`** — accepted decisions. 0031 keeper triggers; 0032 rolling creation; 0033 open-when-exists.
3. **`docs/ARCHITECTURE.md` v1.1.1** — accounts / CPI / services.
4. **`docs/PRD.md` v0.7.1** — product behavior. Header still says “full build pending gates”; engineering has moved past that sentence.
5. **`docs/PRODUCTION_INFRA.md`** — off-chain topology (scheduler, redundancy, secrets, observability). Several items still **[open]**.
6. **`docs/DEVNET_DEPLOY.md`** — localnet → M6 checklist.
7. **`docs/GOVERNANCE.md`** — Config roles, two-step rotation, upgrade authority, key custody.
8. **`docs/REQUIREMENTS.md`** — converted source spec; PDF remains upstream source of truth.

**Conflict rule:** implement to the v0.7.1/v1.1.1 freeze + ADRs. New contradictions still get called out explicitly. ADR-0033’s `validate_schedule` change is a documented redeploy; land it with `make build-devnet`, not the localnet feature.

## Active decisions to carry forward

- OpenBook V2 v1.7, no fork, MIT CPI/client only. Canonical `opnb2LAf…` with ADR-0030 monitored identity (not `upgrade_authority == None` on public clusters).
- One Yes/USDC Venue Market per Outcome Market. Sell No limit is not V1.
- Limits PostOnly; Market Actions full-fill-or-revert; fail closed.
- OutcomeMarket PDA is mint authority + vault owner + OpenBook admin (both `open_orders_admin` and `close_market_admin`).
- Trading opens at creation (`mint_open = creation`, `trade_open = creation + 30m`); close is still the NYSE Official Close (ADR-0033).
- Next session is created at resolution + 5m (ADR-0032). After `activity_started`, gap risk uses Emergency Expiry recovery, not `abandon_market`.
- Production keeper is scheduled jobs + heap subscription (ADR-0031). Do not promote the localnet poll.
- Directional Guardrail is UI from fresh Position State, not an on-chain token lock — **still to build**.
- Synthetic demo cannot satisfy settlement-correctness or provider-finality claims.
- Frontend lives under `frontend/`.
- Do not scaffold dormant fee or collateral-withdrawal switches.
- One oracle transport (ADR-0034, replaced Switchboard): the **Pyth adapter** (`programs/pyth-adapter`). Done + proven locally. A Pyth settle is still not G11 — Pyth equity prices are last trades, not the Nasdaq Official Close; G11 needs calibration against it via provider #9 + `make oracle-e2e-devnet` (docs/ORACLE_SETUP.md).

## Next steps (priority)

1. **#22 landed** (`c99e7a1`); nothing left but the devnet redeploy via `make build-devnet`.
2. **Close or explicitly leave #24 open** — seed path is on `main`; remaining work is ops (keys, funding, deploy) not more seed code.
3. **#16** — Pyth adapter loop is code-complete + proven locally (`make pyth-settle-e2e`). Remaining: devnet deploy + ADR-0030 identity capture of the adapter (ops), then the G11 half (Official-Close provider #9, `oracle-e2e-devnet`, calibration ADR).
4. **#25 identity-drift monitor** — ADR-0030 fail-closed alerting (DEVNET_DEPLOY Phase 7).
5. **#19 / #20 / #21** — replace the keeper poll with scheduled settlement + market-open jobs, subscription crank, and pre-open re-validation. Scheduling substrate is still **[open]** in PRODUCTION_INFRA.
6. Human-owned: #9 provider, #10 webhook, #11 Squads members, #15 Emergency Expiry disposition, #8 G2-devnet, #17 signed go/no-go.
7. Do not start a mainnet conversation. Do not invent Official Close from last trade.

## Open questions still owned by humans

- Official-Close provider (G11 go/no-go; Massive SIP + Alpaca SIP cross-check specified as calibration method) — #9.
- Alert webhook receiver before unattended operation — #10.
- Three M6 Squads members / create-key / published vault addresses — #11.
- Emergency Expiry in or out after G3 — #15 (ADR-0033 already depends on the recovery path for live-gap risk).
- Scheduling substrate for the production keeper (cron vs queue vs Temporal vs cloud scheduler) — PRODUCTION_INFRA §2.

## Considerations while building

- Prefer fail-closed over partial synthetic exposure.
- Collateral vault never pays SOL/rent/penalties.
- Never trust client-supplied OpenBook/market/vault/admin accounts.
- Operator hot key cannot pause issued markets, override, or touch collateral.
- HTTP settlement evidence is not on-chain-authenticated; Override Authority is a delayed price trust root.
- Use glossary terms in issues, tests, and UI copy. Markets page subtitle currently says “Binary contracts” — that is glossary drift.
- GitLab issues via `glab`; do not treat MRs as triage.
- `frontend/lib/meridian.ts` vs `@meridian/sdk` is a known post-v1 reconcile (#18); do not casually fork a third builder.
