#!/usr/bin/env bash
# G2 runner: fresh localnet with the pinned fixture, then the test suite.
set -uo pipefail
cd "$(dirname "$0")/.."
pkill -f solana-test-validator 2>/dev/null; sleep 1
rm -rf .validator
./scripts/localnet.sh --ledger .validator > .validator-test.log 2>&1 &
VPID=$!
for i in $(seq 1 60); do
  solana cluster-version -u localhost >/dev/null 2>&1 && break
  kill -0 "$VPID" 2>/dev/null || { echo "validator died:"; tail -20 .validator-test.log; exit 1; }
  sleep 1
done
npx tsx --test tests/g2.test.ts
status=$?
kill "$VPID" 2>/dev/null
exit $status
