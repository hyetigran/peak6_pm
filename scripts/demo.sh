#!/usr/bin/env bash
# One-command localnet demo: validator (all programs) -> seed markets ->
# indexer -> frontend. Ctrl-C tears everything down.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

cleanup() {
  echo; echo "[demo] shutting down…"
  [ -n "${IDX_PID:-}" ] && kill "$IDX_PID" 2>/dev/null
  [ -n "${FE_PID:-}" ] && kill "$FE_PID" 2>/dev/null
  pkill -9 -f solana-test-validator 2>/dev/null
  exit 0
}
trap cleanup INT TERM

echo "[demo] building programs (localnet feature)…"
make build >/dev/null 2>&1

echo "[demo] starting validator…"
pkill -9 -f solana-test-validator 2>/dev/null; sleep 1
rm -rf .validator services/indexer/.indexer.sqlite*
./scripts/localnet.sh --ledger .validator > .validator-demo.log 2>&1 &
for i in $(seq 1 60); do solana cluster-version -u localhost >/dev/null 2>&1 && break; sleep 1; done
echo "[demo] validator up."

echo "[demo] seeding markets…"
npx tsx scripts/seed-demo.ts

echo "[demo] starting indexer on :8787…"
( cd services/indexer && INDEXER_DB=.indexer.sqlite PORT=8787 DEMO_FAUCET="$ROOT/.demo-faucet.json" npx tsx src/index.ts > "$ROOT/.indexer-demo.log" 2>&1 & echo $! > /tmp/mrd_idx.pid )
IDX_PID="$(cat /tmp/mrd_idx.pid)"
sleep 4
curl -s localhost:8787/markets | python3 -c "import json,sys; print('[demo] indexer sees', len(json.load(sys.stdin)['markets']), 'markets')" 2>/dev/null || echo "[demo] indexer starting…"

echo "[demo] starting frontend on :${FE_PORT:-3100}…"
( cd frontend && npm run dev -- -p ${FE_PORT:-3100} > "$ROOT/.frontend-demo.log" 2>&1 & echo $! > /tmp/mrd_fe.pid )
FE_PID="$(cat /tmp/mrd_fe.pid)"

echo
echo "==================================================================="
echo "  Meridian demo is live:"
echo "    Frontend : http://localhost:${FE_PORT:-3100}"
echo "    Indexer  : http://localhost:8787/markets"
echo "    RPC      : http://localhost:8899 (localnet)"
echo "  Ctrl-C to stop everything."
echo "==================================================================="
wait
