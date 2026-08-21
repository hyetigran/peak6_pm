#!/usr/bin/env bash
# Non-interactive demo bring-up for screenshotting: validator + seed + indexer
# + frontend dev, left running. Writes PIDs so a caller can tear down.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
pkill -9 -f solana-test-validator 2>/dev/null; pkill -f "src/index.ts" 2>/dev/null; pkill -f "next dev" 2>/dev/null; pkill -f "services/keeper" 2>/dev/null; pkill -f "services/marketmaker" 2>/dev/null; sleep 1
rm -rf .validator services/indexer/.indexer.sqlite*
make build >/dev/null 2>&1
# one pnpm install covers the whole workspace
pnpm install
./scripts/localnet.sh --ledger .validator > .validator-demo.log 2>&1 &
for i in $(seq 1 60); do solana cluster-version -u localhost >/dev/null 2>&1 && break; sleep 1; done
pnpm exec tsx scripts/seed-demo.ts > .seed-demo.log 2>&1
( cd services/indexer && INDEXER_DB=.indexer.sqlite PORT=8787 DEMO_FAUCET="$ROOT/.demo-faucet.json" DEMO_CONFIG="$ROOT/.demo-config.json" KEEPER_STATUS="$ROOT/.keeper-status.json" MM_STATUS="$ROOT/.mm-status.json" pnpm start > "$ROOT/.indexer-demo.log" 2>&1 & echo $! > /tmp/mrd_idx.pid )
sleep 3
( cd services/keeper && DEMO_CONFIG="$ROOT/.demo-config.json" KEEPER_STATUS="$ROOT/.keeper-status.json" KEEPER_INDEXER=http://127.0.0.1:8787 pnpm start > "$ROOT/.keeper-demo.log" 2>&1 & echo $! > /tmp/mrd_keeper.pid )
( cd services/marketmaker && DEMO_CONFIG="$ROOT/.demo-config.json" MM_STATUS="$ROOT/.mm-status.json" MM_INDEXER=http://127.0.0.1:8787 pnpm start > "$ROOT/.mm-demo.log" 2>&1 & echo $! > /tmp/mrd_mm.pid )
( cd frontend && pnpm exec next dev -p ${FE_PORT:-3100} > "$ROOT/.frontend-demo.log" 2>&1 & echo $! > /tmp/mrd_fe.pid )
# wait for next dev to be ready
for i in $(seq 1 60); do curl -s localhost:${FE_PORT:-3100} >/dev/null 2>&1 && break; sleep 1; done
echo "DEMO_UP markets=$(curl -s localhost:8787/markets | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["markets"]))' 2>/dev/null)"
