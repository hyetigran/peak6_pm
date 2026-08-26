# 2026-08-26 manual close — manifest hash provenance

`2026-08-26-manual-close.json` is the evidence manifest for the `20260826`
Override-Authority settlement. **Two different manifest hashes are recorded
on-chain for this one trading day.** This note explains why, so an auditor
who cannot verify four of the records is not left guessing.

## What is on-chain

| ticker | record state | reason | `manual_evidence_manifest_sha256` |
| --- | --- | --- | --- |
| AAPL | 2 FinalManual | 1 | `70e4467caf3ae8ccc7cdd6b3dd581bd398e2fe9ad16a3f84e43716a11afd6464` |
| AMZN | 2 FinalManual | 1 | `70e4467c…` |
| GOOGL | 2 FinalManual | 1 | `70e4467c…` |
| META | 2 FinalManual | 1 | `70e4467c…` |
| MSFT | 2 FinalManual | 1 | `fe14ad88db5152ee2e8e73019b19df484bacaa3e985564e2860220e94feedac5` |
| NVDA | 2 FinalManual | 1 | `fe14ad88…` |
| TSLA | 1 FinalNormal | 0 | all-zero — settled through the Pyth path, no manual manifest |

The checked-in `2026-08-26-manual-close.json` hashes to **`fe14ad88…`**, so
**MSFT and NVDA verify against it. AAPL, AMZN, GOOGL and META do not.**

## Why they diverge

`scripts/manual-settle.ts` originally (a) stamped a wall-clock `captured_at`
into the manifest and (b) scoped its `closes` map to whichever tickers were
still pending at run time. The first execution was interrupted part-way by
transient `Blockhash not found` RPC errors after finalizing AAPL/AMZN/GOOGL/META;
the resumed run therefore regenerated the file with a new timestamp and a
smaller ticker set, producing a different sha256 — and overwrote the original.
The content behind `70e4467c…` is not recoverable.

This was a defect in the tooling, not in the settlement. It has been fixed:
the manifest is now a pure function of (trading day, ticker set, corroborated
prices) with no timestamp, it always covers every ticker in the day, and the
script now refuses to overwrite an existing manifest whose content differs.

## Why the prices are still trustworthy

The divergence is in the *file bytes*, not the values. Every record's
`manual_source_a_value_1e6` and `manual_source_b_value_1e6` are stored on-chain
and can be read directly, independent of any manifest:

| ticker | attested close | source A (Yahoo daily bar) | source B (CNBC quote) |
| --- | --- | --- | --- |
| AAPL | $313.45 | 313.45 | 313.45 |
| AMZN | $260.28 | 260.28 | 260.28 |
| GOOGL | $342.00 | 342.00 | 342.00 |
| META | $576.14 | 576.14 | 576.14 |
| MSFT | $496.37 | 496.37 | 496.37 |
| NVDA | $209.66 | 209.66 | 209.66 |

Both sources agreed to the cent for all six, and the on-chain guard
(`source_a == source_b && > 0`) enforced that at finalize time.

## Outcome safety

TSLA settled the same day through the normal Pyth path at **$345.75**, while
the same two public sources reported **$345.82** — a 7¢ methodology gap between
Pyth's capture-at-close and the consolidated tape. The nearest strike to any
attested close on this day is **$2.00** away (GOOGL, strike 340 vs close 342.00),
roughly 28× that gap, so **no outcome on any of the 38 markets turns on which
methodology was used.** All 38 settled with outcomes consistent with their close.
