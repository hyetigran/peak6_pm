## Private keys — never overwrite

Never overwrite, delete, or regenerate a file holding a secret key (`.demo-config.json`,
`.demo-faucet.json`, `keys/*.json`, `wallets/*.json`, `~/.config/solana/*.json`). Back it up
with a timestamp first and say so. `scripts/seed-demo.ts` refuses to run when its key-bearing
outputs exist (`SEED_ALLOW_OVERWRITE=1` bypasses only after an automatic backup). Point seeds
at `keys/` via `GOVERNANCE_KEYPAIR` / `OPERATOR_KEYPAIR_PATH` instead of letting them generate
keys. Context: on 2026-08-23 a localnet `make demo` overwrote the devnet governance/operator
keys, orphaning the devnet Config permanently.

## Agent skills

### Issue tracker

Issues are tracked in GitLab Issues on `labs.gauntletai.com`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five default canonical labels. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.
