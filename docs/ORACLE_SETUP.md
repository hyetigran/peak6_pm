# Meridian — Oracle Setup (Pyth)

Runbook to stand up the real settlement oracle on devnet and close **#16** /
DEVNET_DEPLOY **Phase 4**. The program side (audit **A1**) is already done: in
both builds `finalize_settlement` READS the Official Close from an owner-pinned
delivery account and never trusts the cranker's args (`20f1545`). The **writer** is
the Meridian Pyth adapter (`programs/pyth-adapter`, ADR-0034): it reads a Pyth
`PriceUpdateV2` and writes the per-ticker delivery account in the exact layout
the program reads.

---

## The transport (decided — ADR-0034)

Pyth publishes **free MAG7 equity feeds** (verified below) via its pull model;
the adapter is the only oracle program Meridian pins. The honest limit: a Pyth
equity price is a *last trade*, not the Nasdaq **NOCP** (closing-auction print,
ADR-0021). So the adapter settles the whole path end-to-end for $0 with no
provider (`make pyth-settle-e2e`, `demo-devnet` — explicitly synthetic,
ADR-0028), while **G11** still requires calibrating the value captured *at the
close* against the Nasdaq Official Close from the provider in **#9**
(`make oracle-e2e-devnet`). Never claim G11 from a Pyth settle alone.

### Verified Pyth devnet equity feed ids (Hermes, Aug 2026)

| Ticker | Pyth feed id (`Equity.US.<T>/USD`) |
|---|---|
| AAPL | `49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688` |
| AMZN | `b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a` |
| GOOGL | `5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6` |
| META | `78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe` |
| MSFT | `d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1` |
| NVDA | `b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593` |
| TSLA | `16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1` |

Feed ids are chain-agnostic; on devnet the price lands on-chain via Pyth's pull
model (fetch the signed update from Hermes, post via the Pyth receiver → a
`PriceUpdateV2` account), which the adapter reads. Pyth equity feeds are
regular-hours only (9:30–16:00 ET) and go stale after close — so the keeper must
**capture at the close**, not at settlement time (~close+20m). Adapter program
id: `Egc4ykuRJaDz7VfWS9EB9U2hsP2aU9repCCk8XGnk7w4`.

**Proven end-to-end locally.** `scripts/pyth-local.sh` starts a validator that
clones the Pyth receiver + Wormhole (+ receiver config `DaWUKXC…`, guardian set
`6GaHgiaQ…`) from devnet and loads the adapter; `services/keeper/src/pyth-e2e.ts`
then runs the real chain (Hermes pull → post `PriceUpdateV2` → adapter `crank`)
and writes the delivery account. Verified: a real AAPL price landed as
`official_close_1e6=309220030` ($309.22), `halt=1`, `sample_count=255` (Full
verification). Two fixes this surfaced: Hermes must be queried with
`encoding:"base64"` (its v3 default hex → "Invalid accumulator message"), and the
workspace pins `@solana/web3.js` to one version (an old transitive copy broke
`rpc-websockets` ESM resolution). Feed staleness on weekends is handled by a
large `maxAgeSecs` in the harness; production captures at the live close.

**Proven through Meridian settlement (keeper in pyth mode).** `make pyth-settle-e2e`
(`scripts/pyth-settle-e2e.sh`) runs the *whole* loop on localnet: `pyth-local.sh`
now layers the devnet clone on top of the full `localnet.sh` program set; the
seed runs with `DEMO_ORACLE=pyth` (transport = adapter id + per-ticker delivery
PDA, `DEMO_TICKERS=3,7`, closing in 20s); the indexer + keeper start with
`KEEPER_ORACLE=pyth`; then `scripts/pyth-settle-check.ts` asserts the Settlement
Record was finalized FROM the delivery account. Result (2026-08-22): GOOGL record
close `$344.7252` == delivery close, TSLA `$362.7951` == delivery close, both
records pin `feed = deliveryPda(ticker)` / `oracle = Egc4yk…`, state
`FinalOracle`, 10/10 Outcome Markets settled. The keeper's advisory `close1e6`
arg (its mock spot, ~$204/$349) was *ignored* by finalize — the on-chain value
is Pyth's — which is the A1 property under real data. Nonzero exit on any miss.
What this still is NOT: G11 (ADR-0028 — Pyth's equity price is a last trade,
not the Nasdaq Official Close; provider #9 + `oracle-e2e-devnet` remain).

## The delivery contract (what the on-chain account must contain)

`finalize_settlement_normal` reads a **normalized** account (little-endian,
after the 8-byte account header):

| bytes | field | type |
|---|---|---|
| 8..16 | `official_close_1e6` (NOCP × 1e6) | u64 |
| 16..24 | `delivery_slot` (freshness) | u64 |
| 32 | `halt_status` (NormalClose / AfterHalt / Contingency) | u8 |
| 33 | `sample_count` | u8 |
| ≥ 66 total | | |

Two pins are enforced at settlement: the **address pin** (`delivery ==
record.oracle_feed`) and the **owner pin** (`delivery.owner ==
record.oracle_program_id`, `WrongDeliveryOwner`). Plus the frozen quality
bounds: `official_close > 0`, `halt_status` ∈ the whitelist, `sample_count ≥
min_samples`, and `cur_slot − delivery_slot ≤ max_stale_slots`.

This is the layout the adapter writes (`halt_status = NormalOfficialClose`,
`sample_count` = the update's verification level: 255 for Full).

---

## Steps

### 1. Deploy the adapter to devnet + capture its identity  **[ops]**
`make build-adapter`, deploy `target/deploy/pyth_adapter.so` (id
`Egc4ykuRJaDz7VfWS9EB9U2hsP2aU9repCCk8XGnk7w4`), and record the ADR-0030
snapshot that `register_transport` pins: program id, Upgradeable-Loader
ProgramData address, deployment slot, executable sha256, upgrade authority
(`ORACLE_PROGRAM_ID`, `ORACLE_PROGRAMDATA_ADDRESS`, `ORACLE_DEPLOYMENT_SLOT`,
`ORACLE_EXECUTABLE_SHA256`, `ORACLE_UPGRADE_AUTHORITY` in `.env`). An
immutable deployment is preferred; a post-registration upgrade fails closed.

### 2. Register the transports  **[both]**
`RPC_URL=<devnet> DEMO_CONFIG=.demo-config.json pnpm exec tsx scripts/register-pyth-transports.ts`
— one governance-signed `register_transport` per MAG7 ticker with
`oracle_program_id` = the adapter, `oracle_feed` = `deliveryPda(ticker)`
(`[b"delivery", ticker_id]`, stable per ticker, overwritten each settlement),
`oracle_job_hash` = the Pyth feed id from the table above, plus `provider_id` /
`close_method_id` (ADR-0021). The seed does the same on localnet with
`DEMO_ORACLE=pyth`; on devnet the feeds are derived, so no feed list is needed.

### 3. Run the keeper in Pyth mode  **[code — done]**
`KEEPER_ORACLE=pyth`: per settlement, Hermes pull (`encoding:"base64"`) → post
`PriceUpdateV2` via the Pyth receiver → adapter `crank` in the same tx →
`finalize_settlement_normal` (reads the delivery account) → `settle_market`.
**Capture at the close** (#26, enforced both sides): Pyth equity feeds are
RTH-only and stale afterwards, so the keeper (`KEEPER_PYTH_CAPTURE=at-close`,
the default) selects the update published **at `close_ts`** — Hermes' at-timestamp
endpoint returns the first update at-or-*after* a time, so the keeper probes a
descending ladder (`close, −1s, −5s, −15s, −60s`) and keeps the first in-window
result, failing closed if none — and sizes the adapter's `max_age_secs` to
`(now − close_ts) + 300s` so that update is still accepted at settlement
(`services/keeper/src/pyth-capture.ts`). This is a back-dated query at
settlement time; the scheduled close-time capture step is ADR-0031 / #19. The
**strict** Meridian build independently reads `observed_ts` (the Pyth publish
time) from the delivery account and rejects a reading outside
`[close_ts − 60s, close_ts + 900s]` (`ObservedOutsideCloseWindow`), and records
it as `official_close_observed_ts` — a cranker can no longer settle on a stale
pre-close tick or a later print. `KEEPER_PYTH_CAPTURE=latest` +
`KEEPER_PYTH_MAX_AGE_SECS` exist only for the weekend/localnet demo (synthetic
`close_ts`, localnet build relaxes the window).

### 4. G11 — prove it is the Official Close  **[both; blocked on #9]**
`make oracle-e2e-devnet` (to author): the captured-at-close Pyth value is
compared against the Nasdaq NOCP from the Official-Close provider (#9; the PRD
names Massive SIP + Alpaca SIP cross-check as the calibration method), with
freshness/quality-bound rejection vectors and the dispute/correction path
(ADR-0028; synthetic evidence cannot satisfy it). Publishes
`docs/adr/settlement-quality-calibration.md` (`min_samples`, `max_stale_slots`,
`max_price_band_bps`) before M1.

---

Sources (verify against current Pyth docs — the SDK evolves):
[Hermes](https://hermes.pyth.network) ·
[pyth-solana-receiver](https://github.com/pyth-network/pyth-crosschain/tree/main/target_chains/solana) ·
[Pyth price feed ids](https://www.pyth.network/developers/price-feed-ids)
