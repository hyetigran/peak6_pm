# Meridian

Same-day binary Outcome Markets on whether a MAG7 stock’s Official Close is at or above a stated Strike.

Each Outcome Market is a complementary Yes/No Pair, fully collateralized 1:1 in USDC atoms. Price discovery is a single Yes/USDC OpenBook V2 Venue Market, mirrored for the No perspective. Settlement consumes **one** immutable Settlement Record per ticker and Trading Day. A whole winning token pays exactly 1 USDC; a losing token pays 0. V1 charges **no protocol fees**.

This submission targets **Solana devnet / localnet only**. Do not use mainnet or real funds.

---

## Status

**Localnet demo is live.** `make demo` starts a validator with the pinned OpenBook v1.7 artifact, deploys the Meridian program, seeds Active Outcome Markets, and serves the indexer and frontend.

| Surface | State |
| --- | --- |
| Domain freeze | PRD v0.7.1 + Architecture v1.1.1 + [ADRs 0001–0030](docs/adr/) |
| M0 gates | G1–G10 and G12 proven on localnet (`make m0`). **G11 blocked** on Official-Close provider selection |
| Production program | `programs/meridian` (Anchor 0.31.1), program id `FF6mu5FFb1q1Qz88x1HnhkePdF8Q1dXWnTfUUSkzUT3t` |
| M0 harness | `programs/m0-harness` — validation scaffolding, **not** the product program |
| Indexer | `services/indexer` on `:8787` |
| Frontend | Next.js 14 under `frontend/` on `:3100` |
| Keeper / market-maker | Localnet demo processes; not the production automation service |
| `make demo-devnet` | **Not implemented.** Required M6 path: labeled **synthetic** Settlement Record on public HTTPS |
| `make oracle-e2e-devnet` | **Not implemented.** Required M0/M6 path: **real** Nasdaq Official Close. Synthetic evidence cannot satisfy it |

Architecture names `make dev` as the local-development target. Today that stack is `make demo`.

---

## How it works

The user-facing question is always: **Will [STOCK] close at or above [STRIKE] today?** Equality at the Strike belongs to Yes.

One Venue Market serves four Directional Intents:

| Intent | Composition |
| --- | --- |
| Buy Yes | Take Yes from the ask (Market Action: full-fill-or-revert) or PostOnly Bid |
| Buy No | Mint a Pair, then sell Yes. Effective No cost is `$1 − Yes proceeds` |
| Sell Yes | Sell Yes on the ask |
| Sell No | Acquire the missing Yes, then Pair Redemption. V1 has no Sell-No limit |

Limits are PostOnly. A crossing limit reverts the whole transaction. Market Actions that cannot fill completely revert.

Daily shape (ET; NYSE is the Trading Day authority):

```text
08:00  strikes from prior Official Close (±3/6/9% + ATM, round $10, dedupe)
08:30  create Outcome Market → create Venue Market → attach
09:00  mint window
09:30  trading
close − 5m     Official-Close preflight
16:00 / early  mint and trading close
close + 15m    poll for a final Settlement Record
close + 20m    earliest automated Settlement (devnet)
close + 25m    SLO incident if unresolved
close + ≥1h    Manual Settlement Override additionally eligible
```

Localnet builds (`--features localnet`) relax **only** those schedule and settlement timing floors so the demo can run in one sitting. The default (devnet) build keeps the real floors.

---

## Prerequisites

| Tool | Notes |
| --- | --- |
| Rust + Cargo | Edition 2021; `cargo-build-sbf` from the Solana toolchain |
| Solana CLI | Pin evidence was gathered with **3.1.13**. `solana-test-validator` required |
| Anchor | **0.31.1** (matches `programs/meridian`) |
| Node.js 20+ + npm | Root tests use `tsx`; frontend is Next 14 |
| Make | `Makefile` is the one-command entry |

Clone this repo. Fixtures are checked in and hash-gated:

```text
fixtures/openbook_v2-v1.7.so   SHA-256 a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8
fixtures/squads_v4.so          SHA-256 dec8d3e0fae58c7c8f2416e5f67c25e673f047afd6dd2bba4a47e0b29a01d34c
```

Copy the environment template (optional for localnet demo; required before any remote work):

```bash
cp .env.example .env
```

`.env`, `wallets/`, and `keys/` are gitignored. Never commit a funded or authority keypair.

`make build` copies `wallets/meridian-program.json` → `target/deploy/meridian-keypair.json` so the local validator loads program id `FF6mu5FF…`. That file is gitignored; generate a keypair whose pubkey matches `declare_id!` in `programs/meridian/src/lib.rs` before a clean-clone build, or adjust the copy step after generating one.

---

## Quick start (localnet, synthetic)

This path uses a **self-minted six-decimal test USD** and a **synthetic** settlement clock. It proves plumbing. It does **not** prove Nasdaq Official Close correctness, provider finality, or production readiness.

```bash
npm install
make demo
```

Then:

| URL | What |
| --- | --- |
| http://localhost:3100 | Frontend (Landing, Markets, Trade, Portfolio, History, Admin) |
| http://localhost:8787/markets | Indexer JSON |
| http://localhost:8787/health | History Completeness (indexer lag vs chain tip) |
| http://127.0.0.1:8899 | Solana RPC (localnet) |

Ctrl-C stops the validator, indexer, keeper, market-maker, and frontend.

The demo seeds Active Outcome Markets on AAPL / NVDA / MSFT, starts an EventHeap keeper, and posts live liquidity. The Trade page reads the real OpenBook book. A localnet faucet (`GET /faucet/:wallet`) mints 1000 test USD — demo-only, not a protocol instruction.

Override the demo wallet:

```bash
DEMO_WALLET=<your-localnet-pubkey> make demo
```

---

## Other commands

```bash
make fixture-verify   # SHA-256 the pinned .so files
make build            # SBF: m0-harness + meridian (localnet feature)
make localnet         # validator with OpenBook v1.7 + both programs + Squads V4
make meridian-test    # foundation + trading + settlement suites
make m0               # G2–G10 and G12 harness suites (G11 is not in this target)
make indexer          # indexer only, assumes RPC already up
make keeper           # EventHeap crank (needs .demo-config.json)
make marketmaker      # demo liquidity (needs .demo-config.json)
```

Individual gates: `make g2` … `make g10`, `make g12`.

`make m0` does **not** include G1 (pin evidence is `docs/adr/openbook-v2-pin.md`) or G11 (real oracle).

### Required M6 targets (not in the Makefile yet)

| Target | Evidence class | Purpose |
| --- | --- | --- |
| `make demo-devnet` | **Synthetic**, public HTTPS Settlement Record | Deterministic create → mint → trade → settle → redeem on Solana **devnet**. localhost / RFC1918 / `.local` sources are invalid |
| `make oracle-e2e-devnet` | **Real** Nasdaq Official Close | Non-waiverable G11. Same-record PRICE + observation, Close Method, correction monitor. Synthetic fixtures cannot pass this gate |

When those targets land, keep the labels in the command output. Mixing them is a spec failure.

Circle Devnet USDC for remote clusters: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Do not label localnet test USD as USDC.

---

## What you can do in the demo

- Browse MAG7-style Outcome Markets with strike, status, and implied Yes/No from the book.
- Connect a wallet (or use the managed localnet burner) and mint a Pair / redeem a Pair / claim a winner.
- Place PostOnly limits and Market Actions against live OpenBook depth.
- Pause, settle, and override from the local Admin console (demo signer from `.demo-config.json` — **not** production role isolation).

Still thinner than the freeze:

- Remote Switchboard On-Demand read (localnet settlement is mocked).
- Permanent Arweave → Metaplex metadata CPI at creation.
- Production automation (NYSE calendar, corporate-action blackout, correction monitor).
- Full History Completeness / Platform-execution P&L as specified for M5.
- Devnet E2E and Squads upgrade-authority transfer (M6).

---

## Repository layout

```text
programs/meridian/          V1 Anchor program
programs/m0-harness/        M0 gate harness (not product)
packages/                   (intended: common, meridian-client, openbook-adapter)
services/indexer/           SQLite + HTTP read model
services/keeper/            localnet EventHeap crank
services/marketmaker/       localnet liquidity
frontend/                   Next.js 14 App Router
scripts/                    localnet.sh, demo.sh, seed-demo.ts
tests/                      M0 suites + meridian-*.test.ts
fixtures/                   pinned OpenBook v1.7 + Squads V4 bytes
docs/PRD.md                 product contract v0.7.1
docs/ARCHITECTURE.md        system design v1.1.1
docs/REQUIREMENTS.md        converted source spec (PDF remains source of truth)
docs/adr/                   accepted decisions 0001–0030
CONTEXT.md                  domain glossary — use these terms
.env.example                environment template
```

Document authority, in order: `CONTEXT.md` → `docs/adr/` → `docs/PRD.md` → `docs/ARCHITECTURE.md` → `docs/REQUIREMENTS.md`. If new work contradicts an ADR, say so explicitly.

---

## Pins and identities

| Item | Value |
| --- | --- |
| OpenBook program | `opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb` |
| OpenBook tag / commit | v1.7 / `796a470` |
| OpenBook artifact SHA-256 | `a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8` |
| Meridian (localnet) | `FF6mu5FFb1q1Qz88x1HnhkePdF8Q1dXWnTfUUSkzUT3t` |
| M0 harness | `3MmdMxRUF4NWPNdwoQcLhoqfmiKReoaSQR9GwSeQEpRr` |
| Fee-admin sentinel (G9) | `EhAss6gbDU57Cmwwyeq3RwHBVRvBK4CkzLS8yvddFZ1E` |
| Squads V4 | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` (audited commit `64af7330…`, `@sqds/multisig@2.1.4`) |

V1 binds to the **canonical** OpenBook deployment (ADR-0030). The inert ADR-0029 copy `923gYkFC…` must never be referenced. Canonical devnet OpenBook retains an external upgrade authority; identity checks fail closed and alert on ProgramData / slot / hash / authority drift. OpenBook CPI uses the MIT `cpi`/`client` surface and IDL only — never `enable-gpl`.

Measured venue facts the program encodes (see `programs/meridian/src/constants.rs` and `docs/adr/openbook-v2-pin.md`):

- Practical inline maker cap is **11**, not 15 (SBF heap).
- PostOnly-cross and past-expiry placements are venue silent no-ops; wrappers require a returned order id.
- EventHeap penalty at this pin is **0**.
- First-use Buy-No-limit fits one approval on localnet (G7); the named product waiver is not needed for that measurement.

---

## Invariants (on-chain)

1. One outcome-token atom corresponds to one USDC atom. Vault raw ≥ accounted Collateral Liability.
2. Liability is supply-derived: `max(Yes, No)` while the outcome is Unset; winning supply once set.
3. Yes payout + No payout = $1.
4. Tokens are created only via `mint_pair`. Meridian destroys tokens only through the Redemption family (Pair Redemption, market-assisted Pair Redemption, Outcome Redemption). A classic SPL Direct Holder Burn is unsupported forfeiture.
5. Collateral Surplus is observable and **not withdrawable** in V1. There is no treasury and no fee administrator.
6. Settlement is written once from the shared Settlement Record. Later provider corrections are incidents, not payout changes.
7. Meridian is the only order-creation gateway. `create_venue_market` is the only attachable venue path.
8. Venue Markets attach only with zero maker/taker fees and the unsignable fee-admin sentinel.

Frontend Directional Guardrail (Exposure Interval across holdings, venue balances, and resting/pending orders) is a product rule, not an on-chain token lock. Mixed and Unknown Positions, and missing indexed state (Recovery-only Mode), fail closed for new Directional Intents. Cancellation, fund settlement, and Redemption remain available.

---

## Indexer HTTP (localnet)

```text
GET  /health
GET  /markets
GET  /markets/:pubkey
GET  /book/:pubkey
GET  /portfolio/:wallet
GET  /faucet/:wallet          localnet demo only
GET  /admin/state
POST /admin/pause
POST /admin/settle/:pubkey    localnet demo only
POST /admin/override/:pubkey  localnet demo only
```

The indexer is read-only against protocol authority. Localnet admin routes sign with demo role keypairs from `.demo-config.json` so the UI can exercise pause/settle; they are not the production trust model.

---

## Tests

```bash
make meridian-test    # programs/meridian on localnet
make m0               # harness gates G2–G10, G12
```

G1 evidence lives in [`docs/adr/openbook-v2-pin.md`](docs/adr/openbook-v2-pin.md). G8 rent numbers are in `docs/adr/g8-rent-measurements.json`. G6/G7 measurements are in `docs/adr/g6-measurements.json` and `docs/adr/g7-measurements.json`.

M1+ full-build work waits on a **signed M0 go/no-go**. Remaining human inputs: Official-Close provider (G11), alert webhook receiver, three M6 Squads member pubkeys, Emergency Expiry disposition after G3.

---

## Risks and limitations

This is a **devnet / localnet proof of concept**. It is not a production venue, not a registered exchange, and not investment, legal, or compliance advice. No KYC, no custody of user wallets, no margin, no mainnet.

Known limits:

- Canonical OpenBook v1.7 on public clusters still has a retained upgrade authority (ADR-0030 monitors this; it is not “immutable bytes on a dead program”).
- If the listing market publishes no Official Close, the Outcome Market stays Settlement Disputed; unmatched directional positions wait. There is no void, draw, or last-trade substitute.
- Manual Settlement Override attests HTTP evidence. Solana cannot authenticate those HTTPS responses; the Override Authority is a delayed price trust root. Non-demo use requires a multisig.
- Freely transferred tokens and Direct Holder Burns can bypass the UI guardrail. Protocol solvency still holds; surplus stays locked.
- EventHeap saturation fails closed (fills panic at a full heap). Keepers must consume or makers freeze.
- Localnet Admin pause/settle is a demo convenience and must not ship as the production authority model.
- Unattended automation is prohibited until the signed alert webhook is configured and tested.

See Architecture §18 and PRD §18 for the full register.

---

## Further reading

| Doc | Owns |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | Vocabulary |
| [`docs/adr/`](docs/adr/) | Accepted decisions |
| [`docs/PRD.md`](docs/PRD.md) | Product behavior and acceptance |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Accounts, CPI, services |
| [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) | Converted source specification |
| [`docs/agents/`](docs/agents/) | GitLab issues, triage labels, Squads research |
| [`AGENTS.md`](AGENTS.md) | Pointers for coding agents |
