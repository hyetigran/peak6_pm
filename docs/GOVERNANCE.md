# Meridian — Governance and key management

Who can change protocol state, which keys exist, where they live, and how they
rotate. This is the counterpart to [`ARCHITECTURE.md`](./ARCHITECTURE.md)
(account/CPI design), [`PRODUCTION_INFRA.md`](./PRODUCTION_INFRA.md) (how
services run), [`DEPLOYMENT.md`](./DEPLOYMENT.md) (how to deploy), and
[`DEVNET_DEPLOY.md`](./DEVNET_DEPLOY.md) (M6 acceptance checklist).

Accepted policy is [ADR-0024](./adr/0024-use-two-step-role-rotation-and-an-upgrade-trusted-devnet.md)
plus Architecture §3.3 / §16.9 and PRD §“authority gate”. This file records
the **live program**, the **labeled-demo collapse**, and the **custody rules**
the other runbooks assume.

**Scope:** Solana **devnet / localnet**. No mainnet, no real funds. No
off-chain service can move user collateral or rewrite a Settlement Record
except by submitting an instruction the program re-validates.

Status legend: **[live]** in `programs/meridian` today · **[specified]** in
the freeze but not yet an instruction · **[ops]** a human/custody action ·
**[gate]** non-waiverable M6 acceptance.

---

## 1. Two authority planes

Meridian has two independent trust roots. Confusing them is the usual
misconfiguration.

| Plane | Stored where | Rotates how | What it controls |
| --- | --- | --- | --- |
| **Config roles** | Config PDA `["config"]` | `propose_role` then `accept_role` (ADR-0024) | operator, Pause Authority, Override Authority, governance itself, transport registration |
| **Program upgrade** | Upgradeable Loader ProgramData | `solana program set-upgrade-authority` (later: Squads vault tx) | which executable is `HiREMEBW…` |

Config governance **cannot** upgrade the program. The upgrade authority
**cannot** pause, override, or create Outcome Markets unless that same pubkey
is also a Config role (forbidden outside a labeled demo).

A third class of keys is **not protocol authority**: the market-maker
inventory wallet, the localnet faucet mint authority, user wallets, and
provider API secrets. They never appear in Config.

---

## 2. Config roles

Initialized once by `initialize_config`. The instruction’s payer/signer
**becomes** `config.governance`. Operator, Pause Authority, and Override
Authority are arguments. After that, only two-step rotation changes them.

| Role | Hot / cold | **[live]** instructions | Explicitly cannot |
| --- | --- | --- | --- |
| **governance** | cold | `propose_role`, `register_transport`; pays Config rent at init | rewrite an Outcome Market or Settlement Record snapshot; pause; create markets; settle; upgrade the program |
| **operator** | hot automation | `create_outcome_market`, `create_venue_market`, `publish_metadata`, `abandon_market` (empty, `activity_started == false` only) | hold venue authority (that is the Outcome Market PDA); pause an issued market; settle by privilege; Manual Settlement Override; withdraw collateral |
| **Pause Authority** | separate, not in services | `set_global_pause` | settle, mutate terms, create, trade, override |
| **Override Authority** | isolated cold on demo; **mandatory Squads vault for non-demo** | `finalize_settlement_manual` after the snapshotted delay | bypass delay / equality / digest; choose the Yes/No outcome bit; create; trade |

**[specified], not live:** `set_params`, `activate_settlement_transport_version`
(today `register_transport` writes `activated_trading_day` at creation),
per-market pause / `permanently_pause_market`, and Emergency Expiry
(`emergency_expire` — issue #15). Architecture still assigns those to
governance or Pause Authority; do not invent a different signer when they
land.

Anyone may `finalize_settlement_normal` and `settle_market` once the
Settlement Quality Predicate and delay gates pass. Settlement is not an
operator privilege.

### 2.1 Venue and mint authority (not a human key)

The Outcome Market PDA is mint authority, collateral-vault owner, OpenBook
`open_orders_admin`, and `close_market_admin`. Humans never hold those. Order
creation is only through Meridian. `create_venue_market` is the only
attachable venue path. OpenBook `collect_fee_admin` is the unsignable G9
sentinel `EhAss6gb…` — no key exists for it.

### 2.2 What no role can do (V1)

- Withdraw Collateral Surplus or any vault USDC except via the Redemption
  family (ADR-0013). There is no treasury, fee_admin, or surplus-withdrawal
  instruction. Do not scaffold one.
- Charge protocol fees (ADR-0001 / 0007).
- Recreate a ticker / Strike / Trading Day identity after issuance (ADR-0011).
- Substitute last trade, midpoint, previous close, or a vendor bar for
  Official Close. Missing Official Close is Settlement Disputed (ADR-0026).
- Authenticate HTTPS Manual Settlement Override evidence on-chain. The
  Override Authority (or its Squads members) remains the delayed price
  trust root for that path (ADR-0005).

---

## 3. Two-step role rotation  [live][decided: ADR-0024]

```text
governance  --propose_role(role, pending)-->  Config.pending_*
incoming    --accept_role(role)-->            Config.<role> = incoming
                                              pending_* = default
```

- Only **governance** may propose. The `Role` enum is `Governance | Operator |
  PauseAuthority | OverrideAuthority`.
- Only the **pending pubkey** may accept. A default/`Pubkey::default()`
  pending slot rejects (`NoPendingRotation`).
- Operational roles cannot rotate themselves. Compromised operator / pause /
  override keys are recovered by governance proposing a replacement; the
  incoming key accepts.
- Compromised governance: the current governance key must still propose its
  successor. If that key is gone and no pending accept is outstanding,
  Config governance is stuck until a **program upgrade** (separate plane)
  ships a migration. That is why non-demo governance should be a cold
  multisig vault, not a laptop key.
- Both steps emit `RoleRotationProposed` / `RoleRotationAccepted`.

Program upgrade authority is **not** a Config `Role`. It does not go through
`propose_role`.

---

## 4. Instruction × signer (as implemented)

| Instruction | Required signer | Notes |
| --- | --- | --- |
| `initialize_config` | future governance (payer) | one-shot; pins quote mint + OpenBook identity |
| `propose_role` | governance | sets `pending_*` |
| `accept_role` | incoming key | must equal `pending_*` |
| `register_transport` | governance | immutable FeedVersion PDA; payer = governance |
| `set_global_pause` | Pause Authority | boolean; resting orders are not cancelled |
| `create_outcome_market` | operator | first-of-day also inits the Settlement Record header |
| `create_venue_market` | operator | operator pays OpenBook rent only |
| `publish_metadata` | operator | Metaplex CPI; user does not sign |
| `abandon_market` | operator | empty + `activity_started == false` only |
| `finalize_settlement_manual` | Override Authority | delay, two equal values, manifest digest |
| `finalize_settlement_normal` | anyone | feed owner-pin; not a role |
| `settle_market` | anyone | after `close_ts +` snapshotted delay |
| mint / redeem / place / take | user | Directional Intents; no protocol key |

---

## 5. Program upgrade authority  [gate: M6]

### 5.1 Proof-of-concept (now → until M6)

A dedicated **cold** deployer key may remain Upgradeable Loader authority
through earlier milestones (ADR-0024). It must never be loaded by keeper,
market-maker, indexer, or frontend.

Publish with every deploy (ADR-0024 / DEVNET_DEPLOY Phase 2):

- ProgramData address
- deployment slot
- executable SHA-256 (`target/deploy/meridian-devnet.manifest`)
- current upgrade-authority pubkey

A single-key upgrade authority **cannot** pass the final demo.

The local deployer pubkey currently recorded in DEVNET_DEPLOY is
`4XT7HdQg59fmvvymZzUa9kWTHxyehCrLQEJHxrsjQfCq`. Treat that as the POC
identity, not the M6 end state.

### 5.2 Final demo (M6) — Squads V4 2-of-3

Non-waiverable (PRD authority gate, Architecture §16.9, DEVNET_DEPLOY
Phase 8). Mechanism is frozen:

```text
SQUADS_V4_PROGRAM_ID          = SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
SQUADS_V4_AUDITED_COMMIT      = 64af7330413d5c85cbbccfd8c27a05d45b6e666f
SQUADS_V4_SDK_VERSION         = 2.1.4          # exact, committed lockfile
members                       = 3 distinct published pubkeys
threshold                     = 2
configAuthority               = null           # autonomous; no admin override
vault_index                   = 0
timelock_secs                 = 0              # devnet final-demo policy ONLY
```

The Upgradeable Loader authority is the independently re-derived **vault
PDA**, never the Squads multisig account and never a member key. G12 proved
the 2-of-3 loader drill on localnet against the immutable Squads fixture.
M6 must transfer **this** program’s ProgramData, stage a version-identical
upgrade buffer to the same vault, prove one approval cannot execute, prove
two distinct approvals do, then show the former deployer can no longer
upgrade.

Member pubkeys / custody owners are a human input (GitLab **#11**). Do not
invent them.

Non-demo Manual Settlement Override uses a **separate** approved Squads
vault as `config.override_authority`. A direct member signature must fail
Meridian’s address constraint; an approved vault transaction supplies the
PDA signer. That proves authorization, not Official Close authenticity.

Primary-source notes: [`docs/agents/squads-v4-multisig-research.md`](./agents/squads-v4-multisig-research.md).

---

## 6. External identities we do not control

| Identity | Why it matters | Our posture |
| --- | --- | --- |
| Canonical OpenBook V2 `opnb2LAf…` | Venue executable; retained external upgrade authority `Cax5s8Cj…` (ADR-0030) | Snapshot at `initialize_config`; every CPI re-checks ProgramData + slot; drift **fails closed** and alerts (#25) |
| Pyth adapter (`programs/pyth-adapter`, reads Pyth `PriceUpdateV2`) | Settlement delivery, not source of truth | Identity lives on each FeedVersion; wrong owner → `WrongDeliveryOwner`; a later executable upgrade fails closed for already-Pending records |
| Circle Devnet USDC `4zMMC9srt5…` | Quote mint pin | Config rejects a different mint; localnet uses unlabeled **test USD**, never called USDC |
| Metaplex Token Metadata | `publish_metadata` CPI | Already on the cluster; not a Meridian role |

Do not use the inert OpenBook copy `923gY…` (ADR-0029). An OpenBook upgrade
by that external authority is an **incident that reopens the architecture**,
not something governance silently adopts.

---

## 7. Key inventory and custody

### 7.1 Protocol keys

| Key | Env (path only) | Lives | Loaded by |
| --- | --- | --- | --- |
| Operator | `OPERATOR_KEYPAIR_PATH` | secret store / `keys/` **outside git** | keeper (intended); seed scripts |
| Governance | `GOVERNANCE_KEYPAIR_PATH` (runbooks); seed currently reads `GOVERNANCE_KEYPAIR` | offline | `initialize_config`, `propose_role`, `register_transport` shells only |
| Pause Authority | `PAUSE_AUTHORITY_KEYPAIR_PATH` | offline | pause runbook only |
| Override Authority | `OVERRIDE_AUTHORITY_KEYPAIR_PATH` | offline / Squads members | override runbook only |
| Upgrade / deployer | `UPGRADE_AUTHORITY_KEYPAIR_PATH` | offline; then **none** after M6 (vault PDA) | `solana program deploy` / `set-upgrade-authority` only |
| Program identity | `wallets/meridian-program.json` (gitignored) | deploy host | `make build-devnet` copies to `target/deploy/meridian-keypair.json`. This is `declare_id!`, not Config governance |

Never put private keys in env **values**. Paths only. `.env` is gitignored;
commit `.env.example`.

### 7.2 Non-authority secrets

| Secret | Used for | Must not |
| --- | --- | --- |
| Market-maker key (today inside `.demo-config.json`) | Demo Yes/USDC inventory | Be a Config role; be funded as if it were operator |
| `.demo-faucet.json` | Localnet test-USD faucet | Exist on a public indexer |
| Official-Close provider keys (`MASSIVE_SIP_API_KEY`, Alpaca, …) | G11 / Live Underlying Price | Be treated as Settlement authority |
| Arweave uploader | Permanent metadata (ADR-0016) | Sign protocol instructions |
| `ALERT_WEBHOOK_HMAC_SECRET_PATH` | Unattended alerting (#10) | Live in the frontend |

### 7.3 Where files must not go

| Location | Allowed | Forbidden |
| --- | --- | --- |
| Git | pubkeys, Squads member addresses, manifests | any JSON secret key, `.env`, `.demo-config.json`, `wallets/`, `keys/` |
| Vercel / frontend | `NEXT_PUBLIC_RPC`, `NEXT_PUBLIC_INDEXER`, `NEXT_PUBLIC_MERIDIAN` | every row in §7.1–7.2 |
| Public indexer host | read-only RPC | `.demo-config.json`, `.demo-faucet.json`, `/admin/*` signing, `/faucet/*` |
| Keeper / market-maker host | operator (keeper); MM inventory | governance, pause, override, upgrade |
| Laptop runbook (air-gapped preferred) | governance, pause, override, upgrade | — |

`keys/` and `wallets/` are gitignored. Generate keypairs **outside** the
working tree when possible (`/run/secrets/meridian/…` or an equivalent
secret store). If a path under the repo is used for local rehearsal, it
must still match a gitignore rule.

### 7.4 Labeled demo collapse (localnet only)

`scripts/seed-demo.ts` on localnet:

- generates throwaway governance + operator (or loads env paths);
- sets **Pause Authority = Override Authority = governance**;
- writes **secret keys** to `.demo-config.json` (gitignored);
- indexer `/admin/pause|settle|override` and the frontend Admin page sign
  with those keys.

That is a **localnet affordance**. It is not the production authority
model (Architecture §3.3, DEPLOYMENT §2). On any public host:

- distinct keys (or Squads vaults) for governance, operator, pause, override;
- no `.demo-config.json` mounted;
- `/admin/*` and `/faucet/*` denied at the proxy;
- frontend `/admin` not advertised.

`make demo-devnet` still collapses pause/override onto governance unless
you pass distinct keypairs and stop using the Admin routes. Do not treat
that seed as non-demo policy.

---

## 8. Service loading rules

| Process | May load | Must not load |
| --- | --- | --- |
| `services/indexer` | nothing (read-only) | any protocol key. Localnet admin routes are the documented exception and must not ship publicly |
| `services/keeper` | **only** `OPERATOR_KEYPAIR_PATH` | pause, override, governance, upgrade. Today the loop still reads `.demo-config.json` — reconcile before unattended operation (PRODUCTION_INFRA §4) |
| `services/marketmaker` | a dedicated inventory key | any Config role |
| `frontend/` | none (users sign in-wallet) | any key file, including via Vercel env |
| Offline deploy shell | upgrade + governance as needed | keep sessions short; do not leave the upgrade key unlocked |

Automation may submit `create_*`, `consume_events`, and permissionless
`finalize_settlement_normal` / `settle_market`. For an issued-market halt
or late corporate action it emits an alert plus an **unsigned** payload;
the Pause Authority runbook signs. Operator may `abandon_market` only
while the Outcome Market is on-chain-empty.

---

## 9. Environment policy

| Environment | Config roles | Upgrade authority | Override |
| --- | --- | --- | --- |
| **localnet** (`make demo`) | collapse allowed; ephemeral | local validator / deployer | collapsed to governance |
| **devnet labeled synthetic demo** | operator distinct and funded; pause/override may still be governance **only** while labeled demo | POC cold key until M6 transfer | isolated key or same as governance **only** while labeled demo |
| **devnet non-demo / M6 acceptance** | four distinct pubkeys (governance preferably a vault) | Squads vault-index-0 PDA, 2-of-3 | **separate** Squads vault PDA |
| **mainnet** | out of scope | out of scope | out of scope |

Zero Squads timelock is **devnet final-demo policy only**. A non-demo
deployment must approve its own timelock and custody.

---

## 10. Compromise and rotation (operational)

| If this is lost / leaked | Blast radius | Recovery |
| --- | --- | --- |
| Operator | can create/abandon empty markets, pay rent, crank; **cannot** take vault USDC or pause issued markets | governance `propose_role(Operator)` → incoming `accept_role`; drain leftover SOL from the old key |
| Pause Authority | can halt new Directional Intents globally; cannot settle or steal | two-step rotate; recovery exits (cancel, settle funds, Redemption) stay available |
| Override Authority | delayed price trust root — can attest two equal manual values after the delay | two-step rotate **before** a disputed window if possible; non-demo this is a Squads membership incident |
| Governance | can propose any role, register transports | propose+accept a successor while the key still signs; otherwise upgrade-plane migration |
| Upgrade key (pre-M6) | can replace the executable | halt services; rotate under the published policy; **M6 cannot pass** until authority is the Squads vault |
| Market-maker | inventory only | replace the wallet; it is not Config |
| `.demo-config.json` | localnet god-mode (gov+operator secrets) | treat as full role compromise for that validator; never reuse those bytes on devnet |

User funds in wallets and the collateral vault are not spendable by any
of the above except through Redemption. That is the product invariant the
role split exists to protect.

---

## 11. Human-owned inputs (do not invent)

| Issue | Input |
| --- | --- |
| **#11** | Three M6 Squads member pubkeys, custody owners, create-key, independently derived multisig + vault-index-0 PDAs |
| **#10** | Alert webhook receiver before unattended keeper |
| **#9** | Official-Close provider (G11); not a key-management choice but it bounds whether override remains a rare path |
| **#15** | Adopt or omit Emergency Expiry (Pause Authority instruction) |

Until #11 is filled, DEVNET_DEPLOY Phase 8 is blocked. Until pause /
override are distinct from governance, do not call a public cluster
deployment “non-demo.”

---

## Related docs

| Doc | Owns |
| --- | --- |
| [ADR-0024](./adr/0024-use-two-step-role-rotation-and-an-upgrade-trusted-devnet.md) | Two-step rotation + M6 Squads contract |
| [ADR-0005](./adr/0005-require-two-source-manual-settlement.md) | Manual Settlement Override evidence |
| [ADR-0013](./adr/0013-lock-collateral-surplus-in-v1.md) | No surplus withdrawal |
| [ADR-0030](./adr/0030-bind-to-the-canonical-openbook-deployment-with-monitored-identity.md) | External OpenBook upgrade authority |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3.3, §16.9 | Role table and upgrade isolation |
| [`PRODUCTION_INFRA.md`](./PRODUCTION_INFRA.md) | Which *services* hold the operator key |
| [`DEPLOYMENT.md`](./DEPLOYMENT.md) | Deploy how-to; Vercel must get no secrets |
| [`DEVNET_DEPLOY.md`](./DEVNET_DEPLOY.md) | Phase 0 wallets + Phase 8 Squads choreography |
| [`agents/squads-v4-multisig-research.md`](./agents/squads-v4-multisig-research.md) | Squads V4 gates and derivation |
| [`.env.example`](../.env.example) | Env names; copy to `.env`, never commit |
