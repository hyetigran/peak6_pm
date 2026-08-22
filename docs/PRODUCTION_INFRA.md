# Meridian — Production Infrastructure

Deployment topology for the **off-chain** services. This is the counterpart to
`ARCHITECTURE.md` (which is on-chain / program-focused), `DEVNET_DEPLOY.md`
(a step-by-step acceptance checklist), `DEPLOYMENT.md` (how to deploy
the program, services, and Vercel frontend), and `GOVERNANCE.md`
(Config roles, upgrade authority, and which process may load which key). On-chain safety does not depend on anything
here: the program fails closed, and every off-chain action is idempotent
on-chain, so this layer is about **liveness, cost, and observability**, never
custody. No off-chain service can move funds or write protocol state except by
submitting an instruction the program independently re-validates.

Status legend: **[decided]** recorded in an ADR · **[proposed]** default we
intend unless changed · **[open]** needs a decision (tracked as an issue).

---

## 1. Service inventory and how each runs in prod

| Service | Prod shape | Trigger | Holds a key? |
| --- | --- | --- | --- |
| `services/automation` (keeper) | **scheduler jobs + subscription workers** | time-scheduled + `onAccountChange` (ADR-0031) | operator hot key |
| `services/indexer` | long-running process | continuous log/account subscription | none (read-only) |
| `services/marketmaker` | long-running process, **24/7 while any market is open** | continuous from each market's `trade_open` to `close` (ADR-0033) | market-maker key (demo/liquidity only) |
| `frontend` | static/SSR host | user requests | none (users sign in-wallet) |

The demo runs all of these as an always-on second-by-second loop for the keeper
and a single validator; that is a **localnet affordance**, not this topology.

## 2. Automation (keeper) — the scheduled model  [decided: ADR-0031]

The keeper is **not** a poll loop in prod. The daily lifecycle (PRD §5) fixes
the times, so the automation service is a small number of scheduled jobs plus
event-driven cranking:

- **Settlement job** — scheduler fires at `close_ts + normal_settlement_delay_secs`,
  gated on the Official Close being published; reschedules with backoff if the
  Pyth delivery (adapter crank) is not yet available. Drains any residual EventHeap, then
  `finalize_settlement_normal` → `settle_market` per market.
- **Market-open / `add_strike` job** — fires at **resolution + 5m** (~close+30m),
  off the settlement job's completion, anchored on the just-published Official
  Close (ADR-0032). Runs generate→create→attach (PRD §5, §6) plus an
  eligibility/Corporate-Action-Blackout re-validation gate that `abandon_market`s
  a market that stops qualifying before its mint window (ADR-0014/0022).
- **EventHeap cranking** — `onAccountChange` subscription per active heap; cranks
  only on growth. Inline-first settlement (ID-007) keeps heaps near-empty, so
  this is idle in the common path. A minutes-scale reconcile poll backstops a
  missed event. Never a per-second poll.

Safe because every action is idempotent on-chain (ADR-0031), so the scheduler
needs only at-least-once delivery and may retry freely.

**Scheduling substrate — [decided: ADR-0035, #19].** `cron` (or any
at-least-once trigger) → `make keeper-prod` (`services/keeper/src/scheduler.ts`),
with a **single-flight lock file** (no double-run) and a **durable JSON
run-ledger** (dedupe of duplicate/retried fires + completion audit trail). Two
idempotent jobs/day (ADR-0031/0023) need only at-least-once delivery, so this
beats a broker/engine on operational surface; the runner is substrate-agnostic
(injected clock/ledger/handlers), so migrating to BullMQ/Temporal later is a
wiring change. Settlement backs off (30s→15m cap), does not spin, when the
Official Close is not yet published; SIGTERM drains the in-flight job. The
localnet demo keeps the per-second poll (`make keeper`).

## 3. Redundancy and idempotency  [proposed]

On-chain idempotency (ADR-0031, ADR-0023) means the keeper can run redundantly
without double-effect: a hot standby, or a second instance behind a scheduler
lease, is safe. No custom leader election is required for correctness — only to
avoid wasted duplicate transactions (a scheduler lease or single-flight lock is
enough). The indexer is stateless projection and can run N-way behind a load
balancer; the market-maker is single-writer per market by convention.

## 4. Keys and secrets  [open]

Full custody policy, role matrix, and rotation is [`GOVERNANCE.md`](./GOVERNANCE.md).
This section is only the **service** subset:

- Operator hot key (keeper): today loaded from `.demo-config.json`; prod must
  load from `OPERATOR_KEYPAIR_PATH` / a secret store (KMS, sealed secret), never
  the repo. `.env.example` already declares `OPERATOR_KEYPAIR_PATH`; the keeper
  does not yet read it (reconcile — see audit).
- Upgrade / governance / override authorities are **cold** and move to Squads
  2-of-3 at M6 (ADR-0024, DEVNET_DEPLOY Phase 8) — not held by any service.
- Market-maker key is demo liquidity only; scope and fund it separately.

## 5. Observability and alerting  [open]

- Structured logs + metrics (heap depth vs §8.4 SLOs, settlement latency,
  scheduler job success/lateness, operator SOL balance, RPC error rate).
- **Alert on:** any market past `close_ts + delay` still unsettled; heap depth
  ≥ SLO escalation bands (§8.4); OpenBook/Pyth-adapter identity drift (ADR-0030,
  DEVNET_DEPLOY Phase 7); operator balance low. Webhook receiver: issue #10.
- Graceful shutdown (SIGTERM) so DB WAL checkpoints and in-flight txs settle —
  no service handles signals today (see audit).

## 6. RPC and network  [proposed]

- Dedicated RPC provider with priority-fee support. The keeper now sets a
  priority fee (`KEEPER_PRIORITY_FEE_MICROLAMPORTS`) and retries every send with
  backoff (#19) — tune the fee up on a congested cluster. Still to add: an
  explicit compute-unit *limit* and `getMultipleAccountsInfo` read batching.
- Frozen deployment Address Lookup Table for the runbook account set (ADR-0025).

## 7. Environments

| | Substrate | Oracle | Keeper |
| --- | --- | --- | --- |
| localnet (demo) | single test-validator | harness mock feed (ADR-0028) | 1s poll loop |
| devnet | devnet cluster | Pyth (via `pyth-adapter`) | scheduled jobs + subscription |

Devnet is the current target (DEVNET_DEPLOY.md). This doc does not assume a
specific cloud; it names the shape, and the **[open]** items above are the
decisions to close before Phase 6.
