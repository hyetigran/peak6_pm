#!/usr/bin/env bash
# Full keeper-in-pyth-mode settlement proof on localnet (#16):
#   Pyth-cloned validator (all Meridian programs + Pyth receiver/Wormhole + adapter)
#   -> seed GOOGL+TSLA with the adapter as transport, closing in DEMO_SETTLE_SECS
#   -> indexer -> keeper KEEPER_ORACLE=pyth (Hermes pull -> post -> adapter crank
#      -> finalize -> settle) -> assert the Settlement Record's Official Close IS
#      the real Pyth price the adapter delivered. Nonzero exit on any failure.
# Needs network (devnet clone + Hermes). ~3-4 min.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
ROOT="$(pwd)"
TICKERS="${PYTH_TICKERS:-3,7}"
SETTLE_SECS="${DEMO_SETTLE_SECS:-20}"
TIMEOUT="${PYTH_SETTLE_TIMEOUT:-240}"

cleanup() {
  [ -n "${IDX_PID:-}" ] && kill "$IDX_PID" 2>/dev/null
  [ -n "${KEEPER_PID:-}" ] && kill "$KEEPER_PID" 2>/dev/null
  pkill -f "services/keeper" 2>/dev/null
  pkill -9 -f solana-test-validator 2>/dev/null
}
trap cleanup EXIT INT TERM

[ -f target/deploy/pyth_adapter.so ] || { echo "[pyth-settle] missing target/deploy/pyth_adapter.so (make build-adapter)"; exit 1; }
[ -f target/deploy/meridian.so ] || { echo "[pyth-settle] missing target/deploy/meridian.so (make build)"; exit 1; }

echo "[pyth-settle] starting Pyth-cloned localnet (devnet clone of receiver + wormhole)…"
rm -f services/indexer/.indexer-pyth.sqlite*
./scripts/pyth-local.sh > logs/validator-pyth.log 2>&1 &
VPID=$!
for i in $(seq 1 120); do
  solana cluster-version -u localhost >/dev/null 2>&1 && break
  kill -0 "$VPID" 2>/dev/null || { echo "validator died:"; tail -20 logs/validator-pyth.log; exit 1; }
  sleep 1
done
echo "[pyth-settle] validator up."

echo "[pyth-settle] seeding tickers $TICKERS with the Pyth adapter as transport (close in ${SETTLE_SECS}s)…"
DEMO_ORACLE=pyth DEMO_TICKERS="$TICKERS" DEMO_SETTLE=1 DEMO_SETTLE_SECS="$SETTLE_SECS" \
  pnpm exec tsx scripts/seed-demo.ts || { echo "[pyth-settle] seed failed"; exit 1; }

echo "[pyth-settle] starting indexer…"
( cd services/indexer && INDEXER_DB=.indexer-pyth.sqlite PORT=8787 DEMO_CONFIG="$ROOT/.demo-config.json" KEEPER_STATUS="$ROOT/.keeper-status.json" pnpm start > "$ROOT/logs/indexer-pyth.log" 2>&1 & echo $! > "$ROOT/.pyth-idx.pid" )
IDX_PID="$(cat .pyth-idx.pid)"; rm -f .pyth-idx.pid
for i in $(seq 1 30); do curl -s localhost:8787/markets >/dev/null 2>&1 && break; sleep 1; done

echo "[pyth-settle] starting keeper in KEEPER_ORACLE=pyth mode…"
# KEEPER_PYTH_CAPTURE=latest: the demo close_ts is synthetic (now+20s, often a
# weekend) so no Pyth update exists AT it; prod/devnet keeps the at-close default.
( cd services/keeper && KEEPER_ORACLE=pyth KEEPER_PYTH_CAPTURE=latest KEEPER_TICK=5 DEMO_CONFIG="$ROOT/.demo-config.json" KEEPER_STATUS="$ROOT/.keeper-status.json" KEEPER_INDEXER=http://127.0.0.1:8787 pnpm start > "$ROOT/logs/keeper-pyth.log" 2>&1 & echo $! > "$ROOT/.pyth-keeper.pid" )
KEEPER_PID="$(cat .pyth-keeper.pid)"; rm -f .pyth-keeper.pid

echo "[pyth-settle] waiting for the keeper to crank Pyth + finalize + settle (timeout ${TIMEOUT}s)…"
want=$(curl -s localhost:8787/markets | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["markets"]))' 2>/dev/null || echo 0)
for i in $(seq 1 "$TIMEOUT"); do
  got=$(curl -s localhost:8787/markets | python3 -c 'import json,sys; print(sum(1 for m in json.load(sys.stdin)["markets"] if m.get("settled_ts")))' 2>/dev/null || echo 0)
  printf "\r[pyth-settle]   settled %s/%s   " "$got" "$want"
  [ "$want" != "0" ] && [ "$got" = "$want" ] && break
  sleep 1
done
echo
echo "[pyth-settle] keeper log (settlement lines):"
grep -i "settle\|pyth\|finalize\|fail\|error" logs/keeper-pyth.log | tail -12

DEMO_CONFIG=.demo-config.json pnpm exec tsx scripts/pyth-settle-check.ts "$TICKERS"
