.PHONY: build build-devnet fixture-verify localnet keeper marketmaker services-install g2 g3 g4 g5 g6 g7 g8 g9 g10 g12 m0 meridian-test demo indexer

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

demo: build
	./scripts/demo.sh

indexer: services-install
	cd services/indexer && PORT=8787 pnpm start

keeper: services-install
	cd services/keeper && DEMO_CONFIG=$(CURDIR)/.demo-config.json KEEPER_STATUS=$(CURDIR)/.keeper-status.json pnpm start

marketmaker: services-install
	cd services/marketmaker && DEMO_CONFIG=$(CURDIR)/.demo-config.json MM_STATUS=$(CURDIR)/.mm-status.json pnpm start

# one pnpm install covers the whole workspace (root + all services + frontend)
services-install:
	pnpm install

meridian-test: build
	./scripts/run-suite.sh tests/meridian-foundation.test.ts
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
