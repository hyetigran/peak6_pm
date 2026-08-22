# Tech Context

## Target environment

- **Chain:** Solana **devnet** only for the core submission. No mainnet, no real funds. Localnet is the working demo.
- **Meridian program:** Rust + Anchor **0.31.1**. Program id `HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD`.
- **CLOB:** OpenBook V2 v1.7. **The artifact executes only at canonical `opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb`** (compiled-in declare_id; re-ID/patch routes disproven). Localnet: `--bpf-program opnb2LAf… fixtures/openbook_v2-v1.7.so`. Devnet: canonical deployment per ADR-0030 (retained authority accepted as monitored fail-closed risk). Inert stray: `923gY…` (ADR-0029, do not use).
- **Pin (see `docs/adr/openbook-v2-pin.md`):**
  - release commit `796a470`
  - build SHA-256 `a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8`
- **Settlement transport:** Switchboard On-Demand carrying one atomically bound Settlement Record per ticker and Trading Day. Delivery path, not source of truth. **Official-Close transport not built** (#16, blocked on #9). Built + proven: the **Pyth adapter** (`programs/pyth-adapter`, `@pythnetwork/pyth-solana-receiver` 0.16 + `hermes-client` 3.1, Hermes needs `encoding:"base64"`; `@solana/web3.js` pinned workspace-wide) as the synthetic-demo transport — `make pyth-settle-e2e`. Localnet default is still the m0-harness mock feed.
- **Official Close:** unadjusted Nasdaq NOCP under the listing market’s Close Method.
- **Quote mint:** Circle six-decimal Solana Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Local tests use self-minted six-decimal **test USD**, never labeled USDC.
- **Tokens:** classic SPL Token, 6 decimals. `publish_metadata` Metaplex CPI is built and localnet-verified. Permanent Arweave + two-gateway verify-before-mint (ADR-0016) is not yet the creation path (placeholder URI `https://meridian.markets`).
- **Frontend:** Next.js 14 App Router under `frontend/`. Wallet-adapter + a managed localnet burner. Not yet a Codama/Umi generated client.
- **Package manager:** **pnpm workspace** (`pnpm@11.15.1`). Root + `packages/*` + `services/*` + `frontend`.
- **Automation / indexer:** TypeScript / Node.js. SQLite indexer (`better-sqlite3`). Calendar/blackout automation is not built.
- **Upgrade / override (M6 / non-demo):** Squads Protocol V4 `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, audited commit `64af7330…`, exact `@sqds/multisig@2.1.4`. G12-proven on localnet.
- **Issue tracker:** GitLab on `labs.gauntletai.com`. CLI: `glab`. Labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.

## OpenBook facts that load-bearing code depends on

Re-read from the pinned v1.7 release, not from `master`:

- `open_orders_admin` must sign order creation including `place_take_order`.
- Expiry predicate is strict: `time_expiry != 0 && time_expiry < now`. Meridian sets `time_expiry = close_ts - 1`.
- `place_take_order` has no referrer account; `settle_funds` optionally does (wrapper forces none).
- **PostOnly-cross and past-expiry placements are venue silent no-ops (success, no order)** — order paths MUST require the returned `Option<u128>` order id (G10). Per-order TIF is u16 seconds (~18.2h clamp).
- Inline maker fills: `FILL_EVENT_REMAINING_LIMIT = 15` theoretical, **measured practical capacity is 11**. `requestHeapFrame` does NOT extend a CPI'd program's heap. Taker builders cap inline makers at 11. `PENALTY_EVENT_HEAP = 0` at the pin.
- consume_events: MAX 8 events/ix; events whose owner OO is not in remaining accounts are SKIPPED; full-heap fills PANIC at exactly 600.
- `consume_events_admin = None` → permissionless consume.
- `close_market_admin` controls `set_market_expired` / prune / close. `set_market_expired` requires not-yet-expired and sets `time_expiry = -1`.
- `MAX_OPEN_ORDERS = 24` resting orders per OpenOrders account.
- `collect_fee_admin` sentinel (G9): PDA("meridian_fee_admin_sentinel", System Program) = `EhAss6gb…`.
- Majority of OpenBook repo is MIT; GPL is behind `enable-gpl`. Use `client`/`cpi` only.

## Compile-time / config constants

```text
MIN_OVERRIDE_DELAY_SECS              = 3600
DEVNET_NORMAL_SETTLEMENT_DELAY_SECS  = 1200   # close+20m; header-enforced
MIN_ADD_STRIKE_LEAD_SECS             = 1800    # close-30m
MAX_SESSION_SECS                     = 432000 # 5 days; ADR-0033 (working-tree, #22)
max_sample_spread_bps                = 0
MAKER_FEE / TAKER_FEE                = 0
MAX_INLINE_MAKERS                    = 11
```

On-chain math: checked integers only. Atoms `u64`; intermediates `u128`. Prices/strikes 1e6. No floating point. G11 must still sign empirical `min_samples`, `max_stale_slots`, `max_price_band_bps` in `docs/adr/settlement-quality-calibration.md` before treating those bounds as frozen.

`localnet` Cargo feature: relaxes schedule/settlement floors **and** compiles in the mock-feed read. Default/`make build-devnet` is strict.

## Transaction construction

G7-measured: first-use Buy-No-limit = 936B — ONE approval, no waiver. Redeem inline cap = 10 DISTINCT makers. Operator venue creation = 2 txs.

- Order creation always through Meridian.
- `mint_pair` creates missing canonical Yes/No ATAs in-instruction (user payer).
- Prefer v0 + frozen deployment ALT for first-use Buy-No-limit. ALT not yet created on-chain.
- Market-action builder: optional `consume_events` → `take_full` with ≤11 maker remaining accounts → exact-fill assert.
- Direct OpenBook cancel/consume allowed (recovery). Wrapped fund settlement supplies no referrer.

## Indexer APIs (localnet)

```text
GET  /health
GET  /markets
GET  /markets/:pubkey
GET  /book/:pubkey
GET  /fills/:pubkey
GET  /orders/:market/:oo
GET  /portfolio/:wallet
GET  /faucet/:wallet          localnet demo only
GET  /admin/state
GET  /admin/keeper
GET  /admin/marketmaker
POST /admin/pause
POST /admin/settle/:pubkey    localnet demo only
POST /admin/override/:pubkey  localnet demo only
POST /admin/settle-all
```

No book WebSocket. History Completeness is indexer-lag vs chain tip (`complete` when lag ≤ 8 slots). P&L is not computed.

## Repo layout (actual, 2026-08-22)

```text
/
  programs/meridian/          V1 Anchor program
  programs/m0-harness/        M0 gate harness (not product; never deploy to devnet)
  packages/sdk/               @meridian/sdk builders
  services/indexer/
  services/keeper/            localnet poll loop
  services/marketmaker/
  frontend/                   Next 14: markets, trade/[market], portfolio, history, admin
  scripts/                    localnet.sh, demo.sh, seed-demo.ts, seed-config.ts, run-suite.sh
  tests/                      g2–g10, g12; meridian-foundation/trading/settlement; seed-config
  fixtures/                   openbook_v2-v1.7.so, squads_v4.so, mpl_token_metadata.so, IDL
  docs/                       PRD v0.7.1, ARCHITECTURE v1.1.1, adr/0001–0033,
                              PRODUCTION_INFRA.md, DEVNET_DEPLOY.md, DEPLOYMENT.md,
                              GOVERNANCE.md, UI_WALKTHROUGH.md
  Makefile                    demo, demo-devnet, build-devnet, m0, meridian-test
  .env.example
  wallets/                    gitignored; meridian-program.json is local
```

Remote: `ssh://git@labs.gauntletai.com:22022/tigranasriyan/peak6_pm.git`.  
`main` tracks `origin/main` at `2d74f47` (seed #24 nits). Working tree has uncommitted ADR-0033 schedule changes in `programs/meridian`.

## Tooling constraints

- Secrets via env; `.env.example` exists. `.env`, `wallets/`, `keys/`, `.demo-config.json` are gitignored.
- Automation should load **only** `OPERATOR_KEYPAIR_PATH`. Today the keeper reads `.demo-config.json` (PRODUCTION_INFRA calls this out).
- `make demo` = local validator + pinned OpenBook + Metaplex + Squads + mock feed + indexer + keeper + MM + frontend `:3100`.
- `make build-devnet` = meridian **without** `localnet` feature + `target/deploy/meridian-devnet.manifest` (#23, done).
- `make demo-devnet` = `DEMO_MODE=devnet` seed via `resolveSeedConfig` (#24, landed; issue still open). Requires `RPC_URL` and the strict identities in `.env.example`. Does **not** start a remote frontend/keeper stack or prove Official Close.
- `make oracle-e2e-devnet` = **not implemented**.
- `make meridian-test` = foundation 6 + trading 5 + settlement 4.
- `make m0` = G2–G10, G12 (not G1 pin doc, not G11).
- `make seed-config-test` = resolver unit tests, no validator.

Solana CLI pin evidence was gathered with **3.1.13**.

## M0 hard gates (ADR-0020)

Non-waiverable except the named first-use Buy-No one-approval product waiver (unused — G7 passed):

| Gate | State |
| --- | --- |
| G1 | Pin evidence in `docs/adr/openbook-v2-pin.md`. Canonical `opnb2LAf…` + ADR-0030 monitored identity. Devnet identity capture still an ops step. |
| G2 | Localnet harness green. Devnet evidence run is #8. |
| G3 | Localnet green (time/pause/expiry + one-way fuse). |
| G4 | Localnet green (full-fill-or-revert). |
| G5 | Localnet green (Sell-No solvency). Ported to meridian as `redeem_no_via_market`. |
| G6 | Localnet green. Inline cap 11; heap 600 panics. |
| G7 | Localnet green. One-approval Buy-No-limit; no waiver. |
| G8 | Measured (~567.8 SOL / 5-day+20%). |
| G9 | Localnet green. Sentinel `EhAss6gb…`. |
| G10 | Localnet green. PostOnly-cross / past-expiry require returned id. |
| G11 | **Blocked** on #9 (provider). Calibration ADR not written. `make oracle-e2e-devnet` missing. |
| G12 | Localnet green (quote pin, metadata ordering, recovery, Squads drill). |

## Remaining human inputs (do not silently decide)

1. Official-Close provider selection via go/no-go against the frozen Settlement Record contract (must pass G11) — #9.
2. Actual receiver behind `ALERT_WEBHOOK_URL` before unattended operation — #10.
3. Three published M6 Squads member pubkeys / custody owners, create-key, multisig, and vault-index-0 addresses — #11.
4. Adopt or omit Emergency Expiry after G3 recovery proof — #15. ADR-0033 already chose the recovery path for post-live gap risk.

ATM default is decided: **on**. Do not scaffold dormant fee or surplus-withdrawal switches.

## Agent/docs conventions

- Before exploring code, read `CONTEXT.md` and relevant `docs/adr/`.
- Issues: `glab issue …`. MRs are GitLab merge requests. MRs are **not** a triage surface.
- Domain layout is single-context: root `CONTEXT.md` + `docs/adr/`.
- README / UI_WALKTHROUGH are **partially stale** vs the tree (they still mention a Landing page, paper-era copy, and “demo-devnet not implemented”). Prefer Makefile + ADRs + this Memory Bank for current commands.
