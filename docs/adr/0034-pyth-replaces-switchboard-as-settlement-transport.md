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

**Consequences.** ADR-0021 (Official Close semantics), ADR-0023 (atomic record,
permissionless first-valid finalization), and ADR-0030 (monitored fail-closed
executable identity) keep their decisions; where they say "Switchboard" read
"the Pyth adapter". The identity-drift monitor (#25) watches the adapter's
ProgramData/authority as it does OpenBook's. The keeper's settlement runner
(ADR-0031) gains a close-time capture step ahead of the close+20m finalize.
`docs/ORACLE_SETUP.md` is the Pyth runbook; ARCHITECTURE v1.2 / PRD v0.8 carry
the wording.
