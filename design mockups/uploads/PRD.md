# Meridian — Draft Implementation Plan

**Version:** 0.3 (draft for adversarial review)
**Date:** 2026-08-19
**Spec:** `meridian-spec.md` (converted from the source PDF; PDF is source of truth)
**Decision status legend:** `ACCEPTED` (committed), `PROPOSED` (recommended, awaiting sign-off), `OPEN` (needs stakeholder input)

**Changelog v0.1 → v0.2** (stakeholder directives, 2026-08-19):
1. Fees: maker, taker, and claim fee **switches added**, all initialized to 0 (ADR-006 revised; new invariant I5).
2. Venue: **Phoenix Legacy first**; BookLite (custom CLOB) becomes a stretch milestone M7 behind the same `Venue` seam (ADR-003 revised; ADR-009 reworked around Phoenix time-in-force orders).
3. Oracle: **Switchboard only** — Chainlink parallel track dropped, single-vendor simplicity (ADR-002 now `ACCEPTED`).
4. Token metadata: **Metaplex Token Metadata required** at market creation (ADR-005 revised).
5. Frontend: **@solana/kit exclusively** — no `@solana/web3.js`, no Metaplex Umi in the app bundle (new ADR-012). *(Superseded in v0.3.)*

**Changelog v0.2 → v0.3** (stakeholder directive, 2026-08-19):
6. Frontend framework reversed: **Metaplex Umi** replaces `@solana/kit` (ADR-012 rewritten). `phoenix-sdk` is now used directly in the app through Umi's web3.js adapters — the Kit codec port and its byte-equality test suite are deleted from scope (old R4 retired) — and web3.js v1 is accepted as Umi's documented underlying dependency. The single-framework import ban flips to exclude `@solana/kit`.

---

## 1. Executive Summary

Meridian is a non-custodial dApp for 0DTE binary outcome contracts on MAG7 daily closes: Yes/No SPL tokens fully collateralized by USDC ($1.00 per pair), traded on one order book per strike, settled at 4:00 PM ET by an on-chain oracle read, redeemable indefinitely.

Stack: **Solana devnet + Anchor (Rust)** for the Meridian program (markets, collateral vault, settlement, fee switches); **Phoenix Legacy** as the trading venue — one Phoenix market per strike, with the Phoenix Seat Manager as market authority so limit-order seats are claimed permissionlessly and atomically, and with time-in-force expiry (`last_valid_unix_timestamp = close_ts`) on every UI order so the book self-freezes at market close; **Switchboard On-Demand** as the sole oracle (behind a thin adapter whose only other implementation is a test mock); **Metaplex Token Metadata** attached to every Yes/No mint; a **Metaplex Umi** Next.js frontend (wallets via `@solana/wallet-adapter` lifted into Umi with `walletAdapterIdentity`, a Codama-generated Umi client for Meridian, and `phoenix-sdk` used directly through Umi's web3.js adapters); and TypeScript **automation** + **indexer** services in the same monorepo. The single-framework rule is now Umi-side: no `@solana/kit` in the app (ADR-012).

Fees are first-class but dormant: config carries `maker_fee_bps`, `taker_fee_bps`, and `claim_fee_bps`, all **0 initially**, routed to a dedicated fee treasury that never touches the collateral vault — so the spec's exact `$1.00 × pairs` vault invariant holds unconditionally. One honestly-documented constraint: **Phoenix has no maker fees by design**, so the maker switch stays dormant until the BookLite stretch venue ships (§4 ADR-006).

The custom CLOB remains the stated learning goal: its full 99-tick design is preserved as Appendix D and scheduled as stretch milestone M7, slotting in behind the same venue seam Phoenix occupies.

Everything traces to the spec via the matrix in §17.

---

## 2. Verified Landscape (as of 2026-08-19)

Load-bearing external facts, each verified against current sources this week. Re-verify anything older than ~30 days at implementation time.

| # | Finding | Consequence | Source |
|---|---------|-------------|--------|
| F1 | Pyth Core moved to mandatory paid subscriptions + API keys on **2026-07-31** (plans from $500/mo; US equities quoted at $5,000/mo tier). | Pyth is out of scope for this project. Context retained because reviewers will ask "why not Pyth". | pyth.network/blog/the-pyth-core-upgrade; …/extended-hours-us-equity-data-moves-to-pyth-pro |
| F2 | Chainlink's US-equity data on Solana exists only via **Data Streams** (allowlist-gated, "contact us"); its push Data Feeds catalog on Solana is crypto-oriented. | Confirms the stakeholder decision to skip Chainlink: the frictionless push-feed path never existed for equities, and the gated path is now explicitly not pursued. | docs.chain.link/data-streams/tutorials/solana-onchain-report-verification; docs.chain.link/data-feeds/solana |
| F3 | **Switchboard On-Demand** is permissionless on Solana devnet: custom feeds (HTTP fetch + JSON parse tasks), cranked via managed-update instructions, read on-chain from `PullFeedAccountData` with `max_stale_slots` and `min_samples` guards. | Satisfies the spec's on-chain read + staleness + quality checks at zero cost, no allowlist. **Sole production oracle.** | docs.switchboard.xyz (Solana/SVM price feeds); github.com/switchboard-xyz/sb-on-demand-examples |
| F4 | **Phoenix Legacy is deployed on Solana devnet and mainnet-beta** at `PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY`; market creation is **permissionless**; MIT-licensed, OtterSec-audited, verifiable build. | Devnet requirement satisfied; we can create ~dozens of markets per day ourselves; program can be dumped and cloned into localnet for tests. | ellipsis-labs.gitbook.io (Phoenix docs); github.com/Ellipsis-Labs/phoenix-v1 |
| F5 | Phoenix fee model: **"There are no maker fees. Taker fees are charged on the quote lots transacted, in basis points"** — `taker_fee_bps` is set per market at initialization; fees accrue in the market in quote tokens; a `CollectFees` instruction pays them to the market's `fee_recipient` (set at creation; changeable only by the market authority). | Our taker switch maps 1:1 onto Phoenix market creation; our maker switch is **unenforceable on Phoenix** and stays dormant until BookLite; claim fee is enforced in our own `redeem`. | Phoenix docs: Key Structures, Market Maker Overview, Events (`CollectFees`) |
| F6 | Phoenix seats: a Seat (per trader per market) is required for `PlaceLimitOrder`; plain `Swap` (IOC/market orders) requires **no seat**. When the **Phoenix Seat Manager program is the MarketAuthority, "claiming seats and placing limit orders are permissionless and can be performed atomically."** Seats can be evicted when trader state is at capacity. | Making the Seat Manager our markets' authority preserves the spec's one-approval limit-order UX (claim-seat ix prepended in the same transaction). Trade-off: we forfeit authority actions (book pause, later fee-recipient changes) — accepted, see ADR-003/009/010. | Phoenix docs: Seats, Seat Manager Program |
| F7 | Phoenix resting orders carry optional **time-in-force**: `last_valid_slot` / `last_valid_unix_timestamp_in_seconds`; expired orders are cancelled on match and their funds freed. All market events (Place/Fill/Reduce/Evict/FillSummary incl. fees/Expired) are logged on-chain via self-CPI and parseable via the SDK. | TIF = `close_ts` on every UI order makes the book **self-freezing at 4:00 PM without any authority action**. Events give the indexer everything needed for History and P&L. | Phoenix docs: Key Structures, Events |
| F8 | Phoenix is in **"Legacy"** status — active Ellipsis development moved to Phoenix Perpetuals/Atlas; the spot program remains live and is the documented integration target. | Fine for a devnet project; maintenance-mode risk noted (R11). Also strengthens the case for eventually owning the venue (M7). | solanacompass.com/projects/Phoenix; ellipsislabs.xyz |
| F9 | Current Solana frontend standard: **`@solana/kit`** with Wallet Standard discovery via `@solana/kit-plugin-wallet` + `@solana/react` hooks (Kit does not use wallet-adapter); **Codama-first client generation** (generated TS clients target Kit by default); LiteSVM/Mollusk for unit tests, Surfpool for fork-based integration tests; web3.js v3 RC exists only as a legacy-interop bridge — "new apps should build directly on Kit." | Recorded so ADR-012's Umi choice is made with the ecosystem default explicitly on the table (trade-off logged there). Still gives us two clean options for running Phoenix locally in tests (genesis clone or Surfpool fork). | solana.com/docs/frontend; solana.com/docs/frontend/web3-compat; github.com/solana-foundation/solana-dev-skill |
| F10 | **Umi stack composition (current):** the default bundle "relies on web3.js for some of the interfaces"; wallet connection is `@solana/wallet-adapter-react` adapted via `walletAdapterIdentity` (`umi-signer-wallet-adapters`); `umi-web3js-adapters` converts web3.js instructions/types ↔ Umi. Packages actively published (1.5.x line). | Choosing Umi means web3.js v1 + wallet-adapter ride underneath **by design** — and it means `phoenix-sdk` instructions drop straight into Umi transactions via the adapters, deleting v0.2's riskiest port task. | developers.metaplex.com/umi/getting-started; metaplex.com/docs (Core SDK FAQ); npm: umi-signer-wallet-adapters, umi-web3js-adapters |

---

## 3. Scope

**In scope (V1, devnet):** everything in the spec's "Required: Testnet Deployment" and "What Does Success Look Like" — full daily lifecycle for 7 tickers × 5–7 strikes; all four trade paths on one Phoenix book per strike; Switchboard settlement with staleness + quality checks; admin override with time delay; pause; indefinite redemption; fee switches (maker/taker/claim) at 0 with a separate treasury; Metaplex metadata on every mint; frontend (Landing, Markets, Trade, Portfolio, History) on pure Kit; automation + indexer; tests per spec; reproducible devnet scripts; `make dev`; risks/limitations note.

**Out of scope (V1):** mainnet (bonus — §13.4), KYC/geo-fencing, margin, non-USDC collateral, multi-day expiries, governance/multisig admin (documented as a production requirement), sub-cent ticks, hosted metadata JSON/images (name+symbol only in V1 — §16-Q6). **Stretch (M7):** BookLite custom CLOB per Appendix D, which also activates the maker-fee switch.

---

## 4. Architecture Decision Records

### ADR-001 · Chain & framework — `ACCEPTED`
Solana devnet, Rust, **Anchor** (current 1.1.x line per F9, version pinned; program/client mismatch is a known footgun). Anchor's account constraints reduce the validation-bug surface that dominates Solana exploits. IDL published; Codama generates the Kit client from it.

### ADR-002 · Oracle: Switchboard On-Demand, sole vendor — `ACCEPTED` (stakeholder, 2026-08-19)
**Context:** Spec requires an on-chain settlement read with staleness + confidence checks, plus a morning previous-close read (off-chain permitted). F1–F3. Stakeholder: "use Switchboard and keep things simple instead of trying to get multiple providers."
**Decision:** One Switchboard On-Demand feed per ticker (7 feeds), defined with a **single primary stock-data HTTP source** (env-configured; candidate free tiers in §16-Q3). The program reads `PullFeedAccountData` through a thin `OracleAdapter` seam whose only other implementation is `MockOracle` for tests — this is testing infrastructure, not multi-vendor hedging. Quality check = Switchboard's `min_samples` + `max_stale_slots`, plus a program-side sanity band (reject settlement price deviating > `max_price_band_bps` from the stored previous close → forces the override path).
**Consequences & documented caveats:** data provenance is a retail-grade API rather than exchange-licensed data (fine for devnet; risks note); a single API source is a single point of failure at 4:00 PM — mitigated by the retry window, the sanity band, and the admin override; adding a second source to the feed's job list later is a config change, not a code change (noted as post-V1 hardening, not built now).
**Revisit trigger:** primary API source proves flaky in M3 burn-in.

### ADR-003 · Venue: Phoenix Legacy first; BookLite stretch — `ACCEPTED` (stakeholder, 2026-08-19)
**Decision:** One **Phoenix market per strike** (base = that strike's Yes mint, quote = USDC), created permissionlessly by automation each morning. Key integration choices, each verified against F4–F7:
- **Authority = Phoenix Seat Manager program** at creation → seat claims are permissionless and atomic with order placement, preserving the spec's one-approval UX for limit orders (frontend prepends a claim-seat instruction the first time a wallet quotes a given market). Trade-off accepted: we cannot later pause that Phoenix market or change its `fee_recipient` (mitigations in ADR-009/010; `fee_recipient` is set correctly at creation, before authority matters).
- **`taker_fee_bps`** at market creation ← `Config.taker_fee_bps` (0 initially). Because Phoenix fixes it at init, fee changes roll out with the **next day's markets** — a natural, clean rollout given daily market creation. `fee_recipient` ← our fee treasury.
- **Market size params** initial guess `{bids: 512, asks: 512, seats: 128}` — generous seat count reduces eviction risk (F6); exact rent measured in M0 and tuned. Phoenix markets have no close/reclaim path in the documented instruction set → daily rent is burned; `DEV_PROFILE` (3 strikes/ticker) and small size params keep the devnet faucet budget sane (§7.7).
- **Testing:** Phoenix + Seat Manager programs dumped from devnet (`solana program dump`) and cloned into the local validator genesis (or run under a Surfpool fork, F9) so the full lifecycle runs in CI without touching devnet.
- **`Venue` seam retained:** Meridian stores a venue enum + address per market; instruction-building lives in one frontend/automation module. BookLite (Appendix D) slots in at M7 and, when it does, activates maker fees and on-chain trading gates.
**What Phoenix buys us:** audited matching, zero matching-engine code, instant crankless settlement, on-chain event logs. **What it costs us:** no maker fees (ADR-006), no book pause, seat/eviction mechanics, per-market rent, and a two-program integration surface.

### ADR-004 · Collateral / quote — `PROPOSED`
Devnet **USDC** (Circle faucet) as default quote mint; mint is a config parameter so localnet tests and a `DEV_QUOTE=mock` profile use a program-minted 6-decimal token. 1 pair = 1_000_000 base units.

### ADR-005 · Token standard & metadata — `ACCEPTED` (metadata per stakeholder, 2026-08-19)
Classic **SPL Token** mints (wallet/Phoenix compatibility), decimals 6, mint authority = market PDA, no freeze authority. **Metaplex Token Metadata is created for both mints inside `create_strike_market` via CPI** (`anchor-spl` metadata / `mpl-token-metadata` Rust crate — metadata stays program-side and atomic with creation regardless of frontend framework; a side benefit of the Umi frontend (ADR-012) is that richer client-side metadata reads come free later via Metaplex's Umi clients). Naming: name `"{TICKER} {STRIKE} YES|NO {YYYY-MM-DD}"` (≤32 chars for all MAG7 — longest is `GOOGL 220 YES 2026-08-19` at 24), symbol `YES`/`NO`, URI empty in V1 (§16-Q6). Adds two CPIs + two metadata accounts (~0.01 SOL each) per market — included in the §7.7 budget.

### ADR-006 · Fees: three switches, zero initially — `ACCEPTED` (stakeholder, 2026-08-19)
**Decision:** `Config` carries `maker_fee_bps`, `taker_fee_bps`, `claim_fee_bps` (`u16`, each capped at `MAX_FEE_BPS`, proposed 500 — §16-Q7), all **initialized to 0**, plus a `fee_authority` PDA owning a dedicated **fee treasury** token account. Per the spec's invariant clause, fees go to a *separate* account — the treasury never intersects any collateral vault.
- **Taker fee:** enforced by Phoenix (`taker_fee_bps` at market creation, F5); accrues inside the Phoenix market in USDC; automation cranks Phoenix `CollectFees` daily → treasury. Changes take effect with the next day's markets (immutable per Phoenix market once created — documented).
- **Claim fee:** enforced in Meridian's `redeem`: `fee = floor(gross × claim_fee_bps / 10_000)` → treasury; user receives `gross − fee`. Floor rounding (user-favorable) is deterministic and documented. The vault is debited **gross** — its math never sees fees.
- **Maker fee:** parameter exists but is **dormant on Phoenix, which has no maker fees by design (F5)**. It becomes enforceable when the BookLite venue ships (M7). This gap is stated plainly rather than papered over; if maker fees must be live in V1, the venue decision has to be revisited (§16-Q7).
- **`merge_pair` is fee-free:** it is a par unwind, and the Sell-No composite must net exactly `$1 − Yes cost` per the spec's "$1.00 worth of redeemable USDC" framing. Confirm in §16-Q4.
- `set_fees` is admin-gated, event-emitting, and cap-checked.
**Invariant impact:** none on I1 — see §7.5 I5 (fee separation) for the formal statement.

### ADR-007 · Settlement price semantics — `PROPOSED`
Settlement price = the oracle's report of the stock's last regular-session trade at/after 16:00 ET (not the official closing-auction print, which can differ by cents and lands minutes later — documented, R1). At-or-above → Yes wins, compared in 1e6 fixed point. **Validity window anchored to `close_ts`, not wall clock:** accept a read whose publish time ∈ `[close_ts − 60s, close_ts + settle_window]` (default 900s). This anchoring makes settlement deterministic, re-runnable, and demoable outside market hours (§13.3).

### ADR-008 · `merge_pair` — spec gap, resolved — `PROPOSED`
The spec's Sell-No story requires closing a Yes+No pair for $1.00, but its function list has no instruction for it. We add **`merge_pair`** (burn 1 Yes + 1 No → withdraw $1.00, any time, before or after settlement), classified as *pair redemption* so the spec invariant "tokens can only be destroyed via the redeem function" holds under redeem ∈ {pair-redeem anytime, single-sided post-settlement}. Confirm reading in §16-Q1.

### ADR-009 · Order lifecycle at close & settlement — `PROPOSED` (reworked for Phoenix)
- **Freeze-at-close via time-in-force:** every limit order our UI (and automation, if it ever quotes) places carries `last_valid_unix_timestamp_in_seconds = close_ts` (F7). At 4:00 PM all such orders are dead — swaps find no live liquidity, so the book self-freezes with no authority action. Meridian's own gates independently stop `mint_pair` at `close_ts`.
- **Known gap, stated:** a direct-client user bypassing our UI can rest a no-TIF order past close, and another direct-client user could hit it post-close. This trades value between two consenting UI-bypassers on a known outcome; it cannot mint new pairs (our gate) or touch settlement. Accepted limitation (R6).
- **Post-settlement escrow release:** expired orders' funds are freed by the owner's cancel (Phoenix cancels never fail — they skip missing orders, F7-adjacent SDK behavior). There is **no third-party sweep on Phoenix** (cancel is owner-only), so the frontend bundles `CancelAllOrders` + `WithdrawFunds` + `merge_pair`/`redeem` into the one "Claim" transaction on the Portfolio page. Cancel/withdraw are available always — during pause, after close, after settlement.

### ADR-010 · Pause semantics — `PROPOSED`
Meridian's pause (global + per-market flag) blocks `mint_pair` and the mint leg of Buy-No. It never blocks `merge_pair`, `redeem`, Phoenix cancels, or withdrawals — users can always exit. **We cannot pause a Phoenix book** (authority is the Seat Manager, ADR-003); in an emergency, halting minting caps exposure at already-minted pairs, whose $1 collateral is already vaulted. Documented as the accepted trade-off for permissionless seats.

### ADR-011 · Position constraints — `PROPOSED`
Enforced in the **frontend** exactly as the spec directs (balance check → guided "exit first" flow). Airtight on-chain enforcement is impossible with freely transferable SPL tokens (any wallet can hold both via transfer); holding both is economically harmless (= $1 redeemable). Documented in the risks note (R8).

### ADR-012 · Frontend stack: Metaplex Umi — `ACCEPTED` (stakeholder, 2026-08-19; supersedes the v0.2 Kit decision)
**Context:** v0.2 specified pure `@solana/kit`. Stakeholder preference is Umi. The ecosystem default for new apps is Kit (F9); Umi is Metaplex's actively maintained client framework whose standard composition sits on wallet-adapter and web3.js v1 (F10). This ADR records the choice and its trade-offs explicitly so review doesn't mistake it for drift.
**Decision:** the app is built on **`@metaplex-foundation/umi`** with `umi-bundle-defaults`. Wallets: `@solana/wallet-adapter-react` lifted into Umi via `walletAdapterIdentity` (`umi-signer-wallet-adapters`); Wallet Standard wallets are covered through wallet-adapter's standard-wallet support. Program clients:
- **Meridian:** Codama-generated **Umi** client from our Anchor IDL (Codama's Umi renderer is the same pipeline Metaplex uses for its own clients). M0 validates generation; the fallback — hand-written Umi builders for our ~10 instructions — is trivial for a program this small.
- **Phoenix:** **`phoenix-sdk` used directly in the app.** Its web3.js `TransactionInstruction`s convert with `fromWeb3JsInstruction` (`umi-web3js-adapters`, F10) and compose in Umi's `transactionBuilder()` alongside Meridian instructions — one signature per Appendix-A composite. This **deletes v0.2's codec-port task and byte-equality suite outright: we now ship the reference encoder itself.**
- **Single-framework discipline retained, direction flipped:** ESLint `no-restricted-imports` in `app/` bans `@solana/kit`, and confines direct `@solana/web3.js` imports to one adapter boundary module — all other app code speaks Umi types. web3.js v1 remains underneath by design (F10); that is the accepted trade-off, not an accident.
- **Read path unchanged:** the indexer serves the normalized ladder over REST/WS; no Phoenix header-dispatch deserialization runs in the browser.
**Trade-offs logged for reviewers:** (+) reference Phoenix encodings with zero port risk; (+) stakeholder familiarity/velocity; (+) native alignment with the Metaplex metadata tooling already in the program. (−) builds on the legacy-track stack while solana.com steers new apps to Kit (F9) — migration debt is deferred, not avoided; (−) heavier bundle (web3.js v1 + wallet-adapter + phoenix-sdk), sanity-checked in M0.
**Revisit trigger:** post-V1; or if Metaplex ships a Kit-native default bundle.

---

## 5. System Architecture

```
 Stock API (1 source) ─▶ Switchboard oracles ─▶ feed accounts (devnet)
        │                                            ▲ read in settle ix
        ▼                                            │
 ┌────────────┐  create/attach/settle/collect  ┌─────┴──────────────────────────┐
 │ Automation │───────────────────────────────▶│ Solana devnet                  │
 │ (TS, cron) │                                │  ┌───────────┐  ┌────────────┐ │
 └────────────┘                                │  │ meridian  │  │ Phoenix    │ │
        │ alerts (webhook)                     │  │ program   │  │ Legacy +   │ │
        ▼                                      │  │ config/   │  │ Seat Mgr   │ │
                                               │  │ markets/  │  │ 1 market   │ │
 ┌────────────┐   REST/WS (book, history,      │  │ vaults/   │  │ per strike │ │
 │  Indexer   │◀──events from BOTH programs────│  │ fees/     │  └────────────┘ │
 │ (WS→SQLite)│                                │  │ metadata  │                 │
 └─────▲──────┘                                │  └───────────┘                 │
       │                                       └───────▲────────────────────────┘
       │ ladder/P&L/history                            │ Kit txs (wallet-signed)
 ┌─────┴────────────────────────────────────────────────┴───┐
 │ Next.js app — Metaplex Umi + wallet-adapter + Codama Umi │
 │ client (meridian) + phoenix-sdk via umi-web3js-adapters  │
 └──────────────────────────────────────────────────────────┘
```

**Daily flow:** 08:00 ET automation reads previous closes → strikes → 08:30 per strike: create Phoenix market (Seat Manager as authority, `taker_fee_bps`, `fee_recipient`=treasury) → `create_strike_market` (mints + metadata + vault) → `attach_venue` (validates the Phoenix header on-chain) → 09:00 minting opens → 09:30 trading opens → 16:00 `close_ts`: TIF kills resting orders, minting gate shuts → automation cranks each ticker's feed + settles every strike (retry loop) → daily `CollectFees` crank → users cancel/withdraw/redeem.

---

## 6. Units, Precision & the Phoenix Parameterization

Meridian-side constants:

| Quantity | Representation |
|---|---|
| USDC / payouts | `u64`, 1e6 base units; 1 pair = 1_000_000 |
| Yes/No quantity | `u64` at 6 decimals; trading lot = 1 whole token |
| Strike | `u64`, 1e6 units, multiple of 10_000_000 ($10) |
| Oracle price | normalized to 1e6, checked math, no floats on-chain |
| Time | unix seconds; `mint_open_ts`, `trade_open_ts`, `close_ts` stored per market (ET/DST resolved off-chain at creation) |
| Day key | `u32` YYYYMMDD (PDA seed) |

Phoenix market parameters (derived per the Phoenix Units doc, F4/F7; validated on-chain by `attach_venue`):

| Phoenix param | Value | Meaning |
|---|---|---|
| base mint / decimals | Yes mint / 6 | one market per strike, Yes vs USDC |
| `raw_base_units_per_base_unit` | 1 | 1 base unit = 1 Yes token |
| base lot size | 1_000_000 atoms | lot = 1 token → `base_lots_per_base_unit` = 1 |
| quote lot size | 100 atoms | $0.0001 |
| `tick_size_in_quote_lots_per_base_unit` | 100 | tick = $0.01 → **price in ticks = price in cents** |

Worked check: 65 ticks × 100 quote lots × 1 base lot = 6,500 quote lots = 650,000 atoms = **$0.65 exactly** — all notionals are exact, zero rounding dust. Phoenix's own invariant (tick size must be an integer multiple of base lots per base unit) holds trivially (100 × 1). The UI constrains entry to 1–99 ticks; Phoenix itself doesn't bound price below $1.00, so an off-UI quote above par is possible and economically irrational — noted, harmless.

---

## 7. On-Chain Program Design (Meridian)

### 7.1 Accounts & PDAs

| Account | Seeds | Size | Contents |
|---|---|---|---|
| `Config` | `["config"]` | ~260 B | admin + pending_admin (2-step), quote_mint, paused, **maker_fee_bps / taker_fee_bps / claim_fee_bps + MAX_FEE_BPS cap**, fee_authority bump, oracle params (`settle_window_secs`, `pre_close_tolerance_secs`, `admin_override_delay_secs`=3600, `max_price_band_bps`=2000, `min_samples`, `max_stale_slots`) |
| `FeeTreasury` | ATA(fee_authority PDA, quote) | 165 B | all fee flows; **never** a collateral account |
| `Market` | `["market", ticker u8, strike le, day le]` | ~420 B | ticker, strike, day, prev_close_1e6, `mint_open_ts`/`trade_open_ts`/`close_ts`, state (`PendingVenue → Active → Settled`), outcome, settle_price, settled_ts, admin_settled, yes_mint, no_mint, vault, **phoenix_market + venue enum**, feed pubkey, pairs_outstanding, creator, paused_flag, bumps |
| `yes_mint`/`no_mint` | `["yes"|"no", market]` | 82 B ea | SPL mints, authority = market PDA; **Metaplex metadata PDA created for each** (ADR-005) |
| `vault` | ATA(market, quote) | 165 B | pair collateral only |

Uniqueness: `(ticker, strike, day)` is enforced at the PDA level. Ticker codes are a fixed enum validated against config.

### 7.2 Instruction Set

| Instruction | Caller | Gates | Effect |
|---|---|---|---|
| `initialize_config` | deployer→admin | once | Config + fee treasury |
| `set_fees` / `set_params` / `transfer_admin` / `accept_admin` | admin | fee caps; events | governance |
| `create_strike_market` | admin (automation) | not paused; strike $10-multiple; unique | Market (state=`PendingVenue`), mints, **metadata ×2 via Metaplex CPI**, vault |
| `attach_venue(phoenix_market)` | admin (automation) | state=`PendingVenue`; **validates Phoenix header on-chain**: account owner = Phoenix program, base mint = yes_mint, quote = config.quote_mint, lot/tick params = §6 table, `taker_fee_bps` = config value, `fee_recipient` = treasury | state=`Active`; stores venue |
| `add_strike` | admin | `now < close_ts` | same two-step flow intraday |
| `mint_pair(amount)` | anyone | `mint_open_ts ≤ now < close_ts`; not paused; state=Active | USDC→vault; mint Yes+No |
| `merge_pair(amount)` | holder | **always** (state ≥ Active) | burn Yes+No → withdraw USDC, fee-free (ADR-006/008) |
| `settle_market` | **anyone** (automation primary) | `now ≥ close_ts`; Active; oracle checks §7.4 | writes price + outcome (`price ≥ strike → YesWins`); immutable |
| `admin_settle(price)` | admin | `now ≥ close_ts + delay`; Active | manual outcome; `admin_settled=true`; loud event |
| `redeem(amount, side)` | holder | Settled | winning: vault debits gross; **claim fee → treasury, remainder → user**; losing burns for 0 |
| `pause`/`unpause` | admin | — | gate list per ADR-010 |

All order-book actions (`Swap`, `PlaceLimitOrder` w/ TIF, cancels, `WithdrawFunds`, seat claim) and `CollectFees` are **Phoenix instructions**, composed client-side (ADR-012) or by automation — they are not Meridian instructions. Composites are single **transactions**, one signature: e.g. Buy-No-market = `[mint_pair, phoenix.Swap(sell Yes)]` (Appendix A). Permissionless `settle_market` is deliberate: liveness doesn't depend on our key when anyone can present a valid oracle read.

### 7.3 State machine
`PendingVenue → Active → Settled` (terminal). Time-window behavior (pre-mint / minting / trading / frozen) derives from clock vs stored timestamps — no crank to freeze. Pause is an overlay flag.

### 7.4 Oracle validation (settle path)
1. Feed pubkey == `market.feed` and account owner == Switchboard program (blocks feed-substitution).
2. Publish time ∈ `[close_ts − pre_close_tolerance, close_ts + settle_window]` (ADR-007).
3. `get_value(clock, max_stale_slots, min_samples, only_positive)` must succeed; plus sanity band `|price − prev_close|/prev_close ≤ max_price_band_bps` (band breach → error → retries → override path).
4. `price > 0`; checked normalization to 1e6.
Automation bundles `[Crossbar managed-update ix(s), settle_market]` in one transaction; one feed per ticker serves all its strikes.

### 7.5 Invariants & enforcement

| # | Invariant | Statement | Enforcement |
|---|---|---|---|
| I1 | Vault exactness (spec) | Pre-settle: `vault = yes_supply×$1 = no_supply×$1`. Post-settle: `vault = winner_supply×$1`. Redeem debits **gross**; merge debits par. | mint/burn authority = market PDA; only `mint_pair`/`merge_pair`/`redeem` touch supply/vault; checked math; asserted after every op in tests |
| I2 | Payout complement (spec) | Yes + No payout = $1.00 for every settlement price, incl. `price == strike` | binary outcome enum; exhaustive tests |
| I3 | Creation/destruction paths (spec) | created only in `mint_pair`; destroyed only in `merge_pair`/`redeem` | ADR-008 classification; authority isolation |
| I4 | Settlement immutability (spec) | outcome written once | terminal state; no mutating ix |
| I5 | **Fee separation (spec: "fees to a separate account")** | Treasury receives exactly: Σ claim fees + Σ Phoenix `CollectFees` sweeps. No fee value ever enters/leaves a collateral vault; with all switches at 0, treasury inflow = 0. | claim-fee split inside `redeem` (single ix, both legs); Phoenix `fee_recipient` = treasury validated in `attach_venue`; test: fuzz redeem amounts at 0 and nonzero bps, assert `user + fee = gross` and I1 |
| I6 | Venue integrity | The attached Phoenix market matches §6 params and our mints/fee config | `attach_venue` header validation; escrow/matching safety inside the venue is delegated to the audited Phoenix program |

### 7.6 Events & errors
Anchor events: `MarketCreated`, `VenueAttached`, `PairMinted`, `PairMerged`, `MarketSettled{price, outcome, admin_settled}`, `Redeemed{gross, fee}`, `FeesChanged`, `Paused/Unpaused`, `ParamsChanged`. Trading events come from Phoenix's on-chain log (F7) — the indexer merges both streams. Distinct error codes for every gate (no generic errors).

### 7.7 Compute & rent budgets (estimates; measured in M0/M2 with CI regression checks)
CU targets: `mint_pair`/`merge`/`redeem` < 120k (token CPIs); `create_strike_market` < 400k (mints + 2 metadata CPIs — may split metadata into a paired ix if it busts budget; decided by measurement, not guessing); `settle` < 150k + crank ixs; client-composed composites are bounded by Phoenix's own budgets.
Rent per strike/day: Meridian accounts ~0.01 SOL + metadata ~0.02 SOL + **Phoenix market (size `{512,512,128}`) — measured in M0, no documented close/reclaim path** → daily burn is Phoenix-dominated. `DEV_PROFILE` (3 strikes/ticker ⇒ 21 markets/day) + a faucet top-up script keep devnet viable; the measured table goes in the README (R5).

### 7.8 Security checklist
Anchor constraints on every account; documented PDA seeds; checked math only; oracle account identity checks; **Phoenix header validation in `attach_venue` and re-validation of the market key anywhere it's referenced**; no arbitrary CPIs (Metaplex + SPL Token only, fixed program IDs); exits never pausable; admin ops event-emitting; 2-step admin transfer; devnet upgrade authority = deployer with a written mainnet-multisig note; `cargo audit` + `clippy -D warnings` in CI; ESLint import ban in `app/` (ADR-012).

---

## 8. Strike Engine (off-chain, `common` package)
For each offset in config (`[±300, ±600, ±900]` bps — "user-determined intervals" per spec): `strike = round_half_up(prev_close × (1 + bps/1e4) / 10) × 10` in 1e6 fixed point; dedupe (spec's AAPL example); optional ATM strike (default on, §16-Q2). Previous close: same API source the oracle feed uses, queried directly at 08:00 (spec allows off-chain here); stored on the Market as `prev_close_1e6` feeding the §7.4 band. Unit tests pin the spec's META and AAPL examples verbatim plus half-up boundaries. "Admin can adjust" = `add_strike`; existing strikes are immutable once tokens can exist (documented interpretation).

## 9. Automation Service (`services/automation`)
Node 20+/TS; `luxon` for `America/New_York` (DST-safe); tz-aware cron. **Calendar module** (in `common`, unit-tested): 2026–27 NYSE holidays **and 1:00 PM early closes** — `close_ts` per day comes only from here, so settle timing, TIF stamps, countdowns, and on-chain gates inherit early-close correctness by construction.
Jobs: **08:00** prev closes → strikes; **08:30** per strike: Phoenix create-market → `create_strike_market` → `attach_venue` (each step idempotent: derive/lookup before create; safe re-runs); **16:00** per ticker: `[feed crank, settle_market × strikes]`, retry every 30 s up to 15 min (spec numbers), then alert + arm override runbook; **16:20** `CollectFees` crank across the day's markets (no-op at 0 bps, exercised anyway so the path is proven). Ops: keypair via env, JSON logs, webhook alerts, `/healthz`, SOL-balance monitor + faucet top-up helper. **Override runbook** (`docs/runbooks/override.md`): wait out the 1 h gate, cross-check the official close from ≥2 independent sources, submit `admin_settle`, write the postmortem.

## 10. Indexer (`services/indexer`)
Ingests **both** event streams: Meridian Anchor events (`logsSubscribe`) and Phoenix market events (self-CPI logs parsed with `phoenix-sdk` server-side — permitted there, F7/ADR-012) → SQLite. Also decodes each Phoenix market account into a normalized ladder served over REST/WS to the app (ADR-012 read path). Endpoints: `/markets/:day`, `/book/:market` (+WS), `/history/:wallet`, `/positions/:wallet` (average-cost basis, documented). Backfill via `getSignaturesForAddress`. Exists because the spec's History page and entry-price P&L can't come from token balances; smallest thing that satisfies them, no third-party indexing service.

## 11. Frontend (`app`, Next.js + pure Kit)
Stack per ADR-012. Pages per spec: **Landing** (explainer, live ticker prices, connect CTA), **Markets** (7-ticker grid, live price, active-strike counts), **Trade** (strike list; order book in both perspectives — the No view is computed as `100 − ticks` with sides mirrored from the single ladder feed; four-action panel; payoff line "You pay $X. You win $1.00 if…"; countdown to `close_ts`), **Portfolio** (token-account positions + indexer cost basis; settled outcomes; one-click **Claim** = cancel-all + withdraw + merge/redeem per ADR-009), **History** (indexer log).
Mechanics: wallet-adapter connection lifted into Umi via `walletAdapterIdentity`; every action composed with Umi's `transactionBuilder()` — Meridian instructions from the Codama Umi client, Phoenix instructions from `phoenix-sdk` through `fromWeb3JsInstruction`; every limit order stamped with TIF = `close_ts`; first limit order per wallet per market transparently prepends the Seat-Manager claim-seat ix (atomic, F6); position constraints per ADR-011 with guided exit; market/limit variants for all four actions per Appendix A; explicit loading/empty/error states; devnet faucet helpers (SOL + USDC) in the UI.

## 12. Testing Strategy

| Layer | Tooling | Coverage |
|---|---|---|
| Strike engine | vitest | spec's META/AAPL examples verbatim; rounding boundaries; dedupe; ATM flag |
| Meridian program | Rust + **LiteSVM** | every instruction + gate in §7.2; settlement above/below/**exactly at** strike; I1 asserted after every op; **fee math fuzz at 0 and nonzero bps (I5: `user + fee = gross`)**; oracle matrix via `MockOracle` (fresh / stale / too-few-samples / out-of-band / wrong-feed-account / zero); override before vs after the 1 h delay; pause gate list (merge/redeem must still work); `attach_venue` header validation (wrong mint / wrong fee bps / wrong fee recipient / wrong lot params all rejected); metadata created with expected name/symbol |
| Venue integration | local validator with **Phoenix + Seat Manager cloned from devnet** (genesis clone or Surfpool fork, F9) | full lifecycle create→attach→mint→trade→settle→claim; **all four trade paths, market and limit**; seat claim atomic with first quote; TIF orders die at `close_ts` (warp clock); post-close swap finds no UI liquidity; cancel+withdraw+redeem bundle; `CollectFees` at 0 and at 5 bps; multi-user scenario (maker mints+quotes, taker takes, both redeem) — spec's named scenarios verbatim |
| Umi↔Phoenix adapter layer | vitest + localnet | every Appendix-A composite builds through `transactionBuilder()` (Codama Umi client + adapted `phoenix-sdk` ixs), simulates, and lands against cloned Phoenix — v0.2's byte-equality codec suite is moot now that the reference SDK itself ships (ADR-012) |
| Devnet E2E | `scripts/lifecycle-demo.ts` | real Switchboard crank; two funded wallets; balance-reconciliation table proving I1/I5 at each step |
| Frontend | vitest components + Playwright (mock wallet, local validator) | wallet connect; order placement/signing; both-perspective book; constraint enforcement; portfolio/P&L; settlement + claim flow |
| CI | all above + `clippy`/`audit` + CU regression + ESLint import ban | devnet E2E as nightly/manual job |

BookLite's `proptest` property suite (conservation, never-crossed, FIFO, price priority) ships with M7 — Appendix D.

## 13. Deployment, DX & Demo
**13.1** `make dev` (local validator w/ cloned Phoenix + Seat Manager, deploy, seeded demo market, app + indexer), `make test`, `make deploy-devnet`, `make markets-today`, `make settle-now`, `make collect-fees`, `make demo`. `.env.example` in Appendix C.
**13.2 Reproducible devnet lifecycle (the pass requirement):** `make demo` deploys (or reuses), creates one demo market, wallet A mints 10 pairs and quotes both sides (seat claim happens atomically), wallet B executes Buy Yes / Buy No / Sell Yes / Sell No, settlement runs via a real oracle crank, both wallets claim, and a reconciliation table proves I1/I5 held throughout.
**13.3 Weekend-proof:** the demo market's `close_ts = now + 10 min`; a Switchboard crank outside market hours returns a fresh-timestamped read whose value is the prior close, so the §7.4 window (anchored to the demo market's own `close_ts`) passes legitimately. Same code path as production — no relaxed "demo mode".
**13.4 Mainnet (bonus, not planned):** licensed data, multisig admin + upgrade policy, monitoring SLOs, real fee governance, legal review we are explicitly not doing (spec: no regulatory claims).

## 14. Milestones
Relative working days; total ≈ **12–14**; de-scope ladder below.

| M | Days | Scope | DoD / Gate |
|---|---|---|---|
| M0 | D1 | Monorepo, Anchor scaffold, CI, wallets; **dump + clone Phoenix & Seat Manager into localnet**; measure Phoenix market rent at `{512,512,128}` and Meridian+metadata rent; **Codama Umi-renderer spike on the Meridian IDL** (fallback: hand-written Umi builders); app-bundle sanity check (web3.js v1 + wallet-adapter + phoenix-sdk) | CI green; rent table in README; Umi client generated |
| M1 | D2–3 | Config + fee switches + treasury, market creation + **Metaplex metadata CPI**, mint/merge/redeem (claim-fee math), MockOracle settle + override + pause | §12 program tests green incl. fee fuzz |
| M2 | D4–6 | Phoenix integration: automation create+attach flow, `phoenix-sdk`→Umi adapter layer, TIF-at-close, claim-seat flow, four trade paths as composed txs, cancel/withdraw bundle, `CollectFees` crank | full lifecycle green on localnet vs cloned Phoenix |
| M3 | D7–8 | Switchboard feeds (7 tickers) + real settle; automation jobs + calendar; override runbook | live devnet settle succeeds; retry/alert paths exercised |
| M4 | D9–11 | Frontend: 5 pages, four-action panel, both-perspective ladder, constraints, countdown, Claim flow | Playwright happy paths green |
| M5 | D12 | Indexer (both event streams) + History + P&L | history/P&L match a scripted sequence |
| M6 | D13–14 | Devnet E2E polish, `make demo`, README, risks note, ADR cleanup | stranger runs `make demo` from clean clone |
| **M7 (stretch)** | +3–5 | **BookLite** per Appendix D behind the `Venue` seam; activates maker fees; property-test suite | proptest suite green; venue swappable per market |

**7-day de-scope ladder (in order):** drop indexer (History → explorer links; Portfolio without cost basis); composites lose polish (still one signature — they're client-composed anyway); `DEV_PROFILE` only (3 strikes/ticker); Landing page minimal; metadata URI stays empty (already planned). Tests are never the cut. M7 is already outside the box.

## 15. Risk Register

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| R1 | Oracle price ≠ official closing-auction print | M | M | ADR-007 disclosure; sanity band; override runbook uses official close |
| R2 | Oracle unavailable/degraded at settle | M | H | 30s×15min retries; permissionless settle; admin override (1 h delay, loud event) |
| R3 | **Single API source** fails or rate-limits at 4:00 PM | M | M | pre-flight check at 15:55; retry window; band; override; second job source is a config-only hardening later (ADR-002) |
| R4 | Legacy-track frontend stack (Umi + wallet-adapter + web3.js v1) accrues migration debt as the ecosystem consolidates on Kit (F9) | certain | L | deliberate ADR-012 trade-off, logged not hidden; Umi types isolate app code behind one adapter boundary; the direct `phoenix-sdk` reuse it buys removed what was v0.2's highest-severity integration risk; revisit post-V1 |
| R5 | Phoenix market rent × ~49/day, no reclaim path | M | M | measured in M0; small size params; `DEV_PROFILE`; faucet top-up script |
| R6 | No-TIF direct-client orders rest past close | L | L | ADR-009: cannot mint or affect settlement; UI always stamps TIF; documented |
| R7 | Seat eviction blocks a maker's new quotes | L | L | `num_seats=128`; UI auto re-claims on failure (F6 FAQ behavior) |
| R8 | Users hold Yes+No via transfers despite UI constraints | H | L | economically harmless (= $1 redeemable); spec mandates frontend enforcement (ADR-011) |
| R9 | Maker-fee switch unenforceable on Phoenix | certain | L now | stated in ADR-006; activates with M7 BookLite; escalate via §16-Q7 if V1-blocking |
| R10 | DST / holiday / 1 PM-early-close bugs | M | H | calendar module is the single source of `close_ts`; dedicated tests |
| R11 | Phoenix "Legacy" maintenance-mode risk | L | M | MIT source + verifiable build; we can pin/self-deploy; `Venue` seam + M7 exit path |
| R12 | Value stuck in resting orders post-settlement | M | M | Claim bundle (cancel+withdraw+redeem); cancels always available; UI prompts |
| R13 | Regulatory posture | — | — | neutral limitations note per spec; devnet only; no real funds; no claims made |

## 16. Open Questions
Resolved this round: venue (Phoenix first), oracle (Switchboard only), fees (switches at 0), metadata (Metaplex), frontend (Umi — revised from Kit in v0.3).
1. **Q1 (ADR-008):** confirm `merge_pair` as an acceptable reading of "destroyed only via redeem."
2. Q2: ATM 7th strike default on (proposed) or off?
3. **Q3:** pick the single stock-data API source (Finnhub / Twelve Data / Polygon free tiers are the candidates) — needs an account signup for `.env`.
4. Q4: confirm `merge_pair` stays fee-free when `claim_fee_bps > 0` (ADR-006 rationale).
5. Q5: alerting channel for automation failures (webhook URL / Slack / Telegram)?
6. Q6: metadata URI — empty in V1 (proposed) or host a JSON+icon per market (adds hosting)?
7. Q7: `MAX_FEE_BPS` cap value (proposed 500); and is the dormant maker fee acceptable for V1, or does it change the venue decision?
8. Q8: timeline — is 12–14 days the box, or does the 7-day ladder apply?
9. Q9: Phoenix market size params — confirm `{512, 512, 128}` after M0 rent measurement.

## 17. Requirements Traceability Matrix

| Spec requirement | Plan section(s) |
|---|---|
| $1.00 invariant on-chain, never violated | §7.5 I1–I2, §12 |
| Vault = pairs×$1 exact; **fees to a separate account** | §7.5 I1 + **I5**, ADR-006 (treasury) |
| Tokens created only via mint pair / destroyed only via redeem | §7.5 I3, ADR-008 |
| Settlement immutable | §7.5 I4, §7.3 |
| Daily lifecycle 8:00/8:30/9:00/9:30/16:00/16:05 | §5 flow, §9, §7.1 timestamps |
| Markets pre-open; settled ≤10 min after close | §9, §7.4 window |
| At-or-above rule incl. exact-strike | ADR-007, §7.2, §12 |
| One book per strike; four paths; two perspectives | ADR-003, §6, §11, Appendix A |
| Buy No first-class, atomic, one approval (market + limit) | Appendix A (single-tx composites), ADR-003 (atomic seat claim) |
| Sell No auto-close of Yes+No | Appendix A, ADR-008 |
| Position constraints via frontend balance checks | ADR-011, §11 |
| Strike algorithm ±3/6/9% → nearest $10, dedupe, optional ATM, admin add | §8, §7.2 `add_strike` |
| Existing on-chain CLOB option (Phoenix) — with justification | ADR-003, §2 F4–F8 |
| Smart-contract function list | §7.2 (superset; extras justified ADR-006/008) |
| Create called once per strike | §7.2, §9 |
| Oracle on-chain settlement read; staleness; configurable confidence/quality | §7.4, ADR-002 |
| Prev-close read may be off-chain | §8 |
| Oracle failure: retry 30s×15min → admin override ≥1 h delay | §9, §7.2 |
| Justify oracle choice | §2 F1–F3, ADR-002 |
| Pause minting and trading (exits never) | ADR-009/010 (TIF freeze + mint gate) |
| Redemption indefinite | §7.2, ADR-009 |
| Frontend pages & UI elements | §11 |
| Automation in-repo, logs, alerts, retries | §9 |
| Testing requirements (unit, invariants, oracle matrix, override delay, lifecycle, 4 paths, multi-user, frontend list) | §12 |
| Devnet deployment + reproducible scripts + one-command setup | §13 |
| Secrets via env; `.env.example`; no mainnet/real funds | Appendix C, §3 |
| Justify dependencies; avoid unnecessary abstractions | ADRs, Appendix B |
| Risks/limitations note; no regulatory claims | §15 |
| Trade-offs documented | ADR-001…012, §2 |

## Appendix A — Trade Paths → Transactions (Phoenix venue; one signature each)

| Intent | Mode | Transaction composition |
|---|---|---|
| Buy Yes | Market | `[phoenix.Swap(buy Yes, IOC)]` — no seat needed |
| Buy Yes | Limit @ p¢ | `[seatIxIfNeeded, phoenix.PlaceLimitOrder(bid, p, TIF=close_ts)]` |
| Buy No | Market | `[meridian.mint_pair(q), phoenix.Swap(sell Yes q, IOC)]` — user keeps No; cost = $1 − fill |
| Buy No | Limit @ pₙ¢ | `[meridian.mint_pair(q), seatIxIfNeeded, phoenix.PlaceLimitOrder(ask @ 100−pₙ, TIF=close_ts)]` — holds both until fill, per spec |
| Sell Yes | Market / Limit | `[phoenix.Swap(sell)]` / `[seatIxIfNeeded, phoenix.PlaceLimitOrder(ask, TIF)]` |
| Sell No | Market | `[phoenix.Swap(buy Yes q, IOC), meridian.merge_pair(q)]` — "system handles the close automatically" |
| Exit hedged | — | `[meridian.merge_pair(q)]` |
| Post-settle Claim | — | `[phoenix.CancelAllOrders, phoenix.WithdrawFunds, meridian.merge_pair?/redeem]` |

When `taker_fee_bps > 0`, swap legs pay Phoenix's taker fee in USDC (Buy-No-market effective cost becomes `$1 − (fill − fee)`); the UI displays fee-inclusive numbers. Solana transactions are atomic across instructions — partial execution is impossible.

## Appendix B — Repo Layout & Justified Dependencies
```
meridian/
├─ programs/meridian/            # Anchor (config+fees, market, vault, settle, oracle_adapter, metadata CPI)
├─ packages/common/              # strike engine, NYSE calendar, constants, Codama Umi client (meridian), phoenix tx helpers (sdk + umi adapters)
├─ services/automation/          # cron jobs, Phoenix create/attach, CollectFees, runbooks
├─ services/indexer/             # dual-stream events → SQLite; ladder decode; REST/WS
├─ app/                          # Next.js — @solana/kit ONLY (ESLint-enforced)
├─ scripts/                      # deploy, faucet, dump-phoenix, lifecycle-demo, settle-now
├─ tests/                        # litesvm (rust), localnet integration, codec fixtures, playwright
├─ docs/adr/  docs/runbooks/
└─ Makefile  .env.example  README.md
```
Frontend deps: `@metaplex-foundation/umi` + `umi-bundle-defaults` (web3.js v1 underneath by design, F10), `@solana/wallet-adapter-react` + `@metaplex-foundation/umi-signer-wallet-adapters`, `@metaplex-foundation/umi-web3js-adapters`, Codama-generated Umi client, `phoenix-sdk`. Program deps: `anchor`, `anchor-spl` (token + metadata), `switchboard-on-demand`, `phoenix-v1` crate (types for header validation). Server-side: `phoenix-sdk` (event parsing, ladder decode — now shared with the app), `@switchboard-xyz/on-demand`, `luxon`, `better-sqlite3`. Test: `litesvm`, `proptest` (M7), `playwright`. Nothing else load-bearing.

## Appendix C — `.env.example` (draft)
```
RPC_URL=https://api.devnet.solana.com
WS_URL=wss://api.devnet.solana.com
ADMIN_KEYPAIR_PATH=./keys/admin.json
AUTOMATION_KEYPAIR_PATH=./keys/automation.json
QUOTE_MINT=                      # devnet USDC, or blank => mock mint (DEV profile)
PROFILE=DEV                      # DEV (3 strikes/ticker) | FULL
STOCK_API_KEY=                   # single source per ADR-002 (pick in Q3)
ALERT_WEBHOOK_URL=
PHOENIX_MARKET_SIZE=512,512,128  # bids,asks,seats (Q9)
SETTLE_WINDOW_SECS=900
ADMIN_OVERRIDE_DELAY_SECS=3600
MAX_PRICE_BAND_BPS=2000
```
Fee bps live on-chain in `Config` (set via `set_fees`), not in env.

## Appendix D — BookLite Design Sketch (stretch, M7 — the learning exercise, preserved)
The binary domain bounds prices to $0.01–$0.99 → **99 one-cent price levels per side**, collapsing CLOB complexity: two fixed 99-slot level arrays with FIFO queues, `u128` occupancy bitmaps for O(1) best-bid/ask, a fixed order slab (~512 orders/side, ~64 B each → ~36 KB zero-copy account, rent-reclaimable via `close_book`), crankless fills (taker legs settle atomically; maker proceeds credit claimable balances in per-trader PDAs), `max_fills` caps for CU bounds, self-trade policy = cancel-resting, on-chain trading gate at `close_ts`, permissionless post-settlement `sweep_orders`, and **native maker + taker fee enforcement** (activating the dormant maker switch). Correctness regime: `proptest` property suite — conservation, never-crossed book, level FIFO, price priority, cancel refunds, partial-fill correctness — plus CU regression checks. Slots in behind the same `Venue` seam per market; Phoenix markets already created are unaffected.

## Sources consulted (2026-08-19)
Phoenix: ellipsis-labs.gitbook.io/phoenix-dex (Technical Overview, Key Structures, Instructions, Seats, Seat Manager, Units, Market Addresses, Market Maker Overview, Events) · github.com/Ellipsis-Labs/phoenix-v1 · solanacompass.com/projects/Phoenix · ellipsislabs.xyz — Switchboard: docs.switchboard.xyz (Solana/SVM price feeds) · github.com/switchboard-xyz/sb-on-demand-examples — Kit/tooling (landscape context): solana.com/docs/frontend · solana.com/docs/frontend/web3-compat · github.com/solana-foundation/solana-dev-skill — Umi: developers.metaplex.com/umi/getting-started · developers.metaplex.com/umi/web3js-differences-and-adapters · metaplex.com/docs (Core SDK FAQ) · npm: umi-signer-wallet-adapters, umi-web3js-adapters — Context (oracles not chosen): pyth.network/blog/the-pyth-core-upgrade · pyth.network/blog/extended-hours-us-equity-data-moves-to-pyth-pro · docs.chain.link/data-streams/tutorials/solana-onchain-report-verification · docs.chain.link/data-feeds/solana
