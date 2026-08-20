#!/usr/bin/env bash
# Meridian M0 localnet: the pinned OpenBook v1.7 artifact at the SAME program
# ID as the finalized devnet copy (ADR-0029), plus the M0 harness.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${FIXTURE:-}" ]; then
  sha=$(shasum -a 256 fixtures/openbook_v2-v1.7.so | cut -d' ' -f1)
  pin="a3eb0fad20778b31a20c6b98e4e61b8e9425ccbfb27a96f8165f70c0381bafa8"
  [ "$sha" = "$pin" ] || { echo "FIXTURE HASH MISMATCH: $sha != $pin" >&2; exit 1; }
fi
OPENBOOK_ID="${OPENBOOK_ID:-opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb}"
FIXTURE="${FIXTURE:-fixtures/openbook_v2-v1.7.so}"
exec solana-test-validator --reset --quiet \
  --bpf-program "$OPENBOOK_ID" "$FIXTURE" \
  --bpf-program 3MmdMxRUF4NWPNdwoQcLhoqfmiKReoaSQR9GwSeQEpRr target/deploy/m0_harness.so \
  --bpf-program FF6mu5FFb1q1Qz88x1HnhkePdF8Q1dXWnTfUUSkzUT3t target/deploy/meridian.so \
  --bpf-program SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf fixtures/squads_v4.so \
  --account BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr fixtures/squads_program_config.json \
  "$@"
