.PHONY: build fixture-verify localnet g2 g3 m0

fixture-verify:
	@echo "a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8  fixtures/openbook_v2-v1.7.so" | shasum -a 256 -c -

build: fixture-verify
	cargo build-sbf --manifest-path programs/m0-harness/Cargo.toml

localnet: build
	./scripts/localnet.sh

g2: build
	./scripts/run-suite.sh tests/g2.test.ts

g3: build
	./scripts/run-suite.sh tests/g3.test.ts

m0: build
	./scripts/run-suite.sh tests/g2.test.ts
	./scripts/run-suite.sh tests/g3.test.ts
