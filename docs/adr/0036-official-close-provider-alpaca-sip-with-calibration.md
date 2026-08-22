# Official-Close provider: Alpaca SIP, calibrated against Massive SIP

Closes the decision half of #9. Settlement uses the unadjusted Official Close
under the primary listing market's rules — Nasdaq NOCP for the V1 MAG7 universe
(AAPL, AMZN, GOOGL, META, MSFT, NVDA, TSLA, all Nasdaq-listed) — delivered as
one atomic Settlement Record (PRICE, observation timestamp, Close Method, halt/
contingency status, provider observation/revision, raw-response digest) under
the frozen record contract (ADR-0006/0021/0023). The provider fits the contract;
the contract is never weakened to fit a provider.

**Decision.** The primary programmatic provider is **Alpaca Market Data (SIP)**.
Rationale: it is devnet-friendly, cheap, and quick to provision (API key/secret),
which fits a devnet G11 demo gate rather than a production trading venue.

**Honest capability caveat (must survive).** Alpaca's SIP "close" is the last
consolidated SIP trade of the session, which **approximates but is not identical
to** the Nasdaq NOCP (the closing-auction/cross price Nasdaq publishes). A truly
authoritative NOCP comes from the Nasdaq closing cross (TotalView-ITCH via
databento, or Nasdaq Basic/Data Link). For a genuine production Official Close,
revisit toward one of those; for the G11 **synthetic/demo** proof the value is
captured at the close and validated by the calibration band below.

**Calibration method (PRD, unchanged).** The captured-at-close value is
cross-checked against **two SIP sources — Massive SIP + Alpaca SIP** — and must
agree within the frozen quality band (`max_price_band_bps`, `min_samples`,
`max_stale_slots`; `max_sample_spread_bps = 0` in V1). Disagreement or an absent
Official Close yields Settlement Disputed, never a fabricated close. The signed
`docs/adr/settlement-quality-calibration.md` (a separate G11 deliverable)
publishes the empirically selected bounds before M1.

**Close Method / provenance.** The Settlement Record records `close_method_id`
(NOCP), `provider_id`, the exchange publication time, provider observation time,
and the raw-response digest so a fallback value cannot masquerade as an ordinary
close (ADR-0021).

**Consequences / still open (ops).**
- Provision `ALPACA_API_KEY` / `ALPACA_API_SECRET` (already declared in
  `.env.example`) and the Massive SIP credential for the cross-check. Never
  committed.
- `make oracle-e2e-devnet` (#16) proves the real chain: provider → capture at the
  close → normalize → finalize → settle, with the calibration band and the
  Settlement-Disputed path. This is the non-waiverable G11 (ADR-0028); a Pyth
  settle (ADR-0034) is the synthetic counterpart and does not satisfy it.
- If a production venue is later pursued, re-open this ADR toward an
  authoritative closing-cross source (databento TotalView / Nasdaq Basic).

Relates to #9 (this decision), #16 (G11 proof), ADR-0006/0021/0023 (record
contract), ADR-0028 (synthetic vs real), ADR-0034 (Pyth synthetic transport).
