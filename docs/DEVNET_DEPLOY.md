# Meridian — Devnet Deploy Checklist

Status legend: **[done]** proven on localnet · **[code]** needs code before devnet ·
**[ops]** an action requiring the deployer's keys / network / a decision · **[gate]** non-waiverable acceptance gate.

This is the runbook from a green localnet to the M6 devnet acceptance demo. It does **not**
authorize mainnet or real funds — devnet/test value only (ADR-0020, PRD §15).

For the operator how-to (build/deploy the program, run indexer/keeper/market-maker,
host the Next.js app on Vercel) see [`DEPLOYMENT.md`](./DEPLOYMENT.md).
Roles, two-step rotation, upgrade-authority transfer, and key custody:
[`GOVERNANCE.md`](./GOVERNANCE.md).

## Fixed identities (already pinned in the repo)

| Thing | Value | Source |
|---|---|---|
| Meridian program id | `HiREMEBWNojy6KJNbMbww2YkRJEYLGMgndaKwXndK6ZD` | `declare_id!` |
| Deployer / cold upgrade key | `4XT7HdQg59fmvvymZzUa9kWTHxyehCrLQEJHxrsjQfCq` | `~/.config/solana/id.json` (funded 12 SOL) |
| Quote mint (Circle devnet USDC) | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | ADR-0015 |
| OpenBook V2 (canonical) | `opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb` | ADR-0030 |
| Metaplex Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | on devnet already |
| Squads V4 program | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` | M6 manifest |

---

## Phase 0 — Prerequisites [ops]

- [ ] Deployer key funded on devnet with enough SOL for program deploy (~4–6 SOL for this binary size) **plus** rent for markets/venues/OpenBook accounts. Top up `4XT7HdQg…`.
- [ ] A dedicated **operator** hot keypair (NOT the deployer) — see "Wallets that need seeding" below; funded with SOL for keeper/market-creation txs.
- [ ] Governance, pause-authority, override-authority keys chosen (cold; can be the same for the demo, must be distinct/multisig for non-demo — ADR-0024, ARCH §role table).
- [ ] `.env` created from `.env.example` (to be authored — M6 artifact), key paths resolve **outside** the repo, `keys/` gitignored.

## Phase 1 — Build & identity capture (must precede `initialize_config`)

- [x] **[code] Strict (non-localnet) build — done (#23).** `make build-devnet` compiles meridian with `cargo build-sbf --manifest-path programs/meridian/Cargo.toml` (no `--features localnet`), so the real schedule/settlement floors and the `not(localnet)` settlement path are active. It does **not** build the m0-harness / `publish_mock_feed` (localnet-only, never deployed to devnet). The strict path compiles clean (no errors). NOTE: `finalize_settlement` now reads the Official Close from the owner-pinned delivery feed in **both** builds (#16, audit A1) — never from the caller's args. The **writer** is the Pyth adapter (`programs/pyth-adapter`, `Egc4yk…`; Hermes pull → `PriceUpdateV2` → `crank` writes the per-ticker delivery PDA) — proven through finalize+settle by `make pyth-settle-e2e` (ADR-0034). What still gates G11 is `oracle-e2e-devnet` calibrated against the Nasdaq Official Close (#9).
- [x] **Reproducible manifest — done (#23).** `make build-devnet` emits `target/deploy/meridian-devnet.manifest` with the commit hash, executable SHA-256, and program id.
- [ ] **[ops] Capture OpenBook identity (G1 / ADR-0030):** `OPENBOOK_PROGRAMDATA_ADDRESS`, `OPENBOOK_DEPLOYMENT_SLOT`, `OPENBOOK_EXECUTABLE_SHA256`, `OPENBOOK_UPGRADE_AUTHORITY`. These feed `initialize_config`. A mismatch later fails closed.
- [ ] **[ops] Deploy the Pyth adapter to devnet and capture its identity:** `ORACLE_PROGRAM_ID` (= adapter `Egc4yk…`), `ORACLE_PROGRAMDATA_ADDRESS`, `ORACLE_DEPLOYMENT_SLOT`, `ORACLE_EXECUTABLE_SHA256`, `ORACLE_UPGRADE_AUTHORITY` (per-transport, ID-014). These feed `register_transport` / `scripts/register-pyth-transports.ts`.
- [ ] **[gate] G11:** freeze and sign the settlement-quality bounds (`min_samples`, `max_stale_slots`, `max_sample_spread_bps`, `max_price_band_bps`) before M1.

## Phase 2 — Deploy the program [ops]

- [ ] `solana program deploy target/deploy/meridian.so --program-id wallets/meridian-program.json --upgrade-authority <deployer> -u devnet`.
- [ ] Publish the ProgramData address, deployment slot, and executable hash (ADR-0024 — upgrade key stays dedicated/cold until M6).
- [ ] **[code] ADR-0025:** create and **freeze** the deployment Address Lookup Table (the frozen set of program/account addresses the runbook references).

## Phase 3 — Initialize config [ops]

- [ ] Call `initialize_config` with the **real** values: `quote_mint` = Circle USDC above, `openbook_program_data` + slot + sha + upgrade-authority from Phase 1, roles (governance/operator/pause/override), and the G11 quality bounds. (Localnet used a self-made mint and `0xaa…` placeholders — do **not** reuse those.)
- [ ] Verify the stored OpenBook identity snapshot matches Phase 1 exactly.

## Phase 4 — The oracle path (the real gap) [code]

Localnet reads a harness **mock feed** the operator writes (`publish_mock_feed`); `finalize_settlement_normal` reads it under `#[cfg(feature="localnet")]`. Devnet needs the real thing:

- [x] **[code] Pyth adapter — done (#16, ADR-0034).** `programs/pyth-adapter` reads a Pyth `PriceUpdateV2` and writes the same delivery layout the localnet mock uses (`official_close@8, slot@16, halt@32, samples@33`) into a per-ticker PDA it owns. The **owner pin is enforced** (`WrongDeliveryOwner`): the delivery account's owner must equal `record.oracle_program_id`, so `register_transport` sets that to the adapter id. Keeper path `KEEPER_ORACLE=pyth` proven by `make pyth-settle-e2e`. Capture **at the close** (Pyth equity feeds are RTH-only).
- [ ] **[ops]** Register each MAG7 ticker's transport on devnet via `scripts/register-pyth-transports.ts` (`oracleProgram = <adapter>`, feed = `deliveryPda(ticker)`; governance-signed). Note: a Pyth last trade is not the Nasdaq Official Close (ADR-0021) — G11 calibration remains (#9).
- [ ] **[gate] `make oracle-e2e-devnet`** (to author) — proves the real Nasdaq Official Close/provider path end-to-end. Non-waiverable M0 pass path; synthetic evidence cannot satisfy it (ADR-0028).

## Phase 5 — Metadata [done→ops]

- [ ] Metaplex `publish_metadata` is built and localnet-verified; on devnet Metaplex is already deployed. Point the metadata `uri` at real off-chain JSON (icon/description) instead of the `https://meridian.markets` placeholder (ADR-0016: publish + verify permanent metadata **before** minting).

## Phase 6 — Automation on devnet [done→ops]

- [ ] Keeper (`services/keeper`) and market-maker (`services/marketmaker`) run against devnet RPC with the operator key. **Run the keeper with `KEEPER_ORACLE=pyth`** on devnet (Hermes pull → post → adapter crank → finalize → settle); the default harness mode publishes to the mock feed which does not exist on devnet.
- [ ] `make demo-devnet` (to author) — deterministic, **explicitly-synthetic** plumbing demo with a clearly labeled synthetic Settlement Record (ADR-0028). Distinct from the oracle proof above.

## Phase 7 — Identity monitoring [code]

- [ ] **[code]** Tooling that independently re-checks the OpenBook (and Pyth adapter) executable owner / ProgramData / slot / hash / upgrade-authority and **alerts** on any drift; a changed slot or hash fails closed and reopens the architecture (ADR-0030, ARCH §G1).

## Phase 8 — M6: upgrade authority → Squads 2-of-3 [gate][ops]

Non-waiverable final-demo gate (PRD §"authority gate", ARCH §M6). Manifest inputs (public, no private keys):

```
SQUADS_V4_PROGRAM_ID=SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
SQUADS_V4_AUDITED_COMMIT=64af7330413d5c85cbbccfd8c27a05d45b6e666f
SQUADS_V4_SDK_VERSION=2.1.4            # pin exactly, committed lockfile
UPGRADE_MULTISIG_MEMBER_1 / _2 / _3   # three published member pubkeys
UPGRADE_MULTISIG_THRESHOLD=2
UPGRADE_MULTISIG_VAULT_INDEX=0
UPGRADE_MULTISIG_TIMELOCK_SECS=0      # devnet final-demo policy ONLY
UPGRADE_MULTISIG_CONFIG_AUTHORITY=null
```

- [ ] Independently re-derive the **vault PDA** (authority is the vault PDA, never the multisig account or a member key).
- [ ] Verify the Squads V4 executable against the audited commit (G12 proved this on localnet).
- [ ] Transfer Meridian ProgramData upgrade authority to the vault PDA; stage a **version-identical** reproducible upgrade buffer to the same vault.
- [ ] Prove one approval **cannot** execute; two distinct approvals **do**.
- [ ] After the approved upgrade, verify finalized ProgramData owner/authority, **changed** deployment slot, **unchanged** executable hash — and that the **former deployer can no longer upgrade**.
- [ ] Repeat the same Squads pattern for the **Manual Settlement Override** authority (non-demo policy).

## Phase 9 — Clean-clone acceptance [gate]

- [ ] Root `README.md` (M6 artifact) documents prerequisites, `.env.example`, `make dev`, `make demo-devnet`, `make oracle-e2e-devnet`, the synthetic-vs-real evidence labels, devnet-only scope, and risk limits.
- [ ] From a fresh clone a reviewer follows only the README; all three `make` targets pass and exit nonzero on any unmet criterion.

---

## Wallets that need seeding on devnet

| Role | Localnet (ephemeral) | Devnet need |
|---|---|---|
| Deployer / cold upgrade | `4XT7HdQg…` | SOL for deploy + upgrade buffer rent |
| Operator (keeper/MM) | generated per run in `seed-demo.ts` | **a persistent, funded hot key** — SOL for market creation, venue rent, `consume_events`, settlement |
| Governance / pause / override | = gov in demo | cold keys; multisig for non-demo (ADR-0024) |
| Market-maker inventory | generated per run | USDC + SOL working capital if you want live books |

## What's already proven on localnet (no devnet code needed)

Full lifecycle (create→mint→trade→settle→redeem); admin ops (pause / settle / override / settle-all);
keeper auto-settlement + EventHeap crank; market-maker live books; **settlement reads an owner-pinned
feed account** (address + `WrongDeliveryOwner` owner pin, positive+negative tested); Metaplex metadata.
Test status at last run: meridian foundation 6/6, trading 5/5, settlement 4/4, harness G2 7/7.

## The three real code gaps before a devnet demo

1. ~~**`make build-devnet`** — strict build without the `localnet` feature (Phase 1).~~ **Done (#23).**
2. **Pyth adapter on devnet** — deploy `programs/pyth-adapter`, capture its identity, register transports, run the keeper in `KEEPER_ORACLE=pyth` (code is done and proven locally — Phase 4; ops remaining). G11 calibration vs the Nasdaq Official Close stays blocked on #9.
3. **Identity-drift monitor** — the ADR-0030 fail-closed alerting tool (Phase 7). (#25.)

Everything else is ops (keys, funding, feed creation) or the M6 Squads acceptance choreography.
