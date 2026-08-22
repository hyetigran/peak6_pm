#!/usr/bin/env bash
# Local validator for the Pyth crank chain (#16): clones the Pyth On-Demand
# receiver + Wormhole (+ receiver config, guardian set) from devnet and loads the
# pyth-adapter, so `services/keeper/src/pyth-e2e.ts` runs Hermes pull -> post
# PriceUpdateV2 -> adapter crank end-to-end on localnet against REAL Hermes data.
# Requires target/deploy/pyth_adapter.so (make build-adapter). Ctrl-C to stop.
#
# Then, in another shell:  cd services/keeper && pnpm exec tsx src/pyth-e2e.ts 1
set -euo pipefail
cd "$(dirname "$0")/.."
pkill -9 -f solana-test-validator 2>/dev/null || true; sleep 2; rm -rf .pyth-validator
solana-test-validator --reset --quiet --url https://api.devnet.solana.com \
  --clone-upgradeable-program rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ \
  --clone-upgradeable-program HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ \
  --clone DaWUKXCyXsnzcvLUyeJRWou8KTn7XtadgTsdhJ6RHS7b `# receiver config` \
  --clone 6GaHgiaQg9Pg346xHq9m7vQ9rJtnH83gQKqJoiAxQa7D `# wormhole guardian set` \
  --clone 3XdwuRsDjubN79G8hbGXyDD8ozRHbQMRxCS6hZQKWc42 \
  --bpf-program Egc4ykuRJaDz7VfWS9EB9U2hsP2aU9repCCk8XGnk7w4 target/deploy/pyth_adapter.so \
  --ledger .pyth-validator
