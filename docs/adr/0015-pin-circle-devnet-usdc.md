# Pin Circle Devnet USDC as the integration quote asset

Devnet integration pins Circle’s six-decimal Solana Devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` and validates its mint owner, token program, and decimals before Venue Market creation. Deterministic local tests may use a self-minted six-decimal asset explicitly named test USD, but must not present it as USDC.
