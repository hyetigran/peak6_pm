# Meridian — Oracle Setup (Switchboard On-Demand)

Runbook to stand up the real settlement oracle on devnet and close **#16** /
DEVNET_DEPLOY **Phase 4**. The program side (audit **A1**) is already done: in
both builds `finalize_settlement` READS the Official Close from an owner-pinned
delivery account and never trusts the cranker's args (`20f1545`). What remains
is the **writer** — the thing that gets a real Nasdaq NOCP on-chain in the exact
layout the program reads.

---

## Two tracks (decided)

A generic oracle gives a *live* price; only a data provider gives the Nasdaq
**NOCP** (closing-auction print, ADR-0021). So the work splits:

- **Synthetic demo track — Pyth adapter (started).** Pyth publishes **free MAG7
  equity feeds** on Solana devnet (verified below). It's a *live* price, not the
  NOCP, so it can't satisfy G11 — but it settles the whole path end-to-end for
  $0 with no provider, which is exactly `demo-devnet` (explicitly synthetic,
  ADR-0028). Built as `programs/pyth-adapter` (option 2 — a swappable adapter;
  Meridian never changes).
- **Real-NOCP track — Switchboard (below).** The custom-job → paid provider
  (#9) path that carries the actual Official Close for `oracle-e2e-devnet` (G11).
  The Switchboard adapter is a second adapter registered as another transport
  version; Meridian is untouched between the two.

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
record.switchboard_feed`) and the **owner pin** (`delivery.owner ==
record.switchboard_program_id`, `WrongDeliveryOwner`). Plus the frozen quality
bounds: `official_close > 0`, `halt_status` ∈ the whitelist, `sample_count ≥
min_samples`, and `cur_slot − delivery_slot ≤ max_stale_slots`.

This is **not** Switchboard's native `PullFeed` layout — which drives the
architecture choice below.

---

## Decision 1 — architecture: normalizer (recommended) vs native parse

- **(b) Normalizer program [recommended].** A small devnet program reads the
  Switchboard `PullFeed`, attaches the ADR-0021 semantics Switchboard doesn't
  carry (Nasdaq **close method** / **halt status**), and writes the normalized
  layout above into an account it owns. `register_transport`'s
  `switchboard_program_id` = the **normalizer's** id (so the owner pin points at
  it). This is the devnet twin of the localnet `m0-harness` mock feed — both
  present the same layout, so localnet and devnet stay symmetric, and Meridian
  stays decoupled from Switchboard's account format. It matches the program as
  built (it already reads the normalized layout).
- **(a) Native parse.** Change `finalize_settlement` to parse Switchboard's
  `PullFeed` account directly; `switchboard_program_id` = Switchboard's real id.
  No extra program, but Meridian couples to Switchboard's layout **and** you
  must source `halt_status`/close-method elsewhere (a generic price feed has no
  "official close" concept). Undoes part of the A1 change.

**This runbook assumes (b).** Halt/close-method have no home under (a), and (b)
keeps the exact contract already shipped and tested.

## Decision 2 — the Official-Close data source (**#9**, ops)

Switchboard On-Demand runs an **OracleJob** (an `httpTask` → `jsonParseTask`
pipeline) against a **data provider's HTTPS API**. You must choose that provider
and its endpoint — the unadjusted Nasdaq **NOCP** per MAG7 ticker, ideally with
the close method / halt status (ADR-0021). The PRD names Massive SIP + Alpaca
SIP cross-check as the calibration method. **Nothing below can be simulated or
deployed until #9 names the provider and access is provisioned.** Public HTTPS
only — localhost / RFC1918 / `.local` are rejected.

---

## Steps

### 1. Pick the provider + endpoints  **[ops — #9]**
Name the provider; get the per-ticker HTTPS endpoint and the JSON path to the
NOCP (and close-method/halt fields, if available). Record the decision (ADR or
note) before G11.

### 2. Design + simulate the OracleJob  **[both]**
One `OracleJob` per ticker: `httpTask { url }` → `jsonParseTask { path }` →
(scale to 1e6). I can write the TS. Simulate every job against
`https://crossbar.switchboard.xyz/api/simulate` and confirm it returns the
expected NOCP before spending any SOL. Store the job on Crossbar (IPFS) and
record each **job hash** — `register_transport` pins it (`switchboard_job_hash`).

### 3. Create the On-Demand pull feeds on devnet  **[both]**
Using `@switchboard-xyz/on-demand` + `@switchboard-xyz/common`:
`getDefaultDevnetQueue(rpc)` (public devnet queue
`uPeRMdfPmrPqgRWSrjAnAkH78RqAhe5kXoW6vBYRqFX`) → `PullFeed.initTx(...)` with the
job → send with `asV0Tx` (priority fees). One feed per MAG7 ticker. Capture each
**feed pubkey**. I can script this; you run it with a funded devnet key.

### 4. Build + deploy the normalizer program  **[code — me]**
A minimal Anchor program (the devnet analog of `m0-harness`):
`crank(pull_feed, delivery)` — reads the Switchboard `PullFeed` update
(CPI/account read), applies the quality gate, and writes
`official_close_1e6 / delivery_slot / halt_status / sample_count` into a
per-ticker `delivery` account it **owns**. I write + unit-test it; you deploy it
to devnet and record its **program id + ProgramData + slot + sha256 + upgrade
authority** (ADR-0030 identity capture).

### 5. Capture identities  **[ops]**
For `register_transport` you need: the **normalizer** identity (id/programdata/
slot/sha/authority — the owner-pin + ADR-0030 snapshot), each **delivery account
pubkey**, each **job hash** (step 2), and `provider_id` / `close_method_id`
(ADR-0021). Also capture Switchboard's own On-Demand program identity for the
normalizer to pin internally.

### 6. Register the transports  **[both]**
One `register_transport` per ticker (governance-signed): `switchboard_program_id`
= the normalizer id, `switchboard_feed` = the delivery account, plus the pinned
identity fields, `switchboard_job_hash`, `provider_id`, `close_method_id`,
`activated_trading_day`. I script it; you sign with governance. This snapshot is
what settlement fails-closed against.

### 7. Wire the keeper crank  **[code — me]**
Replace the localnet mock-feed publish with the devnet flow, per settlement
tick: **(a)** pull a fresh Switchboard update (`fetchUpdateIx`), **(b)** call the
normalizer `crank` to write the delivery account, **(c)** `finalize_normal` +
`settle_market` (unchanged — it just reads the account). Also feed the delivery
pubkeys to the seed as `SWITCHBOARD_FEEDS` so `make demo-devnet` (#24) can
register + create markets.

### 8. Prove it  **[both]**
`make oracle-e2e-devnet` (to author) — the non-waiverable G11: a real Nasdaq
NOCP flows provider → Switchboard → normalizer → `finalize` → `settle`, with
freshness/quality-bound rejection vectors and the dispute/correction path
(ADR-0028; synthetic evidence cannot satisfy it). Blocked on #9 + a live run.

---

## What I can build now (no #9 needed) vs what's blocked

**Startable now [code]:** the **normalizer program** (step 4) + its unit tests
against the fixed delivery layout; the **register_transport** script (step 6);
the **keeper crank** restructure (step 7) behind the existing devnet flag. These
don't need the provider — only the feed *values* do.

**Blocked on #9 / a funded devnet [ops]:** the OracleJob endpoints (step 2), the
live feeds (step 3), deployment + identity capture (steps 4–5), and the e2e
proof (step 8).

So the critical path is still **#9 first**. Once the provider is named I can also
write the OracleJob + feed-creation scripts (steps 2–3).

---

Sources (verify against current Switchboard docs — the SDK evolves):
[On-Demand deploy guide](https://docs.switchboard.xyz/product-documentation/data-feeds/solana-svm/part-2-deploying-your-feed-on-chain) ·
[Designing a feed (TS)](https://docs.switchboard.xyz/product-documentation/data-feeds/solana-svm/part-1-designing-and-simulating-your-feed/option-2-designing-a-feed-in-typescript) ·
[on-demand SDK](https://github.com/switchboard-xyz/on-demand) ·
[On-Demand app (devnet)](https://ondemand.switchboard.xyz/solana/devnet)
