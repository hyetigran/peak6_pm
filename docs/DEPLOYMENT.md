# Deployment

How to put Meridian on **Solana devnet**: program → services → Vercel frontend, then the M6 checklist.

Devnet / localnet only. No mainnet, no real funds. Do not deploy `programs/m0-harness`.

Roles and keys: [`GOVERNANCE.md`](./GOVERNANCE.md). Off-chain topology: [`PRODUCTION_INFRA.md`](./PRODUCTION_INFRA.md). Pyth transport: [`ORACLE_SETUP.md`](./ORACLE_SETUP.md). Env names: [`.env.example`](../.env.example).

```text
make build-devnet → deploy meridian.so + pyth-adapter.so
        → initialize Config + register transports + seed markets
        → indexer (HTTPS) → keeper / market-maker
        → Vercel frontend (needs that HTTPS indexer + an HTTPS RPC)
```

The frontend cannot talk to `localhost`. Deploy the indexer first or Markets is empty.

---

## Identities

| Thing | Value |
| --- | --- |
| Meridian | `HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD` |
| Pyth adapter | `Egc4ykuRJaDz7VfWS9EB9U2hsP2aU9repCCk8XGnk7w4` |
| OpenBook V2 v1.7 | `opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb` |
| OpenBook ProgramData | `DktN5HJ9uHKVRZ7FXGap4PEGVnEdc2VNBCXTt1AqJQYB` |
| Circle Devnet USDC | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Metaplex Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` |
| Squads V4 | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` |
| POC deployer (until M6) | `4XT7HdQg59fmvvymZzUa9kWTHxyehCrLQEJHxrsjQfCq` |

Never use the inert OpenBook copy `923gYkFC…` (ADR-0029). Config snapshots OpenBook identity; a later mismatch fails closed (ADR-0030).

| Role | Devnet need |
| --- | --- |
| Deployer / cold upgrade | SOL for deploy + upgrade-buffer rent. Never loaded by a service. |
| Operator (keeper / create) | Persistent funded hot key. SOL for venues, crank, settle. |
| Governance / pause / override | Cold. Same key only for a labeled demo; distinct / multisig otherwise (ADR-0024). |
| Market-maker | USDC + SOL inventory. Not a protocol authority. |

---

## 1. Program

Prerequisites: Solana CLI (pin evidence **3.1.13**), `cargo-build-sbf`, Anchor **0.31.1**, `solana config set --url https://api.devnet.solana.com`. Program keypair `wallets/meridian-program.json` (gitignored) must match `declare_id!` `HiREMEBW…`. `make build-devnet` copies it to `target/deploy/meridian-keypair.json`. `cp .env.example .env` — secrets stay outside git.

```bash
make fixture-verify
make build-devnet          # meridian only, no localnet feature, no harness
make build-adapter         # programs/pyth-adapter
```

`make build-devnet` writes `target/deploy/meridian.so` and `target/deploy/meridian-devnet.manifest` (`commit`, `sha256`, program id). Record the manifest with the deploy. `make build` is localnet/tests only — do not ship that `.so`.

Capture **before** `initialize_config` / `register_transport`:

| Env | What |
| --- | --- |
| `OPENBOOK_PROGRAMDATA_ADDRESS` | already in `.env.example` |
| `OPENBOOK_DEPLOYMENT_SLOT` | current slot of the canonical artifact |
| `OPENBOOK_EXECUTABLE_SHA256` | 32-byte hex of deployed bytes |
| `OPENBOOK_UPGRADE_AUTHORITY` | current authority (canonical deployment retains one) |
| `ORACLE_PROGRAM_ID` | adapter `Egc4yk…` |
| `ORACLE_PROGRAMDATA_ADDRESS` / `ORACLE_DEPLOYMENT_SLOT` / `ORACLE_EXECUTABLE_SHA256` / `ORACLE_UPGRADE_AUTHORITY` | adapter snapshot |

```bash
solana program deploy target/deploy/meridian.so \
  --program-id wallets/meridian-program.json \
  --upgrade-authority <deployer-keypair.json> -u devnet

solana program deploy target/deploy/pyth_adapter.so \
  --program-id <adapter-keypair.json> \
  --upgrade-authority <deployer-keypair.json> -u devnet

solana program show HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD -u devnet
```

Publish ProgramData address, slot, executable SHA-256, upgrade authority. Localnet placeholders (`0xaa…` OpenBook hash, self-minted test USD) must not be reused. `quote_mint` is Circle Devnet USDC. Adapter deploy + identity: [`ORACLE_SETUP.md`](./ORACLE_SETUP.md).

```bash
export RPC_URL=https://api.devnet.solana.com   # dedicated provider preferred
export DEMO_MODE=devnet
export GOVERNANCE_KEYPAIR=/path/to/governance.json
export OPERATOR_KEYPAIR_PATH=/path/to/operator.json
export QUOTE_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
export OPENBOOK_EXECUTABLE_SHA256=<64 hex>
export OPENBOOK_UPGRADE_AUTHORITY=<pubkey>
export METADATA_URI=https://…                 # permanent JSON, ADR-0016
export ORACLE_PROGRAM_ID=Egc4ykuRJaDz7VfWS9EB9U2hsP2aU9repCCk8XGnk7w4
make demo-devnet
```

`make demo-devnet` is a **synthetic** seed (ADR-0028): create → mint wiring against the strict binary. It writes `.demo-config.json` (secret, gitignored). Never upload it to Vercel or commit it. It is not Official Close proof.

If Config already exists, register transports with
`pnpm exec tsx scripts/register-pyth-transports.ts` (governance-signed; feeds are `deliveryPda(ticker)`).

---

## 2. Services

Long-running Node processes. Not for Vercel (no persistent loop, no `better-sqlite3`, keeper holds a key). On-chain safety does not depend on them; they are liveness + the read path.

| Service | Role | Key | Start |
| --- | --- | --- | --- |
| `services/indexer` | GPA → SQLite → JSON | none | `make indexer` |
| `services/keeper` | EventHeap + settle | **operator** | `make keeper` (local poll) or `scheduler.ts` (prod) |
| `services/marketmaker` | Demo Yes/USDC quotes | inventory | `make marketmaker` |

```bash
pnpm install
export RPC_URL=https://<dedicated-devnet-rpc>
export MERIDIAN_PID=HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD
export PORT=8787
export INDEXER_DB=/var/lib/meridian/indexer.sqlite
make indexer
```

`GET /health` → `{ ok, indexed_slot, chain_slot, lag, complete }`. `GET /markets`, `GET /book/:market`. Persist `INDEXER_DB`. Serve the API over **HTTPS**.

On a public host: do **not** mount `.demo-config.json` or `.demo-faucet.json`. Strip `/admin/*` and `/faucet/*` at the proxy. Those routes mint test USD and sign pause/settle/override — localnet only. `/admin` in the frontend is the same convenience.

**Keeper on a public cluster:** `KEEPER_ORACLE=pyth` (Hermes → `PriceUpdateV2` → adapter crank → finalize → settle). Default `harness` writes a mock feed that does not exist on devnet. Capture at the close (Pyth equity is RTH-only). A Pyth last trade is still not G11. Prod shape is scheduled jobs + `onAccountChange` (`make keeper-prod` / `scheduler.ts`); the 5s poll is localnet. Load the operator key from a secret store; `.env.example` declares `OPERATOR_KEYPAIR_PATH` (keeper still reads `.demo-config.json` today). Unattended ops need `ALERT_WEBHOOK_URL` (#10).

**Market-maker:** same host pattern. `MM_INDEXER` = public indexer. Fund inventory, not protocol authority.

| Variable | Who |
| --- | --- |
| `RPC_URL` | all three |
| `MERIDIAN_PID` / `PORT` / `INDEXER_DB` | indexer |
| `KEEPER_INDEXER` / `MM_INDEXER` | keeper / MM |
| `DEMO_CONFIG` or `DEMO_CONFIG_JSON` | keeper / MM (secret) |
| `KEEPER_STATUS` / `MM_STATUS` | status files |
| `KEEPER_ORACLE=pyth` | required on devnet |
| `OPERATOR_KEYPAIR_PATH` | intended prod keeper |
| `ALERT_WEBHOOK_URL` | unattended ops |

### Railway (indexer + keeper)

One root `Dockerfile`; `SERVICE_ENTRY` picks the process. Frontend stays on Vercel. Dedicated RPC is a secret. `.demo-config.json` becomes `DEMO_CONFIG_JSON` — never baked into the image (`.dockerignore` excludes it).

```text
railway init                  # or railway link
# Dashboard: two services from this repo — indexer (public), keeper (private)
```

| Service | `SERVICE_ENTRY` |
| --- | --- |
| indexer | `services/indexer/src/index.ts` (image default) |
| keeper | `services/keeper/src/scheduler.ts` |

Volume each at `/data`: indexer `INDEXER_DB=/data/indexer.sqlite`; keeper `KEEPER_LEDGER=/data/keeper-ledger.json`, `KEEPER_LOCK=/data/keeper.lock`.

| Var | indexer | keeper |
| --- | --- | --- |
| `RPC_URL` | secret | secret |
| `MERIDIAN_PID` | `HiREMEBW…` | — |
| `PORT` | `8080` | — |
| `INDEXER_DB` | `/data/indexer.sqlite` | — |
| `KEEPER_ORACLE` | — | `pyth` |
| `DEMO_CONFIG_JSON` | — | full `.demo-config.json` (secret) |
| `KEEPER_INDEXER` | — | `http://<indexer-service>.railway.internal:8080` |
| `KEEPER_LEDGER` / `KEEPER_LOCK` | — | `/data/…` |
| `KEEPER_STATUS` | — | `/tmp/keeper-status.json` |
| `KEEPER_PYTH_CAPTURE` | — | `at-close` |
| `KEEPER_SCHED_TICK_SECS` | — | `60` |

```bash
railway variables --service keeper  --set "DEMO_CONFIG_JSON=$(cat .demo-config.json)"
railway variables --service keeper  --set "RPC_URL=<dedicated-rpc>"
railway variables --service indexer --set "RPC_URL=<dedicated-rpc>"
railway up
```

Indexer binds `::` (Railway IPv6 DNS). Keep the keeper private. A public indexer domain exposes `/admin/*` and `/faucet/*` unless you gate them.

Verify: indexer `GET /health` `ok: true`, small `lag`; `GET /markets` lists seeded Outcome Markets. Keeper logs `oracle = pyth` and ticks; at `close_ts` it finalizes + settles. Confirm `DEMO_CONFIG_JSON` / `RPC_URL` are secrets.

HA later is a Redis/BullMQ wiring change (ADR-0035), not a rewrite. One keeper worker is correct until then.

---

## 3. Frontend (Vercel)

Next.js 14 App Router in `frontend/`. Wallet UX only — users sign. No operator / governance / pause / override / upgrade keys.

| Variable | Localnet | Vercel |
| --- | --- | --- |
| `NEXT_PUBLIC_RPC` | `http://127.0.0.1:8899` | `https://api.devnet.solana.com` or a dedicated HTTPS RPC |
| `NEXT_PUBLIC_INDEXER` | `http://127.0.0.1:8787` | `https://<indexer-host>` |
| `NEXT_PUBLIC_MERIDIAN` | `HiREMEBW…` | same unless `declare_id!` changed |

`NEXT_PUBLIC_*` is inlined at **build** time. Site is HTTPS, so indexer and RPC must be HTTPS.

Git import: Root Directory `frontend`, Next.js, `pnpm install` / `pnpm build`. If install misses the workspace lockfile, set Root Directory to `.` and Build to `pnpm --filter @meridian/frontend build`. Set the three env vars on Production **and** Preview.

CLI:

```bash
cd frontend
pnpm exec vercel login && pnpm exec vercel link
pnpm exec vercel env add NEXT_PUBLIC_RPC production   # same for INDEXER, MERIDIAN
pnpm exec vercel --prod
```

| Check | Expect |
| --- | --- |
| `https://<app>/markets` | cards from `GET {INDEXER}/markets` |
| Console | no mixed-content / CORS errors |
| Wallet | Phantom against `NEXT_PUBLIC_RPC` (devnet) |
| `https://<indexer>/health` | `ok: true`, small `lag` |

`/` is the landing page. Do not advertise `/admin` or back it with a signing indexer. Do not put keypairs, `.demo-config.json`, SQLite, or provider API keys on Vercel. The app constructs Meridian transactions only — never a supported OpenBook order-creation tx.

---

## 4. Smoke

1. `solana program show HiREMEBW… -u devnet` — executable present; upgrade authority is the deployer (or Squads vault after M6).
2. Config PDA stores captured OpenBook identity + Circle USDC.
3. Indexer `/health` and `/markets` match the seed.
4. Vercel `/markets` shows the same set; Trade shows a mirrored book when a Venue Market is attached.
5. A **devnet** wallet can mint a Pair and place a PostOnly limit.

Local UI rehearsal (not oracle proof): `make demo` — `localnet` feature, test USD, synthetic clock.

---

## 5. Localnet → M6 checklist

**[done]** localnet-proven · **[ops]** keys / network · **[code]** still to write · **[gate]** non-waiverable.

- [ ] **0 · Keys [ops]** Deployer funded (~4–6 SOL + venue rent). Dedicated operator hot key. Governance / pause / override chosen. `.env` from `.env.example`; `keys/` gitignored.
- [x] **1 · Strict build [done]** `make build-devnet` + manifest (#23). Settlement reads the owner-pinned feed in both builds. Writer is the Pyth adapter (`make pyth-settle-e2e`).
- [ ] **1 · Capture [ops]** OpenBook + adapter identity env (tables above).
- [ ] **1 · G11 bounds [gate]** Sign `min_samples`, `max_stale_slots`, `max_sample_spread_bps`, `max_price_band_bps` before treating them as frozen.
- [ ] **2 · Deploy [ops]** Both `.so` files. Publish ProgramData / slot / hash / authority.
- [ ] **2 · ALT [code]** Freeze the deployment Address Lookup Table (ADR-0025).
- [ ] **3 · Config [ops]** `initialize_config` with real quote mint, identity snapshot, roles, quality bounds. Verify stored OpenBook snapshot.
- [x] **4 · Adapter [done]** `programs/pyth-adapter` + `KEEPER_ORACLE=pyth`.
- [ ] **4 · Register [ops]** `scripts/register-pyth-transports.ts` per MAG7 ticker.
- [ ] **4 · `oracle-e2e-devnet` [gate]** Real Nasdaq Official Close. Synthetic / Pyth last trade cannot pass (ADR-0028). See [`ORACLE_SETUP.md`](./ORACLE_SETUP.md).
- [ ] **5 · Metadata [ops]** Permanent JSON URI before mint (ADR-0016); not `https://meridian.markets`.
- [ ] **6 · Automation [ops]** Keeper `KEEPER_ORACLE=pyth` + market-maker on dedicated RPC. `make demo-devnet` seed is labeled synthetic.
- [ ] **7 · Identity monitor [code]** #25 — alert on OpenBook / adapter owner, ProgramData, slot, hash, authority drift.
- [ ] **8 · Squads 2-of-3 [gate]** Inputs in `.env.example` (`SQUADS_V4_*`, three member pubkeys, threshold 2, vault index 0, timelock 0 = **devnet final-demo only**). Authority is the **vault PDA**, never the multisig account or a member. Prove 1-of-2 cannot execute, 2-of-2 can. After a version-identical upgrade: slot changed, hash unchanged, former deployer cannot upgrade. Repeat for Override Authority on a **separate** vault (non-demo). Blocked on #11.
- [ ] **9 · Clean clone [gate]** README documents `make demo`, `make demo-devnet`, `make oracle-e2e-devnet`, synthetic-vs-real labels, devnet-only scope. Fresh clone, README only, all three targets pass.

### Still open

| Gap | Effect |
| --- | --- |
| Adapter on **devnet** (#16 ops) | Deploy + register. Local proof is not cluster proof. |
| Official-Close provider (#9) | Blocks G11 / `oracle-e2e-devnet`. |
| Identity-drift monitor (#25) | Hand-check ProgramData / slot / hash / authority after deploy. |
| Public indexer admin/faucet | Proxy-deny; no demo key files. |
| Squads transfer (M6) | Single-key upgrade is POC-only. |
| `OPERATOR_KEYPAIR_PATH` in keeper | Still `.demo-config.json`. |
