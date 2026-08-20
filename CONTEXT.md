# Meridian

Meridian is a market for same-day binary outcomes on whether a supported stock’s official close is at or above a stated strike. Its language distinguishes the user-facing outcome instrument from the venue that supplies liquidity.

## Markets and outcomes

**Outcome Market**:
A binary instrument for one ticker, strike, and Trading Day, represented by complementary Yes and No outcomes.
_Avoid_: Contract, Strike Market, bare Market

**Venue Market**:
The single Yes-versus-USDC order book that supplies price discovery for an Outcome Market and is mirrored for the No perspective.
_Avoid_: Outcome Market, bare Market

**Market Phase**:
The user-visible lifecycle projection of an Outcome Market: Preparing, Scheduled, Minting, Trading, Paused, Closed awaiting Settlement, Settlement delayed, Settled, Emergency expired, or Abandoned.
_Avoid_: Raw state, Active

**Trading Day**:
The exchange session date whose regular-session close determines an Outcome Market.
_Avoid_: Calendar day, expiry date

**Strike**:
The stock-price threshold used to resolve an Outcome Market; equality belongs to the Yes outcome.
_Avoid_: Target price, exercise price

**Yes Token**:
The outcome token that pays one USDC per whole token when the Official Close is at or above the Strike.
_Avoid_: Call token, bullish coin

**No Token**:
The outcome token that pays one USDC per whole token when the Official Close is below the Strike.
_Avoid_: Put token, bearish coin

**Pair**:
Equal quantities of complementary Yes and No Tokens backed by matching collateral.
_Avoid_: Bundle

## Trading and positions

**Directional Intent**:
A user-facing action to buy or sell Yes or No exposure, independent of how that action is composed against the Venue Market.
_Avoid_: Raw order-book operation

**Market Action**:
An immediate, price-bounded Directional Intent that fills completely or has no effect.
_Avoid_: Market order, partial-fill order

**Executable Depth**:
The quantity currently available in a Venue Market within a user’s price bound.
_Avoid_: Liquidity, book size

**Worst Execution Price**:
The least favorable price a confirmed Market Action may accept while still filling completely.
_Avoid_: Slippage default, estimated price

**Position State**:
A wallet’s effective outcome exposure across held tokens, venue balances, and resting or pending orders.
_Avoid_: Token balance, wallet balance

**Exposure Interval**:
The minimum and maximum directional exposure a Position State can reach across every combination of its resting and locally pending orders finalizing or filling.
_Avoid_: Net balance, current exposure

**Flat Position**:
A Position State whose Exposure Interval contains no unpaired Yes or No exposure.
_Avoid_: Empty wallet

**Yes-sided Position**:
A Position State whose Exposure Interval can contain Yes exposure but cannot cross into No exposure.
_Avoid_: Long position, bullish wallet

**No-sided Position**:
A Position State whose Exposure Interval can contain No exposure but cannot cross into Yes exposure.
_Avoid_: Short position, bearish wallet

**Mixed Position**:
A Position State whose Exposure Interval crosses from No exposure into Yes exposure and therefore needs recovery before another Directional Intent.
_Avoid_: Hedged position, invalid balance

**Unknown Position**:
A Position State that cannot be determined from fresh authoritative holdings and order data.
_Avoid_: Flat Position

**Recovery-only Mode**:
An application state that suppresses new Directional Intents when authoritative market or position data is unavailable while preserving cancellation, fund settlement, and Redemption.
_Avoid_: Offline mode, read-only mode

**Directional Guardrail**:
A product rule that prevents a new conflicting Directional Intent based on Position State while preserving valid transitional and recovery states.
_Avoid_: Position invariant, Position Constraint

**Mark Price**:
The midpoint of a fresh, two-sided Venue Market, used as an explicitly labeled estimate rather than an executable price.
_Avoid_: Current price, last price

**Implied Probability**:
The Mark Price expressed as a market-implied likelihood, available only when a defensible Mark Price exists.
_Avoid_: Probability, prediction

**Live Underlying Price**:
An informational, timestamped eligible SIP last trade for the underlying security; it becomes stale after fifteen seconds, is labeled delayed when entitlement requires it, and never affects protocol state or Settlement.
_Avoid_: Official Close, settlement price, current price

## Collateral and redemption

**Collateral Liability**:
The maximum USDC amount owed against canonical outstanding outcome-token supply: while the outcome is Unset, the greater of Yes and No supply; once an outcome is set, the winning supply. The stored value may remain a conservative upper bound after an out-of-program Direct Holder Burn until permissionless reconciliation. One outcome-token atom corresponds to one USDC atom.
_Avoid_: Pairs minted, raw vault balance

**Collateral Surplus**:
USDC held above Collateral Liability and therefore not owed to outcome-token holders or withdrawable in V1.
_Avoid_: Collateral, protocol fee

**Rent Refund Address**:
The destination fixed when an operator-funded account is created for any recoverable Solana rent returned when that account is later closed; user-funded venue-account rent returns to the user payer or owner.
_Avoid_: Current authority, collateral recipient, fee recipient

**Redemption**:
The only Meridian action family that destroys outcome tokens and releases collateral or a settled payout.
_Avoid_: Burn, withdrawal

**Direct Holder Burn**:
An unsupported classic SPL Token action in which a holder voluntarily destroys its own outcome tokens without Meridian and receives no collateral or payout; supply-based liability reconciliation turns any released obligation into ownerless Collateral Surplus.
_Avoid_: Redemption, withdrawal

**Pair Redemption**:
Redemption of equal quantities of Yes and No Tokens for their matching collateral.
_Avoid_: Outcome Redemption, Sell No

**Outcome Redemption**:
Redemption of outcome tokens after Settlement for the payout assigned to their side.
_Avoid_: Pair Redemption, claim

## Settlement

**Official Close**:
The unadjusted official closing price published under the security’s primary listing-market rules for a Trading Day, with equality at the Strike resolving to Yes.
_Avoid_: Daily bar close, last price, after-hours close, adjusted close

**Close Method**:
The primary listing market’s declared method for producing an Official Close, including its normal auction and documented halt or contingency fallbacks.
_Avoid_: Price source, aggregate type

**Settlement Record**:
The single immutable, atomically bound record shared by every Outcome Market for one ticker and Trading Day, supplying the Official Close, observation time, and provider revision when available.
_Avoid_: Price update, latest quote

**Settlement Quality Predicate**:
The delivery-account freshness, exact V1 sample agreement, qualifying-trade, final/unadjusted, and prior-close sanity conditions a Settlement Record must satisfy before Settlement.
_Avoid_: Confidence interval, latest value

**Settlement**:
The irreversible assignment of the Yes or No outcome from an accepted Settlement Record.
_Avoid_: Expiry, market close

**Settlement Disputed**:
The unresolved condition in which no trustworthy Settlement Record can be finalized, including when the primary listing market publishes no Official Close; Pair Redemption remains available while unmatched directional positions wait for evidence.
_Avoid_: Void, draw, canceled market

**Manual Settlement Override**:
A delayed recovery action that submits two agreeing evidenced settlement values from which the outcome is derived; the program binds the evidence digest, while HTTP-source authenticity remains an explicit authority/runbook trust assumption.
_Avoid_: Admin outcome, forced winner

**Emergency Expiry**:
The irreversible early expiry of a Venue Market while its Outcome Market remains available for recovery and Settlement.
_Avoid_: Pause, abandonment

## Operations and reporting

**Corporate Action Blackout**:
The exclusion of a ticker from new Outcome Markets on a Trading Day affected by a share-changing or identity-changing corporate action.
_Avoid_: Split adjustment, adjusted close

**History Completeness**:
The visible indexer status that states whether finalized Meridian and Venue Market history is complete from the deployment genesis slot through the current backfill cursor, with any known gaps exposed.
_Avoid_: Recent activity, best-effort history

**Platform-execution P&L**:
Advisory profit and loss derived only from finalized Meridian and Venue Market activity with known basis, excluding tax treatment and wallet-paid network costs.
_Avoid_: Tax basis, total wallet P&L

**Internal Unwind**:
A solvent self-cross that reduces a wallet’s paired exposure but does not represent external price discovery.
_Avoid_: Trade, realized sale
