# Tech Context

## Target environment

- **Chain:** Solana **devnet** only for the core submission. No mainnet, no real funds.
- **Meridian program:** Rust + Anchor.
- **CLOB:** OpenBook V2 v1.7. **The artifact executes only at canonical `opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb`** (compiled-in declare_id; re-ID/patch routes disproven — pin evidence §7). Localnet: `--bpf-program opnb2LAf… fixtures/openbook_v2-v1.7.so`. Devnet: canonical deployment (retained authority; monitored-checks decision pending). Inert stray: `923gY…` (ADR-0029, do not use).
- **Pin (executable/commit/hash verified; G1 identity disposition pending — see `docs/adr/openbook-v2-pin.md`):**
  - release commit `796a470`
  - build SHA-256 `a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8`
- **Settlement transport:** Switchboard On-Demand carrying one atomically bound Settlement Record per ticker and Trading Day. Delivery path, not source of truth.
- **Official Close:** unadjusted Nasdaq NOCP under the listing market’s Close Method.
- **Quote mint:** Circle six-decimal Solana Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Validate owner, token program, and decimals before venue creation. Local tests may use self-minted six-decimal **test USD**, never labeled USDC.
- **Tokens:** classic SPL Token, 6 decimals. Metadata JSON is RFC 8785 canonical UTF-8, hashed, uploaded to production Arweave, verified through two gateways **before** immutable Metaplex metadata (ADR-0016). IPFS only as explicit fallback with raw CID and ≥2 independent pins.
- **Frontend:** Next.js under `frontend/` + Metaplex Umi + wallet-adapter. Codama-generated Umi client for Meridian.
- **Automation / indexer:** TypeScript / Node.js. SQLite indexer. Calendar: NYSE published schedule is authoritative; Alpaca Calendar API is operational; annual cache vs checked-in NYSE fixtures; fail loudly on disagreement.
- **Upgrade / override (M6 / non-demo):** Squads Protocol V4 `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, audited commit `64af7330413d5c85cbbccfd8c27a05d45b6e666f`, exact `@sqds/multisig@2.1.4`. Research: `docs/agents/squads-v4-multisig-research.md`.
- **Issue tracker:** GitLab on `labs.gauntletai.com`. CLI: `glab`. Labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.

## OpenBook facts that load-bearing code depends on

Re-read from the pinned v1.7 release in M0, not from `master`:

- `open_orders_admin` must sign order creation including `place_take_order`.
- Expiry predicate is strict: `time_expiry != 0 && time_expiry < now`. Meridian sets `time_expiry = close_ts - 1`.
- `place_take_order` has no referrer account; `settle_funds` optionally does (wrapper forces none).
- Inline maker fills: up to 15 remaining OpenOrders accounts; otherwise EventHeap. At the pinned v1.7 commit `PENALTY_EVENT_HEAP = 0` (`state/market.rs:16`) — heap entries charge **nothing**; the 500-lamport figure is from a later revision. `penalty_heap_count` still increments; golden-test the constant stays 0.
- `consume_events_admin = None` → permissionless consume.
- `close_market_admin` controls `set_market_expired` / prune / close.
- `collect_fee_admin` is still a required pubkey even at zero fees → unsignable sentinel, never a Meridian PDA.
- Majority of OpenBook repo is MIT; GPL is behind `enable-gpl`. Use `client`/`cpi` only.

## Compile-time / config constants

```text
MIN_OVERRIDE_DELAY_SECS              = 3600
DEVNET_NORMAL_SETTLEMENT_DELAY_SECS  >= 1200   # close+20m; header-enforced
MIN_ADD_STRIKE_LEAD_SECS             = 1800    # close-30m, including early close
max_sample_spread_bps                = 0       # exact normalized sample equality
MAKER_FEE / TAKER_FEE / CLAIM_FEE    = 0; no fee subsystem
```

On-chain math: checked integers only. Atoms `u64`; intermediates `u128`. Prices/strikes 1e6. No floating point. G11 must sign empirical `min_samples`, `max_stale_slots`, `max_price_band_bps` in `docs/adr/settlement-quality-calibration.md` before M1.

## Transaction construction

- Order creation always through Meridian.
- `mint_pair` creates missing canonical Yes/No ATAs in-instruction (user payer). USDC ATA may be a wallet prerequisite.
- Prefer v0 + frozen deployment ALT for first-use Buy-No-limit (G7). ALT: programs, sysvars, Config PDA, quote mint only.
- Market-action builder: optional `consume_events` → `take_full` with ≤15 maker remaining accounts → exact-fill assert.
- Direct OpenBook cancel/consume allowed (recovery). Wrapped fund settlement supplies no referrer.

## Indexer APIs (architecture)

Frozen endpoints include markets, book REST/WS, history, positions, open-orders, crank-health, plus SettlementRecord / incidents projections and History Completeness. OpenOrders discovery: derive wallet `OpenOrdersIndexer` → list → filter to Meridian-attached markets.

P&L is advisory **Platform-execution P&L** only: known-basis finalized Meridian/venue activity; excludes tax treatment and wallet-paid network costs; Internal Unwind is not external price discovery.

## Repo layout (intended vs actual)

Intended: `programs/meridian` (including `state/settlement_record.rs`, no `instructions/fees/`), `packages/{common,meridian-client,openbook-adapter}`, `services/{automation,indexer,demo-source}`, `frontend/`, `scripts/{deploy,openbook,feeds,multisig,demo}`, `tests/` (including `oracle/`), `docs/`, Makefile, `.env.example`.

**Actual as of 2026-08-19 evening:** still documentation-only, plus design mockups.

```text
/
  AGENTS.md, CONTEXT.md
  docs/{ARCHITECTURE.md v1.1, PRD.md v0.7, REQUIREMENTS.md, adr/0001–0028, agents/}
  design mockups/          # HTML wireframes + uploads/meridian-spec.md, uploads/PRD.md
  frontend/                # empty placeholder
  memory-bank/
  .cursor/rules/{base,domain}.mdc
```

Remote: `ssh://git@labs.gauntletai.com:22022/tigranasriyan/peak6_pm.git`.  
Git: one commit `e1ef575 init docs`. PRD/ARCHITECTURE modified unstaged; glossary, ADRs, Memory Bank, mockups, and agent docs untracked.

## Tooling constraints

- Secrets via env; provide `.env.example`. Real `.env`, `keys/`, and secret mounts must be gitignored (`.gitignore` is still empty — a known gap).
- Automation loads **only** `OPERATOR_KEYPAIR_PATH`.
- `make demo` = local validator + pinned OpenBook + MockOracle.
- `make demo-devnet` = synthetic public-HTTPS Settlement Record; localhost/RFC1918/`.local` invalid.
- `make oracle-e2e-devnet` = real Nasdaq Official Close path; synthetic evidence cannot satisfy G11.
- G11 calibration captures Massive SIP unadjusted records first and paid Alpaca SIP raw-response cross-checks at close+5/10/15m and next Trading Day.

## M0 hard gates (block M1; ADR-0020)

Non-waiverable except the named first-use Buy-No one-approval product waiver:

| Gate | Proves |
| --- | --- |
| G1 | OpenBook pin, ProgramData/slot/hash, `upgrade_authority=None`, `create_venue_market` PDA signer, no post-create mutation path |
| G2 | Universal PDA order authorization |
| G3 | Time/pause/mint, add-strike cutoff, transport versioning, abandonment, Emergency Expiry go/no-go |
| G4 | Full-fill rollback |
| G5 | Sell-No solvency, no knowing self-cross, Internal Unwind |
| G6 | EventHeap measurement; keeper ≥2× worst-case throughput |
| G7 | Tx size/CU/ALT split; Buy-No-limit one-approval |
| G8 | Rent: 49 markets/day × 5 days + 20% reserve; SettlementRecords not reclaimable |
| G9 | Zero-fee venue + unsignable sentinel; no referrer |
| G10 | Lot/price/PostOnly/expiry semantics |
| G11 | Atomic Settlement Record + **real** oracle proof (`make oracle-e2e-devnet`) |
| G12 | Wire IDs, Circle USDC, metadata manifests, two-step rotation, Squads fixtures, ALT, rent-refund destinations, Recovery-only Mode |

Funding covers 49 Outcome Markets/day for five Trading Days plus 20% reserve.

## Remaining human inputs (do not silently decide)

1. Official-Close provider selection via go/no-go against the frozen Settlement Record contract (must pass G11).
2. Actual receiver behind `ALERT_WEBHOOK_URL` before unattended operation (console fallback if unset).
3. Three published M6 Squads member pubkeys / custody owners, create-key, multisig, and vault-index-0 addresses.
4. Adopt or omit Emergency Expiry after G3 recovery proof.

ATM default is decided: **on**. Q1 Redemption-family interpretation is closed with the Direct Holder Burn boundary. Do not scaffold dormant fee or surplus-withdrawal switches.

## Agent/docs conventions

- Before exploring code (once it exists), read `CONTEXT.md` and relevant `docs/adr/`.
- Issues: `glab issue …`. MRs are GitLab merge requests. MRs are **not** a triage surface.
- Domain layout is single-context: root `CONTEXT.md` + `docs/adr/`.
