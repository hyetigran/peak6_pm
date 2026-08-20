# Project Brief

## Name

**Meridian** (Gauntlet project title). Repo: `peak6_pm` on GitLab (`labs.gauntletai.com`).

A non-custodial Solana dApp for same-day (0DTE) binary Outcome Markets on MAG7 US-equity Official Closes.

## One-sentence pitch

Users trade fully collateralized Yes/No tokens on whether a supported stock’s Official Close is at or above a stated Strike, with one Yes/USDC Venue Market supplying price discovery for both perspectives.

## Goal

Ship a reproducible Solana **devnet** lifecycle: create → mint → trade all four Directional Intents → settle from one immutable Settlement Record → redeem. Correctness of the $1 payout complement and collateral solvency outranks feature breadth.

Two required demo paths (ADR-0028):

- `make demo-devnet` — labeled public-HTTPS **synthetic** Settlement Record (plumbing).
- `make oracle-e2e-devnet` — real Nasdaq Official Close / provider proof (non-waiverable M0 gate).

## In scope (V1)

- MAG7 tickers: AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA.
- Same-day Outcome Markets: complementary Yes and No Tokens, 6-decimal classic SPL.
- Strike engine: ±3/6/9% from previous close, round to nearest $10, dedupe; **ATM (rounded prior close) enabled by default**.
- Operator may add a Strike intraday (`add_strike`) until `close_ts - 1800s`.
- One OpenBook V2 Yes/USDC Venue Market per Outcome Market. Four first-class intents: Buy Yes, Buy No, Sell Yes, Sell No.
- One canonical Settlement Record PDA per ticker and Trading Day, consumed by every Strike that day.
- Official Close = unadjusted primary-listing close; for V1 MAG7 this is **Nasdaq NOCP**.
- Delayed Manual Settlement Override: two agreeing evidenced values; program derives the winner.
- Frontend: Landing, Markets, Trade, Portfolio, History, with Directional Guardrail and Recovery-only Mode.
- Off-chain automation, EventHeap keeper, read-only indexer with History Completeness.
- Circle six-decimal Solana Devnet USDC as the quote mint.
- Permanent Arweave metadata published and verified before mint creation.

## Out of scope (V1)

- Mainnet / real funds for the core submission.
- KYC, custody, margin, lending, leverage, unsecured shorts.
- Sell No limit orders.
- Protocol fees and any treasury / surplus-withdrawal path.
- Recreating an Outcome Market identity after issuance.
- On-chain NYSE calendar (operator proposes bounded schedule; NYSE fixtures + Alpaca Calendar API off-chain).
- Custom CLOB; OpenBook V2 v1.7 is the approved venue.
- Outcome Markets on share-changing / identity-changing corporate-action days.
- Void/draw/last-price fallbacks when no Official Close exists (Settlement Disputed instead).

## Hard product invariants

1. One outcome-token atom corresponds to one USDC atom. Liability is supply-derived (`max(Yes, No)` while Unset; winning supply once set). Vault raw ≥ accounted Collateral Liability.
2. Yes payout + No payout = $1. Equality at the Strike belongs to Yes.
3. Tokens are created only via `mint_pair`. Meridian destroys tokens only through the Redemption family. Classic SPL Direct Holder Burn is unsupported forfeiture and is reconciled permissionlessly into ownerless Collateral Surplus.
4. Settlement is irreversible once written from the shared Settlement Record. Later provider corrections become incidents, not payout changes.
5. Meridian is the only order-creation gateway. `create_venue_market` is the only attachable venue path.
6. V1 Venue Markets have zero maker/taker fees and an unsignable fee-admin sentinel.

## Success criteria

- All four trade paths work on the Venue Market.
- Settlement pays the correct side from one record per ticker/day; the $1 invariant is never violated.
- Preflight at close−5m; earliest automated Settlement at close+20m (devnet); SLO incident at +25m.
- Frontend shows Live Underlying Price, mirrored Yes/No book, payoff sentence, Portfolio/History Completeness.
- Directional Guardrail uses Exposure Interval; Mixed/Unknown and missing indexed state fail closed for new Directional Intents.
- Clean-clone `make demo-devnet` succeeds; `make oracle-e2e-devnet` proves the real Official Close path.
- Final demo transfers program upgrade authority to a published Squads V4 2-of-3 vault PDA.
- Architecture and chain choices documented; no regulatory/compliance claims.

## Document authority

| Layer | Owns | Location |
| --- | --- | --- |
| Source specification | Product requirements (PDF is source of truth) | `docs/REQUIREMENTS.md`; also `design mockups/uploads/meridian-spec.md` |
| Reconciled product plan | Product behavior and acceptance | `docs/PRD.md` **v0.7** (SHA-256 `05410e441fd4ca9498dea512fad137f22be78d5839c47e2c1ddbe8705b7fccca`) |
| Implementation architecture | Component boundaries, CPI, accounts, services | `docs/ARCHITECTURE.md` **v1.1** |
| Domain glossary | Vocabulary; avoid listed synonyms | `CONTEXT.md` |
| Accepted decisions | Rounds 1–6 product/architecture decisions | `docs/adr/0001`–`0028` |

Accepted ADRs and the v0.7/v1.1 freeze are reconciled. Use `CONTEXT.md` terms. If new work contradicts an ADR, say so explicitly.

## Current phase

**M0 validation candidate.** Product decision frontier is empty. M0 (G1–G12) may begin. M1 and full build start only after a **signed go/no-go report**. No on-chain program, services, or app code yet.
