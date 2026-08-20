# OpenBook V2 pin evidence (G1)

**Status: G1 disposition RESOLVED by ADR-0030 — V1 binds to the canonical deployment `opnb2LAf…` with monitored fail-closed identity checks; the §0 ADR-0029 deployment is inert and must never be referenced.** Remaining G1 golden-test items (§5 closing note) stay open M0 work. The canonical devnet deployment failed G1 on a retained upgrade authority (§6). ADR-0029's byte-identical copy was deployed and verified (§0) but cannot execute (§7). G1's remaining golden-test items (§5 closing note) are still open M0 work.

## 0. Meridian deployment (the V1 binding identity)

Deployed and verified 2026-08-20T02:39:34Z (slot block time):

| Field | Value |
| --- | --- |
| Program ID | `923gYkFCtTtrL9pX7vQNKR7QJchb2jpY3s26xiWuDxz4` |
| Owner | `BPFLoaderUpgradeab1e11111111111111111111111` |
| ProgramData address | `87S9cJyGfg5o95Fh8DGGoKmiERm88kDQQ2rqBXfpbJRg` |
| **Upgrade authority** | **`None` — finalized, immutable** |
| Last deployed in slot | `485624272` (2026-08-20T02:39:34Z) |
| Data length | 1,035,960 bytes — exactly the artifact size, no padding |
| ProgramData balance (rent) | 7.21148568 SOL |
| Deploy signature | `4cxiTTWyoANfxsu4WccmcvURT4WY8QEn2DhzCkdajZUvnuAcmQKRceCSn7B8eGrUbHmaPtWFmRSb8ZNU1ccfwWRR` |

Post-deploy verification: `solana program dump` of this program returns bytes whose raw SHA-256 is `a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8` — **the pinned official-artifact hash directly**, with `cmp` confirming byte-identity. Because ProgramData was allocated at exact artifact size, no truncation rule is needed for this deployment; preflight may compare the raw dump hash. `initialize_config` stores this table's program ID, ProgramData address, slot, and hash; every OpenBook CPI re-verifies them. All G2–G10 measurements run against this deployment. If devnet is ever reset, redeploy from the release artifact and re-run this verification before any other work.

Sections 1–6 below record the canonical deployment's verification and the finding that reopened the architecture.

Canonical deployment verified 2026-08-19 against `https://api.devnet.solana.com` and `https://api.mainnet-beta.solana.com` (solana-cli 3.1.13), the official GitHub release, and source files fetched at the pinned commit. Every fact below cites where it was read.

## 1. Deployed identity

| Field | Devnet | Mainnet (contrast) |
| --- | --- | --- |
| Program ID | `opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb` | same |
| Owner | `BPFLoaderUpgradeab1e11111111111111111111111` | same |
| ProgramData address | `DktN5HJ9uHKVRZ7FXGap4PEGVnEdc2VNBCXTt1AqJQYB` | same |
| Last deployed in slot | `282042596` | `250859864` (block time 2024-02-27T22:02:06Z) |
| **Upgrade authority** | **`Cax5s8Cjrvt23myfuaGWMLpoxhn75S9DLEAYZTVhJrqD` — RETAINED** | **`CZoAmQErbMwhSNA5WtbWLcwGE1mhXEv4hTvyvvHXGkrr` — RETAINED** |
| Account data length | 2,059,776 bytes | same |

Devnet block time for slot 282042596 is pruned from long-term RPC storage ("slot was skipped, or missing in long-term storage"); the slot number itself is the pinned value `initialize_config` must store and every CPI must re-check.

## 2. Executable verification — PASS

- Official release asset `openbook_v2-v1.7.so` (1,035,960 bytes) SHA-256:
  `a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8` — **exactly matches the pinned build hash.**
- Dumped devnet executable (`solana program dump`, 2,059,776 bytes) is the official artifact **byte-for-byte**, zero-padded to the account's data length: the artifact is a strict prefix and every byte past 1,035,960 is `0x00`.
- Zero-truncated forms of the artifact and the dump are identical (1,035,945 bytes, SHA-256 `44a1bb9b185c77288955fbe1193a38eaaa7624564deec9459f828064704e44fa`). The 15-byte gap between artifact size and truncated size is trailing zeros inside the artifact itself.
- **Hash-comparison rule for tooling:** compare the raw release artifact (`a3eb0fad…`) against the dumped account data truncated to the artifact length, or compare zero-truncated forms (`44a1bb9b…`). Hashing the raw padded dump yields `9f724b3d9c207307c3bcb4ed308900af33a325f081126ea1b740fbb74a9f3642` and matches nothing published — record all three so preflight tooling cannot false-alarm.
- Devnet and mainnet executables are byte-identical.

## 3. Release / commit pin — PASS

- GitHub tag `v1.7` resolves to commit `796a470033bc556c1d1a1f76709394fc50c63bf7` (matches the pinned short SHA `796a470`).
- Release published 2024-02-26T23:39:34Z; mainnet deployment followed 2024-02-27. Note: tags `v0.2.8`–`v0.2.10` (June 2024) are *later* releases with a different, smaller artifact (~815 KB) under a non-monotonic version scheme — pin tooling must match on the exact tag `v1.7`, never "latest".

## 4. License boundary — PASS

At the pinned commit:

- `README.md` L9–10: "The majority of this repo is MIT-licensed, but some parts needed for compiling the Solana program are under GPL."
- GPL code is gated behind the `enable-gpl` cargo feature (`programs/openbook-v2/Cargo.toml` declares `enable-gpl = []`).
- `programs/openbook-v2/src/lib.rs` L33–34 proves the boundary in code: `compile_error!("compiling the program entrypoint without 'enable-gpl' makes no sense, enable it or use the 'cpi' or 'client' features")` — instruction bodies are `#[cfg(feature = "enable-gpl")]`; the `cpi`/`client` paths compile without any GPL code.
- Meridian builds `packages/openbook-adapter` from the `cpi`/`client` features and the MIT IDL only; `enable-gpl` must never appear in Meridian's dependency features.

## 5. Load-bearing source facts at `796a470` (file:line citations)

| Fact | Evidence |
| --- | --- |
| Market admin fields | `state/market.rs:39–45` — `collect_fee_admin: Pubkey` (required, plain pubkey), `open_orders_admin`, `consume_events_admin`, `close_market_admin` all `NonZeroPubkeyOption` |
| Expiry predicate is strict | `state/market.rs:165–167` — `is_expired = time_expiry != 0 && time_expiry < timestamp`. Meridian's `time_expiry = close_ts - 1` therefore rejects orders at exactly `close_ts` |
| Maker orders require admin signer | `accounts_ix/place_order.rs:17,32` — `open_orders_admin: Option<Signer>` with constraint `market.open_orders_admin == open_orders_admin.non_zero_key()` |
| `place_take_order` requires the same admin signer | `accounts_ix/place_take_order.rs:24,58` — identical constraint; no referrer account in this instruction |
| `settle_funds` optional referrer | `accounts_ix/settle_funds.rs:48` — `referrer_account: Option<…>`; Meridian wrapper forces none |
| `consume_events` permissionless when admin is None | `accounts_ix/consume_events.rs` — `consume_events_admin: Option<Signer>` matched against the market field; `None` ⇒ anyone may crank |
| `set_market_expired` gated on close-market admin | `accounts_ix/set_market_expired.rs` — requires `close_market_admin` signer and `is_some()` |
| `close_market` refund destination | `accounts_ix/close_market.rs:8–40` — `close_market_admin` signer required; market, bids, asks, EventHeap rent all `close = sol_destination`, an unchecked caller-supplied account — Meridian must pin it to the snapshotted Rent Refund Address (ADR-0027) |
| **EventHeap penalty is ZERO at this pin** | `state/market.rs:16` — `pub const PENALTY_EVENT_HEAP: u64 = 0`; `instructions/place_order.rs:103–105` only increments `penalty_heap_count` when the heap grows. **The previously recorded "500 lamports per heap entry" figure comes from a later revision and is wrong for the deployed v1.7.** G8 rent math must not budget heap penalties; the `penalty_payer` plumbing still exists and golden tests should assert the constant stays 0 in the pinned build |

Items from PRD Appendix D not yet evidenced here — zero-fee encoding and rejection of alternatives, SelfTradeBehavior enum semantics, PostOnly semantics, the 15-account inline-fill limit, lot/tick math, market/book/EventHeap sizes and rent, `create_venue_market` discriminator/account-order golden tests, and the full enumeration of Market-header mutation instructions with signer requirements — require the M0 CPI harness and golden tests against the deployed build. They remain open G1/G2/G10 work and must be appended to this file with the same citation discipline.

## 6. The blocking finding

G1 requires "Upgradeable Loader ownership and `upgrade_authority == None`; any retained authority … is a non-waiverable failure that reopens the architecture." The devnet deployment's authority is `Cax5s8Cjrvt23myfuaGWMLpoxhn75S9DLEAYZTVhJrqD` — live, external, and able to replace the verified bytes at any time. Mainnet is likewise upgradeable under a different key, so this is not a devnet quirk that mainnet would cure.

This cannot be waived and cannot be fixed by Meridian-side checks alone: the per-CPI ProgramData/slot/hash re-verification in the architecture detects an upgrade *after* it happens and fails closed, but G1's premise was that the executable cannot change at all. The decision reopens to humans. The known options, none decided here:

1. **Deploy Meridian's own immutable copy** of the verified v1.7 bytes to devnet (same artifact, same hash, authority set to `None`, new program ID). Not a fork — byte-identical binary — but it abandons the canonical program ID, changes every derived address, and means Meridian's devnet venue is not the ecosystem's OpenBook instance. Requires a new ADR amending the "deployed v1.7" pin and G1 wording.
2. **Accept the retained authority as a monitored risk**: keep the canonical deployment, rely on the existing fail-closed ProgramData/slot/hash checks, add an alert on any authority/slot change. Requires stakeholders to explicitly revise G1's non-waiverable clause in a new PRD revision — the PRD currently forbids exactly this.
3. **Stop** until the OpenBook deployer burns the authority (outside Meridian's control; no basis to expect it).

**Resolution:** option 1 was adopted as ADR-0029 on 2026-08-19 and executed on 2026-08-20; the Meridian deployment in §0 is the V1 binding identity. The canonical deployment is no longer load-bearing for Meridian.

## 7. ADR-0029 execution evidence: a re-ID'd copy cannot run

The M0 harness's first G2 run against the §0 deployment failed on **every**
instruction with anchor error 4100 `DeclaredProgramIdMismatch`: v1.7 is
compiled with `declare_id!("opnb2LAf…")` and anchor's entrypoint compares it
to the executing program ID. The §0 deployment is therefore permanently inert
(finalized programs cannot be closed; its 7.21148568 SOL rent is sunk).

A surgical binary patch was then tested: the canonical ID occurs exactly once
as a contiguous 32-byte constant (offset `0xe259b`); patching it and loading
the artifact at a fresh ID got create_market past the entry check but failed
at the anchor `#[event_cpi]` self-invoke with `Unknown program opnb2LAf…` —
**the binary embeds at least one more copy of the canonical ID, inlined in
code and invisible to byte search**. No byte-patch can be proven complete;
the patch route is rejected fail-closed.

Empirical matrix (G2 suite, localnet, same artifact):

| Configuration | Result |
| --- | --- |
| Unpatched artifact at canonical `opnb2LAf…` | **7/7 pass** |
| Unpatched artifact at new ID (`923gY…`, devnet §0) | 0/7 — error 4100 on every instruction |
| Single-site patched artifact at new ID | 0/7 — second inlined ID copy breaks event CPI |

Conclusion: **this artifact executes only at the canonical program ID.** The
immutability G1 demands and the pinned official bytes are jointly satisfiable
on devnet only by the canonical deployment — which retains an upgrade
authority (§6). Building from patched source would require `enable-gpl` and
abandons the official-artifact property entirely. The remaining real choice
is the §6 option 2 (canonical deployment + monitored fail-closed identity
checks, with a PRD revision of the G1 immutability clause), and that decision
is owned by stakeholders.

## 8. G3 evidence — time/pause gates and expiry semantics at the pin

Harness-provable G3 subset proven on localnet against the pinned bytes at the
canonical ID (`tests/g3.test.ts`, run via `make g3`). Boundary tests are
**program-clock-exact**: the wrapper logs its `Clock` reading before any
check, each attempt is sent with skipPreflight, and assertions judge by that
logged timestamp — the very value the checks (and the OpenBook CPI in the
same bank) observed. RPC blockTime is never used: it is an estimate that can
drift ±1s from the bank clock, which a first run demonstrated. Declared
method deviation: the ticket specified "validator clock warp", which
`solana-test-validator` cannot do mid-run; the program-clock method replaces
it and is strictly more precise.

| Fact | Evidence |
| --- | --- |
| Order pre-open rejected | harness `OrderBeforeOpen`, failing attempt's gate clock proven `< trade_open_ts` |
| Order while Paused rejected | harness `VenuePaused` on BOTH wrappers (maker and take paths) |
| Pause preserves resting orders (ADR-0010) | vault balance unchanged across pause; the resting order is cancelable afterward |
| Cancel + consume + settle work WHILE paused | permissionless `consume_events` plus owner-signed `cancel_all_orders` + `settle_funds` succeed under pause; full refund |
| Order at exact close rejected | success ⟺ `clock < close_ts`, `TradingClosed` ⟺ `clock >= close_ts`, both sides observed |
| OpenBook expiry boundary is strict | `state/market.rs:165–167` `time_expiry != 0 && time_expiry < now`; empirically success ⟺ `clock <= time_expiry`, `MarketHasExpired` ⟺ `clock > time_expiry`. Meridian's `time_expiry = close_ts - 1` therefore rejects at exactly `close_ts` |
| Recovery after natural expiry | cancel + settle succeed post-expiry; full refund |
| `set_market_expired` authority | requires `close_market_admin` signer (`accounts_ix/set_market_expired.rs`); wrong signer → `InvalidCloseMarketAdmin`; harness path admin-gated |
| `set_market_expired` effect | `instructions/set_market_expired.rs`: guard `!is_expired` then `time_expiry = -1`. On-chain readback confirms `-1`. Re-expire rejected (`MarketHasExpired`) — a true one-way fuse; orders rejected at venue level afterward |
| Recovery after the fuse | admin `prune_orders` cancels the resting order, owner `settle_funds` refunds in full |
| `prune_orders` preconditions | `close_market_admin` signer (`accounts_ix/prune_orders.rs`) AND market expired: `instructions/prune_orders.rs` requires `is_expired` (`MarketHasNotExpired` otherwise) — proven both ways on-chain (rejected pre-fuse, succeeds post-fuse) |
| `close_market` preconditions | `instructions/close_market.rs`: requires expired AND `market.is_empty()` AND empty book AND empty EventHeap (`NonEmptyMarket` / `BookContainsElements` / `EventHeapContainsElements`); rent to caller-supplied `sol_destination` (§5). Documented from source; on-chain exercise deferred to G8 rent-refund work |
| Meridian rule instantiated | a Venue Market created with `time_expiry = close_ts - 1` and gate close `close_ts` rejects orders at exactly `close_ts` (success ⟺ clock `< close_ts`), with the gate and the venue predicate as independent layers |

One capacity fact surfaced by the boundary loops: an OpenOrders account holds
at most **24 resting orders** (`state/open_orders_account.rs:12`,
`MAX_OPEN_ORDERS = 24`; exceeding it fails with `OpenOrdersFull`). This bounds
per-user resting orders per Venue Market and feeds G7/G8 sizing.

ADR-0018 input: the fuse is one-way at the pin, cannot fire twice, cannot fire
on an already-expired market, and leaves cancellation/settlement intact.
Remaining G3 bullets (mint gates, `add_strike` lead windows, global-pause
scope over Meridian instructions, abandonment/tombstone) require M1 program
state and are tracked by the go/no-go issue.

## 9. G4 evidence — full-fill rollback

Market Actions are full-fill-or-revert, proven on localnet against the pinned
bytes (`tests/g4.test.ts`, `make g4`). The take wrapper enforces an
exact-delta postcondition — the user's base account must change by exactly
`max_base_lots × base_lot_size` (+ for Bid, − for Ask) — read directly from
account bytes before and after the CPI in the same instruction.

| Fact | Evidence |
| --- | --- |
| Exact-liquidity Buy and Sell fill fully | taker base ±1 lot and quote ∓`price` exactly, zero fees, both perspectives |
| Partial fill reverts everything | taker requests 2 lots against 1 resting: OpenBook fills 1 inline, the postcondition fails, and all six token balances (taker, maker, both vaults) are unchanged afterward; the resting maker order's survival is proven functionally — a subsequent 1-lot take fills against the very same order, both perspectives |
| Empty-book take reverts | zero fill ≠ requested ⇒ `PartialFillReverted`, no state change |
| No partial synthetic exposure | the postcondition runs inside the same instruction as the CPI; failure reverts the whole transaction, so no intermediate state is ever visible to a later instruction or block |
| `Market` lot-size offsets | `quote_lot_size` at byte 448, `base_lot_size` at 456 (field order `state/market.rs:20–118`, `OracleConfig` 88 bytes per `state/oracle.rs:39`) — golden-tested against creation values |
| SPL token `amount` offset 64 | used by the postcondition; standard classic-SPL layout |

Note for M1: the production `take_full` should verify the quote-side bound as
well (`Worst Execution Price`); the base-side exactness proven here is the
full-fill invariant.

## 10. G8 evidence — rent and the daily market budget

Measured from real localnet accounts against the pinned bytes
(`tests/g8.test.ts`, `make g8`; full table in
`docs/adr/g8-rent-measurements.json`). Rent parameters are cluster defaults —
re-verify on devnet under issue #8.

| Account class | Bytes | Lamports |
| --- | ---: | ---: |
| OpenBook market | 848 | 6,792,960 |
| bids / asks (each) | 90,952 | 633,916,800 |
| EventHeap | 91,288 | 636,255,360 |
| market vault ATA (each) | 165 | 2,039,280 |
| OpenOrders account | 1,264 | 9,688,320 |
| OO indexer (1 entry) | 49 | 1,231,920 |
| SPL mint | 82 | 1,461,600 |
| venue gate (harness) | 89 | 1,510,320 |
| SettlementRecord (frozen layout, computed) | 524 | 4,537,920 |
| SettlementTransportVersion (frozen layout, computed) | 286 | 2,881,440 |
| Metaplex metadata (standard 679 B, computed; measure in G12) | 679 | 5,616,720 |

Budget (49 Outcome Markets/day + 7 Settlement Records/day, five Trading
Days, +20% reserve): **567.8 SOL**, dominated by
bids/asks/EventHeap (~1.90 SOL per Venue Market). Worst-case locked
(vault ATAs, mints, metadata, Settlement Records — no close path at the pin)
is only **1.00 SOL/day** (incl. the harness venue gate); **93.6 SOL/day** is reclaimable via
`close_market` once the Outcome Markets are Settled and the Venue Markets empty. A same-week recycling
strategy (close yesterday's Venue Markets before funding today's) cuts the float to
roughly one day of venue rent plus accumulated locked rent; the headline
number assumes no recycling. This quantifies the PRD risk-register item
"OpenBook large-account rent".

Refund-path proof (ADR-0027): the harness `close_venue_market` wrapper
refuses any `sol_destination` other than the Rent Refund Address snapshotted
at gate creation (`WrongRefundDestination`), and the successful close paid
exactly market+bids+asks+heap rent to that address. Owner-path
`close_open_orders_account` refunds OO rent **plus the indexer's 32-byte
shrink delta** to the owner's destination — a pin fact discovered by exact
assertion. Pending M1: Meridian Outcome Market and Config allocations and
their 64-byte reserved-padding verification.

## 11. G10 evidence — lot/price/order semantics

Production lot scheme proven with golden vectors (`tests/g10.test.ts`,
`make g10`): `base_lot_size = 1,000,000` (one whole Yes Token == one base
lot), `quote_lot_size = 10,000` (one price lot == one cent), prices 1..99 ==
$0.01..$0.99.

| Fact | Evidence |
| --- | --- |
| Price vectors exact | bids at P ∈ {1, 50, 99} lock exactly P×10,000 quote atoms; fills at P move exactly P cents per whole token, zero fees |
| **PostOnly crossing is a venue silent no-op** | `book.rs:166–170`: the pinned build logs "Order could not be placed due to PostOnly" and returns **success** with no resting order. The wrapper converts this to a fail-closed revert by requiring the venue-returned order id (`OrderNotPosted`) |
| **Past-expiry placement is a venue silent no-op** | `order.rs:52–54` returns `None` TIF ⇒ order silently ignored; same wrapper check reverts it |
| Returned order ID semantics | `place_order` returns `Option<u128>` in CPI return data; the wrapper requires `Some`, logs it, and the logged id cancels via `cancel_order` — proven round-trip |
| Per-order expiry granularity | TIF is **u16 seconds** (`order.rs:47–61`): `expiry − now` clamped to 65,535 s (~18.2 h) — ample for same-day Outcome Markets; expired makers are skipped by takes (proven: take against an expired order reverts full-fill) |
| SelfTradeBehavior pinned | wrapper rejects both non-Abort variants (`SelfTradeMustAbort`); wire golden: `PlaceOrderArgs` is 44 bytes with STB at offset 42 == 2. **Disposition:** on-chain STB *matching* is unreachable through V1 wrappers by construction — PostOnly never crosses and `place_take_order` has no STB field at the pin; take-path self-cross prevention is the G5 work |
| Boundary/overflow vectors | price 0, zero lots, and a 2^62 price all fail closed (venue reject or `OrderNotPosted`), never wrap; price 100 ($1.00) is venue-legal — the 1..99 range is Meridian client policy; expiry beyond the 65,535 s TIF clamp still posts |
| Expiry boundary, program-clock-exact | bundled place(expiry=T)+take probes: posted+filled ⟺ clock `< T`, `OrderNotPosted` ⟺ clock `≥ T` (venue TIF = T − now, zero ⇒ silently ignored) |

The two silent no-op behaviors are the notable pin findings: **the venue
reports success for orders it never posted**. Any Meridian order path that
does not verify the returned order id would silently strand user intent;
the wrapper's `OrderNotPosted` check is therefore load-bearing for M1, and M1
should surface the order id via CPI return data rather than log-scraping.

## 12. G9 evidence — zero-fee enforcement and the create-path goldens

Proven on localnet against the pinned bytes (`tests/g9.test.ts`, `make g9`).

| Fact | Evidence |
| --- | --- |
| **The unsignable sentinel** | `collect_fee_admin` = PDA(`"meridian_fee_admin_sentinel"`, System Program) = `EhAss6gbDU57Cmwwyeq3RwHBVRvBK4CkzLS8yvddFZ1E`. Provably unsignable: off-curve (no private key can exist — asserted `isOnCurve == false`) AND the System Program contains no `invoke_signed` path, so no PDA signature can ever be produced for it |
| `create_venue_market` wrapper | takes ONLY name + expiry — no fee parameter exists in the interface, so "rejects any nonzero fee argument" holds by construction; zero fees, sentinel, `venue_authority` admins, permissionless crank, no oracles, production lots all compiled in; post-CPI byte-for-byte header verification fails closed; negative vectors: wrong sentinel account → `WrongSentinel`, non-admin caller → `NotAdmin` |
| Create-CPI wire golden | the ACTUAL inner instruction from the creation transaction is parsed on-chain: all 21 accounts in exact IDL order (oracle/None placeholders, sentinel, both `venue_authority` roles, event authority) and the full argument byte image (name, conf_filter, staleness None, lots 10,000/1,000,000, fees 0/0, expiry) match the pinned expectation hex-for-hex |
| Enumeration, machine-checked | the pinned IDL's full 29-instruction surface is asserted name-for-name, and the two safety-field writers carry exactly their expected signer requirement (`setMarketExpired`→`closeMarketAdmin`, `sweepFees`→`collectFeeAdmin`) |
| Fee collection impossible | `accounts_ix/sweep_fees.rs`: `has_one = collect_fee_admin` + `Signer` — any real signer fails `ConstraintHasOne` (proven), and the only account that could pass is the sentinel, which can never sign |
| Fee counters stay zero | after a maker + Market Action session: `fees_accrued`, `fees_to_referrers`, `referrer_rebates_accrued`, `fees_available` all zero (offsets 496/512/528/536) |
| **Header-mutation enumeration** | source scan of all 24 instruction files at `796a470`: exactly TWO safety-field writers exist — `set_market_expired` → `time_expiry = -1` (close-admin-gated, §8) and `sweep_fees` → `fees_available = 0` (sentinel-gated, above). **No instruction can set admins, fees, lots, or oracles after create.** Discriminator goldens protect all three related encodings |
| No Meridian fee surface | harness source scan: no public instruction contains fee/treasury/collect/sweep/withdraw. The real IDL check re-runs against the M1 program |

`attach_venue` (accepting an externally created market) is an M1 instruction;
the created-path header verification above is the M0-provable surface, and
M1's attach must re-verify the same field set against the same offsets.

## 13. G5 evidence — Sell-No / market-assisted Pair Redemption

Proven on localnet against the pinned bytes (`tests/g5.test.ts`, `make g5`)
with the harness pair-collateral model (PairVault PDA = mint authority of
both outcome mints + owner of the collateral vault; liability atom-denominated
per ADR-0002).

| Fact | Evidence |
| --- | --- |
| Only the correct collateral vault funds quote | account pinned to `pair_vault.quote_vault` — foreign vault → `WrongCollateralVault` |
| User must sign the No burn | the burn's authority is the user `Signer`, and negatively proven: an attacker naming the victim's No account under their own signature fails at the token program (owner mismatch) |
| Program Yes-trade ATA exact | address re-derived as ATA(yes_mint, PairVault) — any other → `WrongTradeAta` |
| Exact `q_atoms` Yes acquired | G4-style postcondition on the trade ATA; partial → `PartialFillReverted` with vault, liability, and user tokens all untouched |
| Vault/liability invariant | `vault_delta == liability_delta == −q` asserted **on-chain** after every redemption (`VaultInvariantViolated` otherwise); proven at $0.40 and the 99-cent corner (proceeds exactly 1 cent/token, zero fees) |
| Knowing self-cross prevention | builder-side `wouldKnowinglySelfCross` scans the user's own OpenOrders (40-byte `OpenOrder` records per `state/open_orders_account.rs:426-438`, tail-anchored array; asks odd) — detection proven with no false positive one tick below, and `chooseSellNoRoute` routes to direct Pair Redemption, which executes green as the chosen alternative |
| Raced self-cross = Internal Unwind | forcing the redemption against the user's own resting ask still satisfies the exact vault invariant; the user's maker proceeds settle normally — solvent, classified Internal Unwind |
| `penalty_payer` never collateral | the USER is the venue penalty payer; collateral-vault and PairVault lamports proven byte-identical across every flow |
| Solvency | `vault raw >= Collateral Liability` holds at the end of the suite |

Post-review hardening: token CPIs are pinned to the classic SPL Token program
in every account struct (`WrongTokenProgram` otherwise) — a foreign "token
program" could otherwise no-op transfers while liability mutated; `init_pair`
now validates both mint authorities (= PairVault PDA, zero supply) and vault
ownership before binding; `mint_pair`/`redeem_pair_direct` assert
`vault >= liability` on-chain after every mutation. Ordering note for the
payout math: at the pin, `place_take_order` never credits the taker's quote
account on the Bid side beyond unspent limit (maker proceeds go to OpenOrders
positions, not ATAs), and the final `vault_before − vault_after == q` check
backstops the decomposition regardless.

## 14. G6 evidence — EventHeap / inline maker policy

Measured on localnet against the pinned bytes (`tests/g6.test.ts`, `make g6`;
numbers in `docs/adr/g6-measurements.json`), 16 independent makers, v0 + ALT
transactions.

| Fact | Evidence |
| --- | --- |
| **Practical inline-fill capacity is 11, not 15** | `FILL_EVENT_REMAINING_LIMIT = 15` (`book.rs:19`) is theoretical; the venue's 32 KB SBF heap OOMs first. Contiguous probe (4…15): **11 completes, 12 panics** (`memory allocation failed` inside the venue). Taker builders must cap inline makers at 11 and route the tail through the heap + consume |
| `requestHeapFrame` does NOT rescue it | a 256 KB frame leaves the CPI'd venue invocation at the default heap on Agave 3.1.13 — a hard bound, not a budget knob |
| Big takes need v0 + ALT | 16-maker takes exceed the 1232-byte legacy limit; the suite's ALT + v0 sender is the G7 composite mechanism working |
| **Heap capacity 600, empirically** | the heap was FILLED to exactly `MAX_NUM_EVENTS = 600`; the 601st fill **panics** (`push_back` asserts `!is_full`, `heap.rs:77`) — saturation is fail-closed, proven on-chain, and trading halts until consume runs |
| **Unconsumed fills lock OO slots** | a heaped fill keeps the maker's OpenOrders slot occupied until consumed (`OpenOrdersFull` at 24 in-flight per OO) — a stalled keeper freezes maker capacity long before the heap fills; reaching 600 required two OO accounts per maker |
| Consume batch semantics | `MAX_EVENTS_CONSUME = 8` per instruction (`consume_events.rs:11`); an event whose owner OO is not in remaining accounts is **skipped** (proven: owner-less consume left all 8); the keeper must enumerate owners |
| Consume cost, measured | 1 event = 9,639 CU; 7 events = 31,255 CU; marginal ≈ 3,603 CU/event. **Chained tx measured**: 12 consume ixs drained 96 events in 465,538 CU ⇒ ~288 events per 1.4 M-CU tx — the full 600-event heap drains in ~3 such transactions |
| Consume-prepend composite | consume(8) + inline take in ONE transaction proven green — the builder policy shape |
| Keeper throughput SLO | worst-case generation is bounded by take throughput (≤11 events per take tx); one keeper tx clears ≈ 288 events — the ≥2× requirement holds with two orders of magnitude of margin, from measured numbers |
| Latency baselines (localnet) | inline take 538 ms; match+heap take 1143 ms; prepend composite 539 ms; chained consume 532 ms. Devnet re-baselines ride with issue #8 |

## 15. G7 evidence — transaction feasibility / one-approval gate

Measured on localnet under the STRICT ALT split (lookup table holds only
stable program IDs, the Config PDA, and the pinned quote mint; every per-day
and per-user address inline) — `tests/g7.test.ts`, `make g7`, numbers in
`docs/adr/g7-measurements.json`.

| Composite | Bytes | Accts | CU | One approval |
| --- | ---: | ---: | ---: | --- |
| **First-use Buy-No-limit (HARD GATE)** | **936** | 23 | 148,687 | **YES — one signature, wallet-simulates, executes. 296 bytes of headroom. The named waiver is NOT needed** |
| First-use Buy-Yes-limit | 666 | 16 | 79,178 | yes |
| `redeem_no_via_market`, 11 inline makers | 849 | 24 | 146,038 | yes |
| Pre-consume + take composite | 700 | 18 | 79,984 | yes |
| Post-close cancel + settle + direct Pair Redemption | 753 | 19 | 47,857 | yes |
| Operator venue creation | two transactions: books funding 627 B, create+gate+pair 925 B / 143,205 CU. The one-transaction variant measures **1,319 B > 1,232** (five signatures) and is impossible — operator flows carry no one-approval requirement |

First-use Buy-No composite content: OOI + OOA creation + both outcome ATA
creations + `mint_pair` + PostOnly ask — the full source requirement, with
both outcome ATAs absent beforehand and only a funded quote ATA present.
Deferred to M1 instructions (tracked by the go/no-go): `create_strike_market`
first/later variants (Metaplex + SettlementRecord CPIs), batched settlement,
intraday add-strike attach sequence — each must be re-measured when it
exists; the headroom above suggests no structural risk.
