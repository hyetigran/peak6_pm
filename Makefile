.PHONY: governance-recovery-test build-devnet-recovery indexer-devnet keeper-once build build-devnet build-adapter fixture-verify localnet keeper marketmaker services-install g2 g3 g4 g5 g6 g7 g8 g9 g10 g12 m0 meridian-test demo demo-devnet indexer seed-config-test

fixture-verify:
	@echo "a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8  fixtures/openbook_v2-v1.7.so" | shasum -a 256 -c -
	@echo "dec8d3e0fae58c7c8f2416e5f67c25e673f047afd6dd2bba4a47e0b29a01d34c  fixtures/squads_v4.so" | shasum -a 256 -c -
	@echo "31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011  fixtures/mpl_token_metadata.so" | shasum -a 256 -c -

build: fixture-verify
	cargo build-sbf --manifest-path programs/m0-harness/Cargo.toml
	cargo build-sbf --manifest-path programs/meridian/Cargo.toml --features localnet
	cp wallets/meridian-program.json target/deploy/meridian-keypair.json

# Strict, devnet-bound build: NO `localnet` feature (enforces the real
# schedule/settlement floors and the not(localnet) settlement-read path), and
# the m0-harness (mock feed) is intentionally NOT built or deployed to devnet.
# Deletes any prior meridian.so first so the manifest can never hash a stale
# artifact. Emits a manifest (commit + executable SHA-256 + program id) under
# gitignored target/; commit it to the deployment record at deploy time
# (DEVNET_DEPLOY Phase 2) — the build never auto-commits.
build-devnet: fixture-verify
	rm -f target/deploy/meridian.so
	cargo build-sbf --manifest-path programs/meridian/Cargo.toml
	cp wallets/meridian-program.json target/deploy/meridian-keypair.json
	@set -e; \
	commit=$$(git rev-parse HEAD); \
	sha=$$(shasum -a 256 target/deploy/meridian.so | awk '{print $$1}'); \
	prog=$$(solana-keygen pubkey wallets/meridian-program.json); \
	[ -n "$$commit" ] && [ -n "$$sha" ] && [ -n "$$prog" ] || { echo "build-devnet: manifest field empty (commit='$$commit' sha='$$sha' prog='$$prog')" >&2; exit 1; }; \
	printf 'commit  %s\nsha256  %s\nprogram %s\n' "$$commit" "$$sha" "$$prog" | tee target/deploy/meridian-devnet.manifest

localnet: build
	./scripts/localnet.sh

g2: build
	./scripts/run-suite.sh tests/g2.test.ts

g3: build
	./scripts/run-suite.sh tests/g3.test.ts

g4: build
	./scripts/run-suite.sh tests/g4.test.ts

g5: build
	./scripts/run-suite.sh tests/g5.test.ts

g6: build
	./scripts/run-suite.sh tests/g6.test.ts

g7: build
	./scripts/run-suite.sh tests/g7.test.ts

g12: build
	./scripts/run-suite.sh tests/g12.test.ts

# ADR-0038: reset_governance under the upgradeable loader. Runs the recovery
# build (feature on: R1-R4) and then the strict localnet build (feature off: R5).
governance-recovery-test: fixture-verify
	cargo build-sbf --manifest-path programs/m0-harness/Cargo.toml
	cargo build-sbf --manifest-path programs/meridian/Cargo.toml --features localnet,governance-recovery
	MERIDIAN_UPGRADE_AUTHORITY=$(HOME)/.config/solana/id.json RECOVERY_BUILD=1 ./scripts/run-suite.sh tests/governance-recovery.test.ts
	cargo build-sbf --manifest-path programs/meridian/Cargo.toml --features localnet
	MERIDIAN_UPGRADE_AUTHORITY=$(HOME)/.config/solana/id.json RECOVERY_BUILD=0 ./scripts/run-suite.sh tests/governance-recovery.test.ts

# ADR-0038 recovery build for devnet: strict (no localnet) PLUS reset_governance.
# Deploy, call reset_governance once, then `make build-devnet` and redeploy.
build-devnet-recovery: fixture-verify
	rm -f target/deploy/meridian.so
	cargo build-sbf --manifest-path programs/meridian/Cargo.toml --features governance-recovery
	cp wallets/meridian-program.json target/deploy/meridian-keypair.json
	@sha=$$(shasum -a 256 target/deploy/meridian.so | awk '{print $$1}'); printf 'RECOVERY BUILD (governance-recovery feature ON)\ncommit  %s\nsha256  %s\n' "$$(git rev-parse HEAD)" "$$sha" | tee target/deploy/meridian-devnet-recovery.manifest

demo: build
	./scripts/demo.sh

# Synthetic devnet plumbing demo (ADR-0028): seeds Active markets on devnet using
# the STRICT build's real settlement-delay floors + real identities (Circle USDC,
# captured OpenBook sha/authority, real metadata URI). DEMO_MODE=devnet makes the
# seed resolver require + validate those; delays below the floor fail fast.
# Prerequisites (see .env.example): the program deployed to devnet (build-devnet
# then `solana program deploy`), funded GOVERNANCE_KEYPAIR + OPERATOR_KEYPAIR_PATH,
# QUOTE_MINT, OPENBOOK_EXECUTABLE_SHA256, OPENBOOK_UPGRADE_AUTHORITY, METADATA_URI,
# and ORACLE_PROGRAM_ID (the deployed pyth-adapter; per-ticker feeds are its delivery PDAs).
# The Pyth oracle adapter (synthetic demo track): a swappable transport that
# reads a Pyth PriceUpdateV2 and writes the normalized delivery layout Meridian
# reads. Separate program; Meridian is untouched.
build-adapter:
	cargo build-sbf --manifest-path programs/pyth-adapter/Cargo.toml

# Full keeper-in-pyth-mode settlement proof on localnet (#16): Pyth-cloned
# validator -> seed with the adapter as transport -> keeper KEEPER_ORACLE=pyth
# (Hermes pull -> post PriceUpdateV2 -> adapter crank -> finalize -> settle) ->
# assert the Settlement Record's Official Close IS the real Pyth price. Needs
# network (devnet clone + Hermes). Nonzero on failure.
pyth-settle-e2e: build build-adapter
	./scripts/pyth-settle-e2e.sh

demo-devnet: build-devnet
	@[ "$$RPC_URL" ] || { echo "demo-devnet: set RPC_URL to a devnet endpoint (and the devnet env — see .env.example / Makefile note)"; exit 1; }
	DEMO_MODE=devnet pnpm exec tsx scripts/seed-demo.ts

# Fast unit check for the seed resolver — no validator.
seed-config-test:
	pnpm exec tsx --test tests/seed-config.test.ts

indexer: services-install
	cd services/indexer && PORT=8787 pnpm start

keeper: services-install
	cd services/keeper && DEMO_CONFIG=$(CURDIR)/.demo-config.json KEEPER_STATUS=$(CURDIR)/.keeper-status.json pnpm start

# Production keeper (#19, ADR-0031/0035): scheduler-driven (two jobs/day + a
# durable run-ledger), NOT the per-second demo poll. A cron/at-least-once trigger
# runs this; the lock file prevents overlap. See PRODUCTION_INFRA §2.
keeper-prod: services-install
	cd services/keeper && DEMO_CONFIG=$(CURDIR)/.demo-config.json KEEPER_LEDGER=$(CURDIR)/.keeper-ledger.json KEEPER_LOCK=$(CURDIR)/.keeper.lock pnpm prod

# Devnet cadences (keyed RPC budget): indexer full-scan every 60s; keeper as a
# cron ONE-SHOT (KEEPER_ONCE=1) fired at close+delay and resolution+5m, with a
# 15m reconcile while it runs. Requires RPC_URL and DEMO_CONFIG (operator key)
# in the environment. See PRODUCTION_INFRA §2/§6.
indexer-devnet: services-install
	@[ "$$RPC_URL" ] || { echo "indexer-devnet: set RPC_URL"; exit 1; }
	cd services/indexer && PORT=8787 INDEXER_POLL_MS=$${INDEXER_POLL_MS:-60000} pnpm start

keeper-once: services-install
	@[ "$$RPC_URL" ] && [ "$$DEMO_CONFIG" ] || { echo "keeper-once: set RPC_URL and DEMO_CONFIG"; exit 1; }
	cd services/keeper && KEEPER_ONCE=1 KEEPER_ORACLE=$${KEEPER_ORACLE:-pyth} KEEPER_SCHED_TICK_SECS=$${KEEPER_SCHED_TICK_SECS:-1200} KEEPER_RECONCILE_SECS=$${KEEPER_RECONCILE_SECS:-900} KEEPER_LEDGER=$${KEEPER_LEDGER:-$(CURDIR)/.keeper-ledger.json} KEEPER_LOCK=$${KEEPER_LOCK:-$(CURDIR)/.keeper.lock} pnpm prod

# Identity-drift monitor (#25, ADR-0030): independently re-derives the pinned
# OpenBook + oracle-adapter executable identity and alerts on drift (webhook
# ALERT_WEBHOOK_URL, receiver #10). Devnet: the hash dimension needs the
# upgradeable loader. See PRODUCTION_INFRA §5.
identity-monitor: services-install
	cd services/keeper && pnpm monitor

marketmaker: services-install
	cd services/marketmaker && DEMO_CONFIG=$(CURDIR)/.demo-config.json MM_STATUS=$(CURDIR)/.mm-status.json pnpm start

# one pnpm install covers the whole workspace (root + all services + frontend)
services-install:
	pnpm install

meridian-test: build
	./scripts/run-suite.sh tests/meridian-foundation.test.ts
	./scripts/run-suite.sh tests/meridian-venue-close.test.ts
	./scripts/run-suite.sh tests/meridian-trading.test.ts
	./scripts/run-suite.sh tests/meridian-settlement.test.ts

g8: build
	./scripts/run-suite.sh tests/g8.test.ts

g9: build
	./scripts/run-suite.sh tests/g9.test.ts

g10: build
	./scripts/run-suite.sh tests/g10.test.ts

# one validator per suite: node --test runs files concurrently, and the
# suites would race on the harness config PDA init against a shared validator
m0: build
	./scripts/run-suite.sh tests/g2.test.ts
	./scripts/run-suite.sh tests/g3.test.ts
	./scripts/run-suite.sh tests/g4.test.ts
	./scripts/run-suite.sh tests/g5.test.ts
	./scripts/run-suite.sh tests/g6.test.ts
	./scripts/run-suite.sh tests/g7.test.ts
	./scripts/run-suite.sh tests/g8.test.ts
	./scripts/run-suite.sh tests/g9.test.ts
	./scripts/run-suite.sh tests/g10.test.ts
	./scripts/run-suite.sh tests/g12.test.ts
