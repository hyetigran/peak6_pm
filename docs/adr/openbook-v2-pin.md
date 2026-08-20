# OpenBook V2 pin evidence (G1)

**Status: G1 RED — non-waiverable failure.** The executable identity is fully verified against the pin, but the devnet deployment retains a live upgrade authority, which G1 names as a non-waiverable failure that reopens the architecture before funds are exposed. Do not begin M1 from this file.

Verified 2026-08-19 against `https://api.devnet.solana.com` and `https://api.mainnet-beta.solana.com` (solana-cli 3.1.13), the official GitHub release, and source files fetched at the pinned commit. Every fact below cites where it was read.

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

Until one of these is adopted by ADR, M0 continues on gates that do not depend on executable immutability (G2–G10 measurements run against the current deployment and stay valid as long as the recorded slot `282042596` is unchanged), and M1 remains blocked.
