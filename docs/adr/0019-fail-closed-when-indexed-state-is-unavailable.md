# Fail closed when indexed market state is unavailable

When fresh authoritative venue or Position State cannot be constructed, the application enters Recovery-only Mode instead of presenting stale prices, probabilities, P&L, or new Directional Intents. Direct-RPC cancellation, fund settlement, Pair Redemption, and Outcome Redemption remain available; a Market Action also requires fresh Executable Depth and explicit confirmation of its Worst Execution Price or minimum proceeds.
