# Create the next session's markets at resolution + 5 minutes, rolling continuously

The next session's strike ladder anchors on the **prior Official Close** (±3/6/9%,
PRD §6), and that anchor only becomes known at settlement — the NOCP is published
minutes after 16:00 ET and the on-chain floor gates finalization at close+20m
(`DEVNET_NORMAL_SETTLEMENT_DELAY_SECS`, ADR-0021). Deferring creation to an
08:00 ET morning batch therefore buys nothing on the anchor and idles a 24/7
chain overnight. The resolution window itself (close+15m poll, +20m earliest
settle, +25m SLO) is fixed by NOCP availability and is **unchanged** by this ADR.

**Decision.** Create the next session's Outcome Markets at **resolution + 5
minutes** (~close+30m), anchored on the just-published Official Close, as a
continuous rolling cycle rather than a next-morning batch. Creation and trading
are **decoupled**: the market account exists from the evening, while the mint
(09:00 ET) and trade (09:30 ET) windows are unchanged because they track the
underlying's session. The scheduler fires the market-open job off the completion
of the settlement job (ADR-0031), not off a wall-clock morning time.

**Safety — the checks move, they do not disappear.** The morning job's two
safety gates run **at creation time** for the *target* session: NYSE
trading-day eligibility (ADR-0014, including weekend/holiday/half-day gaps) and
the two-source Corporate Action Blackout (ADR-0022). Because a disqualifying
halt, blackout, or Official-Close correction can still emerge between an evening
creation and the next mint window — most acutely across a weekend before a
Monday session — a **pre-open re-validation gate** re-checks eligibility and
blackout shortly before the mint window opens and `abandon_market`s any market
that no longer qualifies (the instruction already exists; abandoning before the
mint window means no collateral is at risk). This preserves the ADR-0014/0022
guarantees under the earlier creation time.

**Consequences.** PRD §5's lifecycle becomes a continuous roll: session N's
markets are created at (session N−1 close) + 30m. `docs/PRODUCTION_INFRA.md` §2
market-open job fires at resolution+5m off the settlement job's completion, and a
re-validation/abandon gate is a required component (tracked as an issue). This
ADR changes only *when* creation runs and adds the pre-open gate; the strike
engine (§6), the mint/trade windows, and the resolution window are untouched.
