#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
pkill -9 -f solana-test-validator 2>/dev/null; pkill -f "src/index.ts" 2>/dev/null; sleep 1
rm -rf .validator services/indexer/.indexer.sqlite*
./scripts/localnet.sh --ledger .validator > .validator-test.log 2>&1 &
VPID=$!
for i in $(seq 1 60); do solana cluster-version -u localhost >/dev/null 2>&1 && break; sleep 1; done
pnpm exec tsx --test tests/meridian-foundation.test.ts >/dev/null 2>&1 || true
( cd services/indexer && INDEXER_DB=.indexer.sqlite PORT=8787 pnpm start > /tmp/indexer.log 2>&1 & echo $! > /tmp/indexer.pid )
sleep 7
echo "=== /health ==="; curl -s localhost:8787/health
echo; echo "=== /markets ==="
curl -s localhost:8787/markets | python3 -c "import json,sys; d=json.load(sys.stdin); print('markets:', len(d['markets'])); [print(' ', m['ticker'], int(m['strike_1e6'])/1e6, m['state_name']) for m in d['markets'][:6]]; print('completeness:', d['meta'])"
kill "$(cat /tmp/indexer.pid)" 2>/dev/null; kill "$VPID" 2>/dev/null; pkill -9 -f solana-test-validator 2>/dev/null
echo "SMOKE DONE"
