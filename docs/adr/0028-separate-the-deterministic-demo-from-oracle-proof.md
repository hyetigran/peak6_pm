# Separate the deterministic demo from oracle proof

`make demo-devnet` uses a clearly labeled, public-HTTPS synthetic Settlement Record so the required end-to-end demo is deterministic. `make oracle-e2e-devnet` separately proves the real Nasdaq Official Close and provider path, and that real-data proof remains a non-waiverable M0 gate. Synthetic evidence demonstrates plumbing only and cannot satisfy settlement-correctness, provider-finality, or production-readiness claims.
