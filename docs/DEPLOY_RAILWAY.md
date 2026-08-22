# Deploy the backend services to Railway (pattern A)

Deploys the two long-running backend services — **indexer** (web) and **keeper**
(worker) — from this monorepo to Railway. Pattern A (ADR-0035): the keeper is a
single always-on worker with its run-ledger on a volume; no queue/Redis. The
frontend is **not** covered here (send it to Vercel separately).

Both services build from one root `Dockerfile` and differ only in start command.

## 0. Prerequisites

- A Railway account + CLI: `npm i -g @railway/cli` then `railway login`.
- A dedicated devnet RPC (Helius/QuickNode/Alchemy) — the public endpoint
  rate-limits. This is a **secret**.
- The seeded `.demo-config.json` (from `make demo-devnet`) — it holds the
  operator **secret key** + per-ticker transports + trading day. It becomes the
  `DEMO_CONFIG_JSON` secret; never committed, never baked into the image
  (`.dockerignore` excludes it).

## 1. Create the project + two services

```
railway init                      # or: railway link  (existing project)
# In the dashboard add TWO services, both from this repo:
#   - indexer   (public)
#   - keeper    (private only)
```

Both: **Builder = Dockerfile**, path `Dockerfile` (root). Set each service's
**Custom Start Command** (Settings -> Deploy). Run from the repo root (`/app`,
the image WORKDIR) so the keeper's `fixtures/` lookups resolve:

| Service | Start command |
|---|---|
| indexer | `pnpm exec tsx services/indexer/src/index.ts` |
| keeper  | `pnpm exec tsx services/keeper/src/scheduler.ts` |

## 2. Volumes (restart-safe state)

Add a Railway **volume** to each, mounted at `/data`:

- **indexer** `/data` -> `INDEXER_DB=/data/indexer.sqlite` (optional: it re-syncs
  from chain on restart; the volume only saves a cold re-sync).
- **keeper** `/data` -> the run-ledger + single-flight lock (`KEEPER_LEDGER`,
  `KEEPER_LOCK`). Recommended so backoff/dedupe survive a restart (on-chain
  idempotency makes a lost ledger safe, not free).

## 3. Environment variables

**indexer** (mark `RPC_URL` secret):

| Var | Value |
|---|---|
| `RPC_URL` | your Helius devnet URL (secret) |
| `MERIDIAN_PID` | `HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD` |
| `PORT` | `8080` (fixed, so the keeper can address it internally) |
| `INDEXER_DB` | `/data/indexer.sqlite` |

**keeper** (mark `DEMO_CONFIG_JSON` and `RPC_URL` secret):

| Var | Value |
|---|---|
| `RPC_URL` | your Helius devnet URL (secret) |
| `KEEPER_ORACLE` | `pyth` |
| `DEMO_CONFIG_JSON` | full `.demo-config.json` contents (secret — below) |
| `KEEPER_INDEXER` | `http://indexer.railway.internal:8080` (private DNS; use your indexer service's name) |
| `KEEPER_LEDGER` | `/data/keeper-ledger.json` |
| `KEEPER_LOCK` | `/data/keeper.lock` |
| `KEEPER_STATUS` | `/tmp/keeper-status.json` |
| `KEEPER_PYTH_CAPTURE` | `at-close` (default) |
| `KEEPER_SCHED_TICK_SECS` | `60` (minutes-scale; job fire times drive the work) |

Set the operator secret from your machine so the key goes straight into
Railway's secret store, never into the repo or image:

```
railway variables --service keeper  --set "DEMO_CONFIG_JSON=$(cat .demo-config.json)"
railway variables --service keeper  --set "RPC_URL=<your-helius-url>"
railway variables --service indexer --set "RPC_URL=<your-helius-url>"
```

> The keeper reads `DEMO_CONFIG_JSON` (a secret) in preference to any file
> (`services/keeper/src/config.ts`), so no operator key ships in the image.

## 4. Private networking

The keeper reaches the indexer over Railway's private network — no public hop.
The indexer binds `::` (Node default), which Railway's IPv6 internal DNS
requires, on the fixed `PORT=8080`; the keeper's
`KEEPER_INDEXER=http://<indexer-service>.railway.internal:8080` resolves there.
Keep the **keeper private** (no public domain). Give the **indexer** a public
domain only to inspect `GET /markets` / `GET /health` from outside — note its
`POST /settle` and `POST /mint` admin/faucet endpoints would then be publicly
reachable (devnet-only, but gate or keep private for anything real).

## 5. Deploy

```
railway up                 # build the Dockerfile + deploy the linked service
# or connect the GitHub repo for push-to-deploy per service
```

## 6. Verify

- **indexer** `GET /health` -> `{"ok":true,"lag":<small>,"complete":true}`;
  `GET /markets` lists the seeded markets.
- **keeper** logs `oracle = pyth (Hermes pull -> post -> adapter crank; capture=at-close)`
  and periodic scheduler ticks; at a market's `close_ts` it finalizes + settles.
- Confirm the keeper has **no public domain** and that `DEMO_CONFIG_JSON` /
  `RPC_URL` are secrets.

## Notes

- Synthetic (Pyth) demo — not the real Nasdaq Official Close (#9/#16).
- HA / managed retries later = add Railway Redis + switch the runner to BullMQ;
  the runner is substrate-agnostic (ADR-0035), so that is wiring, not a rewrite.
  Until then, one keeper worker is correct.
- Top up the operator hot key on devnet as needed; it cannot pause issued
  markets, override, or touch collateral (role scoping).
