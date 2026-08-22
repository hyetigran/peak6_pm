#!/usr/bin/env bash
# One-command localnet demo: validator (all programs) -> seed markets ->
# indexer -> frontend. Ctrl-C tears everything down.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
ROOT="$(pwd)"

cleanup() {
  echo; echo "[demo] shutting down…"
  [ -n "${IDX_PID:-}" ] && kill "$IDX_PID" 2>/dev/null
  [ -n "${KEEPER_PID:-}" ] && kill "$KEEPER_PID" 2>/dev/null
  [ -n "${MM_PID:-}" ] && kill "$MM_PID" 2>/dev/null
  [ -n "${FE_PID:-}" ] && kill "$FE_PID" 2>/dev/null
  pkill -f "services/keeper" 2>/dev/null
  pkill -f "services/marketmaker" 2>/dev/null
  pkill -9 -f solana-test-validator 2>/dev/null
  exit 0
}
trap cleanup INT TERM

echo "[demo] building programs (localnet feature)…"
make build >/dev/null 2>&1
pnpm install

echo "[demo] starting validator…"
pkill -9 -f solana-test-validator 2>/dev/null; sleep 1
rm -rf .validator services/indexer/.indexer.sqlite*
./scripts/localnet.sh --ledger .validator > logs/validator-demo.log 2>&1 &
for i in $(seq 1 60); do solana cluster-version -u localhost >/dev/null 2>&1 && break; sleep 1; done
echo "[demo] validator up."

echo "[demo] seeding markets…"
pnpm exec tsx scripts/seed-demo.ts

echo "[demo] starting indexer on :8787…"
( cd services/indexer && INDEXER_DB=.indexer.sqlite PORT=8787 DEMO_FAUCET="$ROOT/.demo-faucet.json" DEMO_CONFIG="$ROOT/.demo-config.json" KEEPER_STATUS="$ROOT/.keeper-status.json" MM_STATUS="$ROOT/.mm-status.json" pnpm start > "$ROOT/logs/indexer-demo.log" 2>&1 & echo $! > /tmp/mrd_idx.pid )
IDX_PID="$(cat /tmp/mrd_idx.pid)"
sleep 4
curl -s localhost:8787/markets | python3 -c "import json,sys; print('[demo] indexer sees', len(json.load(sys.stdin)['markets']), 'markets')" 2>/dev/null || echo "[demo] indexer starting…"

echo "[demo] starting keeper (EventHeap crank + settlement)…"
( cd services/keeper && DEMO_CONFIG="$ROOT/.demo-config.json" KEEPER_STATUS="$ROOT/.keeper-status.json" KEEPER_INDEXER=http://127.0.0.1:8787 pnpm start > "$ROOT/logs/keeper-demo.log" 2>&1 & echo $! > /tmp/mrd_keeper.pid )
KEEPER_PID="$(cat /tmp/mrd_keeper.pid)"

echo "[demo] starting market-maker (live liquidity)…"
( cd services/marketmaker && DEMO_CONFIG="$ROOT/.demo-config.json" MM_STATUS="$ROOT/.mm-status.json" MM_INDEXER=http://127.0.0.1:8787 pnpm start > "$ROOT/logs/mm-demo.log" 2>&1 & echo $! > /tmp/mrd_mm.pid )
MM_PID="$(cat /tmp/mrd_mm.pid)"

echo "[demo] starting frontend on :${FE_PORT:-3100}…"
( cd frontend && pnpm exec next dev -p ${FE_PORT:-3100} > "$ROOT/logs/frontend-demo.log" 2>&1 & echo $! > /tmp/mrd_fe.pid )
FE_PID="$(cat /tmp/mrd_fe.pid)"

echo "[demo] seeding order books (market-maker)… this takes ~60-90s"
for i in $(seq 1 90); do
  nt=$(curl -s localhost:8787/markets 2>/dev/null | python3 -c 'import json,sys
try:
 d=json.load(sys.stdin)["markets"]; print(sum(1 for m in d if m.get("mark") is not None), len(d))
except: print(0,0)' 2>/dev/null)
  printf "\r[demo]   books ready: %s   " "$nt"
  set -- $nt; [ -n "$1" ] && [ "$2" != "0" ] && [ "$1" = "$2" ] && break
  sleep 3
done
echo

echo
echo "==================================================================="
echo "  Meridian demo is live:"
echo "    Frontend : http://localhost:${FE_PORT:-3100}"
echo "    Indexer  : http://localhost:8787/markets"
echo "    RPC      : http://localhost:8899 (localnet)"
echo "  Ctrl-C to stop everything."
echo "==================================================================="
wait
