# Separate atom-level recovery from whole-contract trading

Minting, direct Pair Redemption, and Outcome Redemption operate on any positive number of atoms so freely transferred fractional tokens remain recoverable without rounding. Venue-backed actions require whole-contract quantities because the Venue Market uses one whole token per base lot; public quantities remain atom-denominated and invalid venue quantities are rejected rather than rounded.
