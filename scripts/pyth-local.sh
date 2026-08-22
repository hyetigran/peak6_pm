#!/usr/bin/env bash
# Local validator for the Pyth crank chain (#16): the FULL Meridian localnet
# (scripts/localnet.sh — OpenBook pin, meridian, m0-harness, Squads, metadata)
# plus the Pyth On-Demand receiver + Wormhole (+ receiver config, guardian set)
# cloned from devnet, plus the pyth-adapter. So both the adapter-only proof
# (services/keeper/src/pyth-e2e.ts) and the full keeper-in-pyth-mode settlement
# (scripts/pyth-settle-e2e.sh) run on localnet against REAL Hermes data.
# Requires target/deploy/{pyth_adapter,meridian}.so (make build build-adapter).
# Ctrl-C to stop.
#
# Adapter-only:  cd services/keeper && pnpm exec tsx src/pyth-e2e.ts 1
# Full settle:   make pyth-settle-e2e   (drives this script itself)
set -euo pipefail
cd "$(dirname "$0")/.."
pkill -9 -f solana-test-validator 2>/dev/null || true; sleep 2; rm -rf .pyth-validator
exec ./scripts/localnet.sh --url https://api.devnet.solana.com \
  --clone-upgradeable-program rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ `# pyth receiver` \
  --clone-upgradeable-program HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ `# wormhole` \
  --clone DaWUKXCyXsnzcvLUyeJRWou8KTn7XtadgTsdhJ6RHS7b `# receiver config` \
  --clone 6GaHgiaQg9Pg346xHq9m7vQ9rJtnH83gQKqJoiAxQa7D `# wormhole guardian set` \
  --clone 3XdwuRsDjubN79G8hbGXyDD8ozRHbQMRxCS6hZQKWc42 \
  --bpf-program Egc4ykuRJaDz7VfWS9EB9U2hsP2aU9repCCk8XGnk7w4 target/deploy/pyth_adapter.so \
  --ledger .pyth-validator "$@"
