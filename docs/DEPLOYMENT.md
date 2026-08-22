# Meridian — Deployment

How to put the three runtime surfaces on **Solana devnet**:

1. **Programs** — `programs/meridian` on the cluster.
2. **Services** — indexer, keeper, market-maker on a long-running host.
3. **Frontend** — Next.js app under `frontend/`, hosted on **Vercel**.

This is the operator how-to. Acceptance gates and identity capture live in
[`DEVNET_DEPLOY.md`](./DEVNET_DEPLOY.md). Off-chain topology and open infra
decisions live in [`PRODUCTION_INFRA.md`](./PRODUCTION_INFRA.md). Config
roles, upgrade authority, and key custody live in
[`GOVERNANCE.md`](./GOVERNANCE.md).

**Scope:** Solana **devnet** (and localnet for rehearsal). Do not deploy to
mainnet or use real funds. Do not deploy `programs/m0-harness` — it is
validation scaffolding, not the product program.

---

## Deploy order

```text
build + deploy meridian.so
        ↓
initialize Config (+ register transport, create Outcome Markets)
        ↓
start indexer  →  then keeper / market-maker
        ↓
deploy frontend on Vercel (needs a public HTTPS indexer + a public RPC)
```

The frontend cannot talk to `localhost`. Deploy services (at least the
indexer) to a public HTTPS URL **before** the Vercel production build, or
the Markets page will be empty.

---

## Fixed identities

| Thing | Value |
| --- | --- |
| Meridian program id | `HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD` |
| OpenBook V2 v1.7 (canonical) | `opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb` |
| OpenBook ProgramData | `DktN5HJ9uHKVRZ7FXGap4PEGVnEdc2VNBCXTt1AqJQYB` |
| Circle Devnet USDC | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Metaplex Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` |

Never reference the inert OpenBook copy `923gYkFC…` (ADR-0029). V1 binds
only to the canonical deployment (ADR-0030).

---

## 1. Programs

### Prerequisites

- Solana CLI (pin evidence used **3.1.13**), `cargo-build-sbf`, Anchor **0.31.1**.
- Cluster: `solana config set --url https://api.devnet.solana.com`.
- A **deployer / upgrade** keypair funded on devnet (~4–6 SOL for this
  binary, plus rent if you will also create venues). This key is cold.
  Do not load it into any service.
- A dedicated **operator** hot keypair (not the deployer), funded with SOL
  for create / attach / crank / settle transactions.
- Program keypair whose pubkey matches `declare_id!`:
  `wallets/meridian-program.json`. That path is gitignored. Generate one
  whose pubkey is `HiREMEBW…`, or change both `declare_id!` and this file
  together. `make build-devnet` copies it to
  `target/deploy/meridian-keypair.json`.

Copy the env template and keep secrets **outside** git:

```bash
cp .env.example .env
```

### Build (strict / no `localnet` feature)

```bash
make fixture-verify
make build-devnet
```

This compiles only `programs/meridian` **without** `--features localnet`,
so the real schedule and settlement-delay floors stay on. It does **not**
build the harness. It writes `target/deploy/meridian.so` and
`target/deploy/meridian-devnet.manifest`:

```text
commit  <git HEAD>
sha256  <executable SHA-256>
program HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD
```

Record the manifest with the deployment. The build never auto-commits it.

`make build` (localnet feature + harness) is for `make demo` / tests only.
Do not deploy that `.so` to devnet.

### Deploy the executable

```bash
solana program deploy target/deploy/meridian.so \
  --program-id wallets/meridian-program.json \
  --upgrade-authority <deployer-keypair.json> \
  -u devnet
```

Then publish, as required by ADR-0024 / DEVNET_DEPLOY Phase 2:

- ProgramData address
- deployment slot
- executable SHA-256 (from the manifest)
- upgrade authority (the deployer pubkey, until the M6 Squads transfer)

```bash
solana program show HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD -u devnet
```

### Capture OpenBook identity before `initialize_config`

Config stores a snapshot of the OpenBook executable. A later mismatch
fails closed. Capture and keep:

| Env | Meaning |
| --- | --- |
| `OPENBOOK_PROGRAMDATA_ADDRESS` | already pinned in `.env.example` |
| `OPENBOOK_DEPLOYMENT_SLOT` | current slot of the canonical artifact |
| `OPENBOOK_EXECUTABLE_SHA256` | 32-byte hex of the deployed bytes |
| `OPENBOOK_UPGRADE_AUTHORITY` | current authority (canonical deployment retains one) |

See DEVNET_DEPLOY Phase 1 and ADR-0030.

### Initialize Config (and optional seed)

`initialize_config` is a one-time instruction. Localnet placeholders
(`0xaa…` OpenBook hash, self-minted test USD) **must not** be reused.

Minimum real values:

- `quote_mint` = Circle Devnet USDC above
- OpenBook ProgramData + slot + SHA-256 + upgrade authority from the
  capture step
- roles: governance, operator, pause authority, override authority
  (distinct / multisig for anything beyond a labeled demo — ADR-0024)

The seed pins the **Pyth adapter** (`programs/pyth-adapter`, ADR-0034) as
each ticker's transport: `ORACLE_PROGRAM_ID` is the adapter's program id and
the per-ticker feeds are its derived delivery PDAs (no feed list to supply).
The adapter must be deployed to devnet first (DEVNET_DEPLOY Phase 4).

With the env set:

```bash
export RPC_URL=https://api.devnet.solana.com   # or a dedicated provider
export DEMO_MODE=devnet
export GOVERNANCE_KEYPAIR=/path/to/governance.json
export OPERATOR_KEYPAIR_PATH=/path/to/operator.json
export QUOTE_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
export OPENBOOK_EXECUTABLE_SHA256=<64 hex chars>
export OPENBOOK_UPGRADE_AUTHORITY=<pubkey>
export METADATA_URI=https://…                 # permanent JSON, ADR-0016
export ORACLE_PROGRAM_ID=Egc4ykuRJaDz7VfWS9EB9U2hsP2aU9repCCk8XGnk7w4   # pyth-adapter
make demo-devnet
```

`scripts/seed-demo.ts` writes `.demo-config.json` (secret key material).
That file is gitignored. Never upload it to Vercel or commit it.

Upgrade-authority transfer to a Squads V4 2-of-3 vault PDA is the M6
gate — DEVNET_DEPLOY Phase 8. Do not treat a single-key upgrade authority
as the final demo.

---

## 2. Services

Three Node processes under `services/`. They are **long-running**. They
do not belong on Vercel (no persistent loop, no `better-sqlite3` native
addon, and the keeper/market-maker hold keys).

| Service | Role | Holds a key? | Port / output |
| --- | --- | --- | --- |
| `services/indexer` | Read-only projection + JSON API | no | `PORT` (default `8787`) |
| `services/keeper` | EventHeap crank + settle-at-close | **operator** | `.keeper-status.json` |
| `services/marketmaker` | Demo two-sided Yes/USDC quotes | **market-maker / operator** | `.mm-status.json` |

On-chain safety does not depend on these processes. The program
re-validates every instruction. Services are for liveness and the read
path the frontend uses. See PRODUCTION_INFRA.

Install once from the repo root (`pnpm-workspace.yaml` includes all
three plus `frontend` and `packages/sdk`):

```bash
pnpm install
```

### Indexer (required for the Vercel app)

Polls `getProgramAccounts` for Outcome Market accounts, upserts SQLite,
serves JSON. CORS is already `*` (`services/indexer/src/api.ts`).

```bash
export RPC_URL=https://<your-devnet-rpc>
export MERIDIAN_PID=HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD
export PORT=8787
export INDEXER_DB=/var/lib/meridian/indexer.sqlite
make indexer
# or: cd services/indexer && pnpm start
```

Health: `GET /health` returns `{ ok, indexed_slot, chain_slot, lag, complete }`.
Markets: `GET /markets`. Book: `GET /book/:market`.

**Host shape.** Any always-on Linux box or container host with:

- Node 20+
- persistent disk for `INDEXER_DB` (`better-sqlite3` needs a writable
  filesystem; ephemeral disk loses History Completeness on restart)
- outbound HTTPS to the Solana RPC
- inbound HTTPS on the API port (Caddy, nginx, or the platform proxy)

PRODUCTION_INFRA does not freeze a cloud. A single VM, Fly, Railway, or
Render all work for the current poll loop. Put the indexer on **HTTPS**
so the Vercel origin is not mixed-content.

**Do not expose localnet admin / faucet on a public indexer.** The same
process still serves:

- `GET /faucet/:wallet` — mints 1000 test USD from `.demo-faucet.json`
- `POST /admin/pause`, `/admin/settle/:pk`, `/admin/override/:pk`,
  `/admin/settle-all` — signs with `.demo-config.json` role keys

Those routes are a **localnet demo convenience**. On a public host:

- do not mount `.demo-config.json` or `.demo-faucet.json`
- firewall or strip `/admin/*` and `/faucet/*` at the reverse proxy
- never point a public `NEXT_PUBLIC_INDEXER` at a process that can sign
  pause / settle / override

The frontend `/admin` page calls those routes. Treat it as localnet-only
until the production authority model exists.

### Keeper

```bash
export RPC_URL=https://<your-devnet-rpc>
export KEEPER_INDEXER=https://<your-indexer>
export DEMO_CONFIG=/run/secrets/meridian/demo-config.json
export KEEPER_STATUS=/var/lib/meridian/keeper-status.json
export KEEPER_TICK=5
make keeper
```

By default (`KEEPER_ORACLE=harness`) the loop **publishes the harness mock
Official Close** (`publish_mock_feed` on `programs/m0-harness`). That account
does not exist on devnet. On a public cluster run `KEEPER_ORACLE=pyth`
(Hermes pull → post `PriceUpdateV2` → adapter crank → finalize → settle;
proven by `make pyth-settle-e2e`, ADR-0034), capturing at the close (Pyth
equity feeds are RTH-only). That is still not Official Close proof (G11). EventHeap `consume_events` against a real Venue Market is the part
that is already venue-native.

Prod intent (ADR-0031) is scheduled jobs + `onAccountChange`, not a
1-second poll. The scheduling substrate is still **[open]** in
PRODUCTION_INFRA. The current process is the localnet / rehearsal loop.

Load the operator key from a secret store / `OPERATOR_KEYPAIR_PATH`,
never from the repo. `.env.example` declares the path; reconcile the
keeper to read it before unattended operation (PRODUCTION_INFRA §4).

### Market-maker

Demo liquidity only. Same host pattern as the keeper. Needs USDC + SOL
working capital on the signer in `DEMO_CONFIG`, and
`MM_INDEXER` pointing at the public indexer.

```bash
export RPC_URL=https://<your-devnet-rpc>
export MM_INDEXER=https://<your-indexer>
export DEMO_CONFIG=/run/secrets/meridian/demo-config.json
export MM_STATUS=/var/lib/meridian/mm-status.json
make marketmaker
```

Do not fund this key as if it were a protocol authority. It is inventory.

### Env reference (services)

| Variable | Used by | Notes |
| --- | --- | --- |
| `RPC_URL` | all three | Dedicated provider + priority fees for the keeper (PRODUCTION_INFRA §6) |
| `MERIDIAN_PID` | indexer | Default is the pinned program id |
| `PORT` / `INDEXER_DB` | indexer | Persist the SQLite file |
| `KEEPER_INDEXER` / `MM_INDEXER` | keeper / MM | Public indexer base URL |
| `DEMO_CONFIG` | keeper / MM / localnet admin | Secret; gitignored |
| `KEEPER_STATUS` / `MM_STATUS` | keeper / MM / indexer admin UI | Status files the indexer `/admin/*` reads |
| `OPERATOR_KEYPAIR_PATH` | intended prod keeper | Declared in `.env.example`; wire this before unattended runs |
| `ALERT_WEBHOOK_URL` | unattended ops | Required before leaving the keeper up (issue #10) |

---

## 3. Frontend (Vercel)

The app is Next.js **14.2** App Router in `frontend/`. It is a wallet UX:
it reads the indexer over HTTPS and submits transactions the **user**
signs. It must not receive operator, governance, pause, override, or
upgrade keys.

Public build-time env (see `frontend/next.config.mjs`):

| Variable | Default (localnet) | Devnet / Vercel |
| --- | --- | --- |
| `NEXT_PUBLIC_RPC` | `http://127.0.0.1:8899` | `https://api.devnet.solana.com` or a dedicated HTTPS RPC |
| `NEXT_PUBLIC_INDEXER` | `http://127.0.0.1:8787` | `https://<your-indexer-host>` |
| `NEXT_PUBLIC_MERIDIAN` | `HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD` | same, unless you changed `declare_id!` |

`NEXT_PUBLIC_*` is inlined at **build** time. Changing a value requires a
redeploy. The site is served over HTTPS, so the indexer and RPC must be
HTTPS as well.

`frontend/package.json` has **no workspace runtime dependency**, so Vercel
can treat `frontend/` as the project root.

### A. Git import (usual path)

The repo remote is GitLab (`labs.gauntletai.com`). Vercel can import a
GitLab project.

1. [Vercel](https://vercel.com) → Add New → Project → import this repo.
2. **Root Directory:** `frontend` (Project Settings → General).
3. **Framework Preset:** Next.js.
4. **Install Command:** `pnpm install` (or leave default; there is no
   `frontend` lockfile — the workspace lockfile lives at the repo root.
   If install fails, set Root Directory back to `.` and
   **Build Command** to `pnpm --filter @meridian/frontend build`, or
   enable including files outside the Root Directory so Vercel sees
   `pnpm-workspace.yaml` + the root lockfile).
5. **Build Command:** `pnpm build` (runs `next build`).
6. **Output Directory:** leave default (`.next`).
7. Environment Variables (Production **and** Preview, unless you want
   Preview still on localnet — you do not):

   ```text
   NEXT_PUBLIC_RPC=https://api.devnet.solana.com
   NEXT_PUBLIC_INDEXER=https://<your-indexer-host>
   NEXT_PUBLIC_MERIDIAN=HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD
   ```

8. Deploy.

Public `api.devnet.solana.com` rate-limits. A dedicated RPC is the
PRODUCTION_INFRA recommendation once anyone besides you is clicking.

### B. Vercel CLI (from a laptop)

```bash
# from repo root
pnpm install
cd frontend
pnpm exec vercel login
pnpm exec vercel link          # create / link the project; set root to frontend if asked
```

Set env on the linked project, then deploy:

```bash
pnpm exec vercel env add NEXT_PUBLIC_RPC production
pnpm exec vercel env add NEXT_PUBLIC_INDEXER production
pnpm exec vercel env add NEXT_PUBLIC_MERIDIAN production

pnpm exec vercel --prod
```

Preview: `pnpm exec vercel` (no `--prod`).

Confirm the build sees the values — `next.config.mjs` copies them onto
`env`, and `frontend/lib/{wallet,api,meridian}.ts` read
`process.env.NEXT_PUBLIC_*`.

### After deploy

| Check | Expect |
| --- | --- |
| `https://<vercel-app>/markets` | Outcome Market cards from `GET {INDEXER}/markets` |
| Browser console | no mixed-content / CORS errors (indexer already sends `access-control-allow-origin: *`) |
| Wallet connect | Phantom / Solana wallet-adapter against `NEXT_PUBLIC_RPC` |
| `https://<indexer>/health` | `ok: true`, small `lag` |
| Trade / Portfolio | live book + Position State once the wallet has ATAs |

`/` redirects to `/markets`. `/admin` is the localnet ops console — do
not advertise it, and do not back it with a signing indexer.

### What not to put on Vercel

- `OPERATOR_KEYPAIR_PATH`, governance / pause / override / upgrade
  keypairs, `.demo-config.json`, `.demo-faucet.json`
- `INDEXER_DB` or any SQLite file
- Official-Close provider secrets (`MASSIVE_SIP_API_KEY`, Alpaca keys)
- A rewrite that proxies `/admin` or `/faucet` to a signing indexer

The frontend constructs Meridian transactions only. Users sign in-wallet.
Never construct a supported OpenBook order-creation transaction in the
app — Meridian PDAs are the only order-creation path.

---

## 4. Smoke test (full stack)

1. `solana program show HiREMEBW… -u devnet` — executable present,
   upgrade authority is the expected deployer (or Squads vault after M6).
2. Config PDA `findProgramAddress(["config"], meridian)` exists and
   stores the captured OpenBook identity + Circle USDC.
3. Indexer `GET /health` and `GET /markets` return the seeded / created
   Outcome Markets.
4. Vercel `/markets` shows the same set; Trade shows a mirrored Yes/No
   book when a Venue Market is attached.
5. A user wallet on **devnet** can mint a Pair and place a PostOnly
   limit (no mainnet wallet, no real USDC).

Local rehearsal of the same UI, without Vercel:

```bash
make demo          # validator + seed + indexer :8787 + frontend :3100
```

That path uses the `localnet` program feature, a self-minted six-decimal
**test USD** (never labeled USDC), and a synthetic settlement clock. It
does not prove Official Close correctness (ADR-0028).

---

## 5. Known gaps that block a “real” public demo

These are already on the DEVNET_DEPLOY board; listed here so a deploy
is not mistaken for M6 acceptance.

| Gap | Effect on this runbook |
| --- | --- |
| Pyth adapter on devnet (#16) | Code done + proven locally; adapter deploy, identity capture (`ORACLE_*`) and transport registration are ops. A Pyth last trade is not the Nasdaq Official Close — G11 calibration (#9) remains. |
| Identity-drift monitor (#25) | No automated ADR-0030 alert yet. Re-check OpenBook ProgramData / slot / hash / authority by hand after deploy. |
| Keeper default is the harness mock | Run `KEEPER_ORACLE=pyth` on devnet; never the harness mode. |
| Public indexer still has admin/faucet routes | Proxy-deny them; do not mount demo key files. |
| Squads 2-of-3 upgrade transfer (M6) | Single-key upgrade authority is POC-only. |
| `make oracle-e2e-devnet` | Non-waiverable G11. Synthetic evidence cannot satisfy it. |

---

## Related docs

| Doc | Owns |
| --- | --- |
| [`DEVNET_DEPLOY.md`](./DEVNET_DEPLOY.md) | Devnet acceptance checklist, wallets to seed, M6 Squads choreography |
| [`PRODUCTION_INFRA.md`](./PRODUCTION_INFRA.md) | Keeper schedule vs poll, redundancy, secrets, observability |
| [`GOVERNANCE.md`](./GOVERNANCE.md) | Config roles, two-step rotation, upgrade authority, key custody |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Accounts, CPI, service boundaries |
| [`.env.example`](../.env.example) | Env names; copy to `.env`, never commit |
| [`adr/0030-bind-to-the-canonical-openbook-deployment-with-monitored-identity.md`](./adr/0030-bind-to-the-canonical-openbook-deployment-with-monitored-identity.md) | OpenBook identity pin |
