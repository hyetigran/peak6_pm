# Pyth replaces Switchboard as the settlement transport

ADR-0021/0023/0030 describe the settlement transport as a Switchboard On-Demand
feed: a custom OracleJob (`httpTask → jsonParseTask`) against a paid
Official-Close provider, normalized into the delivery layout that
`finalize_settlement_normal` reads from an owner-pinned account. That path could
not put a single value on-chain until the provider (#9) was chosen and
provisioned, and it required a second normalizer program on top of Switchboard.
Meanwhile Pyth publishes free MAG7 equity feeds on Solana (pull model: signed
update from Hermes → `PriceUpdateV2` via the Pyth receiver), and the Meridian
Pyth adapter (`programs/pyth-adapter`, `Egc4ykuRJaDz7VfWS9EB9U2hsP2aU9repCCk8XGnk7w4`)
already reads such an update and writes the frozen delivery layout into a
per-ticker PDA it owns (`[b"delivery", ticker_id]`). `make pyth-settle-e2e`
proved the whole loop on localnet: keeper `KEEPER_ORACLE=pyth` → adapter crank →
`finalize` → `settle`, with the Settlement Record's Official Close equal to the
Pyth-delivered value and the cranker's advisory args ignored (audit A1).

**Decision.** Pyth, read through the Meridian Pyth adapter, is the settlement
transport. Switchboard On-Demand is dropped entirely — no OracleJob, no
normalizer, no second transport version. Every Settlement Transport Version pins
the adapter (`oracle_program_id`, ADR-0030 identity snapshot: ProgramData,
deployment slot, executable sha256, upgrade authority), its per-ticker delivery
account (`oracle_feed`), and the Pyth feed id (`oracle_job_hash`, 32 bytes,
e.g. `Equity.US.AAPL/USD`). The keeper captures the price **at the close** —
Pyth equity feeds are regular-hours only and go stale after 16:00 ET — and
finalization keeps reading only the owner-pinned delivery account.

**Program change.** The on-chain fields `switchboard_program_id`,
`switchboard_programdata`, `switchboard_deployment_slot`,
`switchboard_executable_sha256`, `switchboard_upgrade_authority`,
`switchboard_feed`, `switchboard_job_hash` on `FeedVersion` and
`SettlementRecord` (and the `register_transport` arguments) are renamed
`oracle_*`. Borsh is positional, so account layouts, digests, and golden
vectors are unchanged; only names move. Env vars `SWITCHBOARD_*` become
`ORACLE_*` (the adapter's identity); `SWITCHBOARD_FEEDS` disappears because
devnet delivery accounts are derived PDAs.

**What this does not decide.** G11 (ADR-0028) is not satisfied by a Pyth settle.
A Pyth equity price is a last-trade price, not the Nasdaq Official Closing Price
under the recorded Close Method (ADR-0021). `make oracle-e2e-devnet` must still
calibrate the captured-at-close Pyth value against the Official-Close provider
(#9) and publish `docs/adr/settlement-quality-calibration.md`
(`min_samples`, `max_stale_slots`, `max_price_band_bps`) before M1. Synthetic
evidence (`make demo-devnet`, `make pyth-settle-e2e`) remains synthetic.

**Capture window (amendment, #26).** Pyth equity feeds publish during RTH
only, so the reading that *is* the close is the update published at `close_ts`;
"latest" at settlement (~close+20m) is the same tick on a good day and a
stale/wrong one otherwise. Two changes, both sides of the seam:

- *Program (strict build).* `finalize_settlement_normal` reads `observed_ts`
  (the oracle publish time, delivery offset 24) from the owner-pinned delivery
  account — the caller arg is advisory like the rest — records it as
  `official_close_observed_ts` / `provider_observed_ts`, and adds a Settlement
  Quality Predicate condition: `close_ts − 60s ≤ observed_ts ≤ close_ts + 900s`,
  else `ObservedOutsideCloseWindow`. This is a deliberate Meridian change (the
  #26 text said "Meridian never changes"): without it a cranker could settle on
  a stale pre-close tick or a later print, which ADR-0023's fail-closed rule
  forbids. The bounds are initial engineering values; the settlement-quality
  calibration ADR (G11) may tighten them. The `localnet` feature skips this one
  check so the synthetic demo (closes at now+20s against a weekend feed) runs.
- *Keeper.* `KEEPER_PYTH_CAPTURE=at-close` (default) selects the update with
  Hermes' at-timestamp endpoint. That endpoint returns the **first update
  at-or-after** the requested time, so the keeper probes a descending ladder
  (`close, −1s, −5s, −15s, −60s`) and keeps the first result whose
  `publish_time` is in-window, failing closed if none; the adapter's
  `max_age_secs` is sized to `(now − close_ts) + 300s` so that update is still
  accepted at settlement. This is a back-dated query at settlement time; the
  scheduled close-time capture *step* remains ADR-0031 / #19. `latest` is
  demo-only.

**Consequences.** ADR-0021 (Official Close semantics), ADR-0023 (atomic record,
permissionless first-valid finalization), and ADR-0030 (monitored fail-closed
executable identity) keep their decisions; where they say "Switchboard" read
"the Pyth adapter". The identity-drift monitor (#25) watches the adapter's
ProgramData/authority as it does OpenBook's. The keeper's settlement runner
(ADR-0031) gains a close-time capture step ahead of the close+20m finalize.
`docs/ORACLE_SETUP.md` is the Pyth runbook; ARCHITECTURE v1.2 / PRD v0.8 carry
the wording.
