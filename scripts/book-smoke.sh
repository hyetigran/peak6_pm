#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
pkill -9 -f solana-test-validator 2>/dev/null; pkill -f "src/index.ts" 2>/dev/null; sleep 2
rm -rf .validator services/indexer/.indexer.sqlite*
./scripts/localnet.sh --ledger .validator > .validator-test.log 2>&1 &
for i in $(seq 1 60); do solana cluster-version -u localhost >/dev/null 2>&1 && break; sleep 1; done
npx tsx scripts/book-demo.ts
MKT="$(cat .book-market.txt)"
( cd services/indexer && INDEXER_DB=.indexer.sqlite PORT=8787 npx tsx src/index.ts >/tmp/idx.log 2>&1 & echo $! >/tmp/idxpid )
sleep 5
echo "=== /book/$MKT ==="
curl -s "localhost:8787/book/$MKT" | python3 -m json.tool
kill "$(cat /tmp/idxpid)" 2>/dev/null; pkill -9 -f solana-test-validator 2>/dev/null
echo "BOOK_SMOKE DONE"
