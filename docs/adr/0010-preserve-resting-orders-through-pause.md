# Preserve resting orders through pause

Pausing blocks new maker and taker actions but does not mutate user-owned resting orders, while cancellation, event consumption, fund settlement, and Redemption remain available. Remaining orders resume when the Outcome Market is unpaused, with an explicit UI warning, because forced cancellation is neither atomic nor generally authorized; irreversible venue expiry remains a separate circuit breaker.
