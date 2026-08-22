# Scheduling substrate: cron + single-flight lock + a durable run-ledger

ADR-0031 decided the production keeper is scheduled jobs, not a poll loop, and
`PRODUCTION_INFRA.md` §2 left the *substrate* **[open]**: `cron` + a locked
script, a job runner with repeatable jobs (BullMQ/Redis), a durable workflow
engine (Temporal), or cloud-native (EventBridge/Cloud Scheduler → worker). This
ADR closes that item for V1.

**Context.** The daily lifecycle (PRD §5) fixes the times, so the automation
service is only **two time-triggered jobs per trading day** — settlement at
`close_ts + normal_settlement_delay_secs`, and the market-open/`add_strike` job
at resolution+5m (ADR-0032) — at minute granularity, plus event-driven
EventHeap cranking (#20). Crucially, **every on-chain action is idempotent**
(ADR-0031/0023): `finalize_settlement_normal` no-ops once `FinalOracle`,
`settle_market` re-checks state, market/venue creation is unique-PDA. So the
scheduler needs only **at-least-once** delivery and may retry freely — the
property that makes a heavy queue/engine optional rather than required.

**Decision.** V1 uses the smallest substrate that satisfies at-least-once,
dedupe, backoff, and an audit trail without new infrastructure:

- **Trigger:** an external at-least-once scheduler (`cron`, systemd timer, or a
  cloud scheduler) invokes `make keeper-prod` (`services/keeper/src/scheduler.ts`).
  The process itself runs a coarse (minutes) tick that re-reads the indexer and
  fires whatever is due — so a single long-lived invocation and a
  cron-per-tick invocation are equivalent; the tick is not a per-second poll.
- **Single-flight:** a lock file (`KEEPER_LOCK`, stale-reclaimed after 10m)
  refuses to double-run. This is the "scheduler lease / single-flight lock"
  §3 calls for; correctness never depends on it (idempotency does), it only
  avoids wasted duplicate transactions.
- **Run-ledger:** a durable JSON ledger (`KEEPER_LEDGER`) records each job's
  completion (with timestamp — the audit trail) and per-job retry/backoff state.
  A completed `(kind, ticker, day)` is never re-run; a duplicate or retried fire
  is a no-op at the scheduler layer, on-chain idempotency behind it. The pure
  core (`schedule.ts`) and runner (`runner.ts`) are unit-tested without a
  validator; the ledger is flushed after every mutation so a crash resumes.
- **Backoff, not spin:** a job that reports the Official Close is not yet
  published returns `retry`; the runner backs it off (30s→…→15m cap) and
  re-attempts, rather than busy-waiting.
- **Graceful shutdown:** SIGTERM aborts between jobs and drains the in-flight
  job before exit.

**What this is not.** Not a distributed queue, not leader election, not a
workflow engine. Those buy visibility and managed retries but add a broker and
operational surface disproportionate to two idempotent jobs/day.

**Consequences / when to revisit.** Migrate to a job runner (BullMQ) or a
workflow engine (Temporal) if any of: jobs-per-day grows by an order of
magnitude; multi-region active/active needs a shared lease rather than a local
lock; or per-step retry visibility/alerting must be managed rather than
log-and-ledger. The runner is substrate-agnostic (injected clock, ledger,
handlers), so swapping the trigger/lock/ledger for a broker is a wiring change,
not a rewrite. Until then, cron + lock + ledger is the V1 substrate.

**Supersedes the [open] marker** in `PRODUCTION_INFRA.md` §2. Relates to
ADR-0031 (scheduled model), ADR-0023 (atomic idempotent settlement),
ADR-0032 (rolling creation), #19 (implementation), #20 (event-driven cranking).
