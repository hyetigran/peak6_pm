# Meridian

Same-day binary Outcome Markets on whether a MAG7 stock’s Official Close is at or above a stated Strike.

Each Outcome Market is a complementary Yes/No Pair, fully collateralized 1:1 in USDC atoms. Price discovery is a single Yes/USDC OpenBook V2 Venue Market, mirrored for the No perspective. Settlement consumes **one** immutable Settlement Record per ticker and Trading Day. A whole winning token pays exactly 1 USDC; a losing token pays 0. V1 charges **no protocol fees**.

This submission targets **Solana devnet / localnet only**. Do not use mainnet or real funds.

---

## Status

**Localnet demo is live.** `make demo` starts a validator with the pinned OpenBook v1.7 artifact, deploys the Meridian program, seeds Active Outcome Markets, and serves the indexer, keeper, market-maker, and frontend.

| Surface | State |
| --- | --- |
| Domain freeze | PRD v0.7.1 + Architecture v1.1.1 + [ADRs 0001–0033](docs/adr/) |
| M0 gates | G1–G10 and G12 proven on localnet (`make m0`). **G11 blocked** on Official-Close provider selection |
| Production program | `programs/meridian` (Anchor 0.31.1), program id `HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD` |
| M0 harness | `programs/m0-harness` — validation scaffolding, **not** the product program. Never deploy it to devnet |
| Indexer | `services/indexer` on `:8787` |
| Frontend | Next.js 14 under `frontend/` on `:3100`. `/` is the landing page; Markets is `/markets` |
| Keeper / market-maker | Localnet demo processes (poll + mock feed). Production shape is scheduled jobs + heap subscription ([ADR-0031](docs/adr/0031-trigger-keeper-actions-on-a-schedule-not-a-poll.md)) |
| `make build-devnet` | **Done.** Strict SBF (no `localnet` feature) + `target/deploy/meridian-devnet.manifest` |
| `make demo-devnet` | **Seed path exists.** Labeled **synthetic** plumbing: `DEMO_MODE=devnet` + `resolveSeedConfig` against a **already-deployed** strict binary. Not a clean-clone E2E. Not Official Close proof |
| `make oracle-e2e-devnet` | **Not implemented.** Required M0/M6 path: **real** Nasdaq Official Close. Synthetic evidence cannot satisfy it |

Architecture names `make dev` as the local-development target. Today that stack is `make demo`. How to put programs, services, and the Vercel frontend on **devnet** is [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

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

Daily shape (ET; NYSE is the Trading Day authority). The 08:00 / 09:30 morning block is a **timing convenience** — the deployed clock is a continuous roll ([ADR-0032](docs/adr/0032-create-next-session-markets-at-resolution-plus-5m.md), [ADR-0033](docs/adr/0033-open-trading-when-the-market-exists.md)):

```text
prior close + ~20m     earliest automated Settlement (devnet floor)
prior close + ~25m     SLO if unresolved
prior close + ~30m     create next session (resolution + 5m), anchored on the just-published Official Close
                       mint_open  = creation
                       trade_open = creation + 30m   (mint-seed lead kept)
                       close_ts   = next NYSE session close
creation → close       book is open (~23.5h overnight; longer across a weekend/holiday)
close − 5m             Official-Close preflight
16:00 / early close    mint and trading close; OpenBook time_expiry = close_ts - 1
close + 15m            begin accepting a final Settlement Record
>= close + 1h          Manual Settlement Override additionally eligible
```

Strikes are still ±3/6/9% + ATM of the prior Official Close, rounded to $10, deduped. Settlement is still that session’s 4pm Official Close — only *when the book opens* changed.

Localnet builds (`--features localnet`) relax **only** those schedule and settlement timing floors so the demo can run in one sitting. The default (devnet) build keeps the real floors and, once [ADR-0033](docs/adr/0033-open-trading-when-the-market-exists.md) lands in the program, bounds the session (`MAX_SESSION_SECS`) instead of pinning 3.5h / 6.5h.

---

## Prerequisites

| Tool | Notes |
| --- | --- |
| Rust + Cargo | Edition 2021; `cargo-build-sbf` from the Solana toolchain |
| Solana CLI | Pin evidence was gathered with **3.1.13**. `solana-test-validator` required |
| Anchor | **0.31.1** (matches `programs/meridian`) |
| Node.js 20+ + **pnpm** | Workspace root (`pnpm@11.15.1`). Do not use npm for this repo |
| Make | `Makefile` is the one-command entry |

Clone this repo. Fixtures are checked in and hash-gated (`make fixture-verify`):

```text
fixtures/openbook_v2-v1.7.so      SHA-256 a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8
fixtures/squads_v4.so             SHA-256 dec8d3e0fae58c7c8f2416e5f67c25e673f047afd6dd2bba4a47e0b29a01d34c
fixtures/mpl_token_metadata.so    SHA-256 31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011
```

Copy the environment template (optional for localnet demo; required before any remote work):

```bash
cp .env.example .env
```

`.env`, `wallets/`, and `keys/` are gitignored. Never commit a funded or authority keypair.

`make build` copies `wallets/meridian-program.json` → `target/deploy/meridian-keypair.json` so the local validator loads program id `HiREMEBW…`. That file is gitignored; generate a keypair whose pubkey matches `declare_id!` in `programs/meridian/src/lib.rs` before a clean-clone build, or adjust the copy step after generating one.

---

## Quick start (localnet, synthetic)

This path uses a **self-minted six-decimal test USD** and a **synthetic** settlement clock. It proves plumbing. It does **not** prove Nasdaq Official Close correctness, provider finality, or production readiness.

```bash
pnpm install
make demo
```

`make demo` runs `pnpm install` itself. To watch settlement in the same sitting:

```bash
DEMO_SETTLE=1 DEMO_SETTLE_SECS=300 make demo
```

That adds two closing-soon markets (TSLA / GOOGL) so the keeper can finalize a mock Official Close before you get bored.

Then:

| URL | What |
| --- | --- |
| http://localhost:3100 | Frontend — landing (`/`); **Enter the markets** → `/markets` (Trade, Portfolio, History, Admin in the nav) |
| http://localhost:8787/markets | Indexer JSON |
| http://localhost:8787/health | History Completeness (indexer lag vs chain tip) |
| http://127.0.0.1:8899 | Solana RPC (localnet) |

Ctrl-C stops the validator, indexer, keeper, market-maker, and frontend.

The demo seeds Active Outcome Markets across all **seven MAG7 tickers** (strikes from prior close ±3/6/9%), starts an EventHeap keeper, and posts live liquidity. The Trade page reads the real OpenBook book. A localnet faucet (`GET /faucet/:wallet` or the **+1000 USDC** chip) mints 1000 test USD — demo-only, not a protocol instruction.

Override the demo wallet:

```bash
DEMO_WALLET=<your-localnet-pubkey> make demo
```

---

## Other commands

```bash
make fixture-verify     # SHA-256 the pinned .so files
make build              # SBF: m0-harness + meridian (localnet feature)
make build-devnet       # SBF: meridian only, STRICT (no localnet feature) + manifest
make localnet           # validator with OpenBook v1.7 + both programs + Metaplex + Squads V4
make meridian-test      # foundation + trading + settlement suites
make m0                 # G2–G10 and G12 harness suites (G11 is not in this target)
make seed-config-test   # resolveSeedConfig unit tests (no validator)
make indexer            # indexer only, assumes RPC already up
make keeper             # EventHeap crank (needs .demo-config.json)
make marketmaker        # demo liquidity (needs .demo-config.json)
```

Individual gates: `make g2` … `make g10`, `make g12`.

`make m0` does **not** include G1 (pin evidence is `docs/adr/openbook-v2-pin.md`) or G11 (real oracle).

### Devnet / M6 targets

| Target | Evidence class | State |
| --- | --- | --- |
| `make build-devnet` | Strict binary + manifest | **Implemented.** Does not deploy |
| `make demo-devnet` | **Synthetic** seed on Solana **devnet** | **Implemented as a seed.** Requires `RPC_URL` and the identities in `.env.example` (Circle USDC, OpenBook sha/authority, `METADATA_URI`, `ORACLE_PROGRAM_ID` = the Pyth adapter). Program + adapter must already be deployed. localhost / RFC1918 / `.local` sources are invalid. Per-ticker feeds are the adapter's derived delivery PDAs (pinned automatically) |
| `make oracle-e2e-devnet` | **Real** Nasdaq Official Close | **Not implemented.** Non-waiverable G11. Synthetic fixtures cannot pass this gate |

Keep the synthetic-vs-real labels in command output. Mixing them is a spec failure.

Circle Devnet USDC for remote clusters: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Do not label localnet test USD as USDC.

Operator how-to and M6 checklist: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). Roles and key custody: [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md).

---

## What you can do in the demo

- Browse MAG7 Outcome Markets with strike, status, and implied Yes/No from the live book.
- Connect a wallet (or **Use a test wallet**) and trade the four Directional Intents against OpenBook depth. Pair mint/redeem is composed inside those intents — there is no standalone Mint/Redeem slip.
- After Settlement, redeem a winner from Portfolio (or the Trade page).
- Pause, settle, and override from the local Admin console (demo signer from `.demo-config.json` — **not** production role isolation).

Still thinner than the freeze:

- Pyth read on a public cluster (`make pyth-settle-e2e` proves it on a Pyth-cloned localnet; `KEEPER_ORACLE=pyth` on devnet is ops). A Pyth settle is **not** G11 (Pyth equity prices are last trades, not the Nasdaq Official Close — G11 still needs calibration against it via provider #9 + `make oracle-e2e-devnet`).
- Permanent Arweave → verified metadata **before** mint (Metaplex CPI exists; URI is still a placeholder).
- Production automation (NYSE calendar, corporate-action blackout, correction monitor, scheduled keeper).
- Directional Guardrail (Exposure Interval) and SIP Live Underlying Price.
- Full History Completeness / Platform-execution P&L as specified for M5.
- Clean-clone `make demo-devnet` E2E and Squads upgrade-authority transfer (M6).

---

## Repository layout

```text
programs/meridian/          V1 Anchor program
programs/m0-harness/        M0 gate harness (not product; never deploy to devnet)
packages/sdk/               @meridian/sdk instruction builders (shared by tests/scripts/services)
services/indexer/           SQLite + HTTP read model
services/keeper/            localnet EventHeap crank + mock-feed settle loop
services/marketmaker/       localnet liquidity
frontend/                   Next.js 14 App Router (Markets, Trade, Portfolio, History, Admin)
scripts/                    localnet.sh, demo.sh, seed-demo.ts, seed-config.ts
tests/                      M0 suites + meridian-*.test.ts + seed-config.test.ts
fixtures/                   pinned OpenBook v1.7 + Squads V4 + Metaplex bytes
docs/PRD.md                 product contract v0.7.1
docs/ARCHITECTURE.md        system design v1.1.1
docs/REQUIREMENTS.md        converted source spec (PDF remains source of truth)
docs/adr/                   accepted decisions 0001–0033
docs/PRODUCTION_INFRA.md    off-chain topology
docs/GOVERNANCE.md          Config roles, upgrade authority, key custody
docs/DEPLOYMENT.md          program, services, Vercel, M6 checklist
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
| OpenBook ProgramData | `DktN5HJ9uHKVRZ7FXGap4PEGVnEdc2VNBCXTt1AqJQYB` |
| Meridian | `HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD` |
| M0 harness | `3MmdMxRUF4NWPNdwoQcLhoqfmiKReoaSQR9GwSeQEpRr` |
| Fee-admin sentinel (G9) | `EhAss6gbDU57Cmwwyeq3RwHBVRvBK4CkzLS8yvddFZ1E` |
| Circle Devnet USDC | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
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

Frontend Directional Guardrail (Exposure Interval across holdings, venue balances, and resting/pending orders) is a product rule, not an on-chain token lock. Mixed and Unknown Positions, and missing indexed state (Recovery-only Mode), fail closed for new Directional Intents. Cancellation, fund settlement, and Redemption remain available. The localnet UI currently shows a Recovery-only banner from indexer lag; it does not yet compute Exposure Interval.

---

## Indexer HTTP (localnet)

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

The indexer is read-only against protocol authority. Localnet admin routes sign with demo role keypairs from `.demo-config.json` so the UI can exercise pause/settle; they are not the production trust model.

---

## Tests

```bash
make meridian-test      # programs/meridian on localnet (foundation 6, trading 5, settlement 4)
make m0                 # harness gates G2–G10, G12
make seed-config-test   # demo/devnet seed resolver (no validator)
```

G1 evidence lives in [`docs/adr/openbook-v2-pin.md`](docs/adr/openbook-v2-pin.md). G8 rent numbers are in `docs/adr/g8-rent-measurements.json`. G6/G7 measurements are in `docs/adr/g6-measurements.json` and `docs/adr/g7-measurements.json`.

The V1 program, services, and frontend were built on localnet ahead of a **signed M0 go/no-go** (ADR-0020 still requires that report). Remaining human inputs: Official-Close provider (G11), alert webhook receiver, three M6 Squads member pubkeys, Emergency Expiry disposition after G3.

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
- `make demo-devnet` seeds markets. It does not prove Official Close correctness. A Pyth-adapter settle (#16) is not G11 (Pyth equity prices are last trades, not the Nasdaq Official Close — G11 still needs calibration against it via provider #9 + `make oracle-e2e-devnet`).

See Architecture §18 and PRD §18 for the full register.

---

## Further reading

| Doc | Owns |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | Vocabulary |
| [`docs/adr/`](docs/adr/) | Accepted decisions |
| [`docs/PRD.md`](docs/PRD.md) | Product behavior and acceptance |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Accounts, CPI, services |
| [`docs/PRODUCTION_INFRA.md`](docs/PRODUCTION_INFRA.md) | Off-chain topology (scheduler, secrets, observability) |
| [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md) | Config roles, upgrade authority, and key custody |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Program, services, Vercel, M6 checklist |
| [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) | Converted source specification |
| [`docs/agents/`](docs/agents/) | GitLab issues, triage labels, Squads research |
| [`AGENTS.md`](AGENTS.md) | Pointers for coding agents |
