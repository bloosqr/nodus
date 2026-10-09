# Chemistry Studio route check: audit (in progress)

Partial results; this file is replaced by the full report when the audit finishes.

- Baseline plugin tests at `audit/2026-10-09`: 157 pass, 1 skip (needs a local OPSIN jar), 0 fail.
- verify-route on a synthetic 20-step route: 29.5 s with a 300 ms stubbed reference round trip,
  of which about 96% is the 93 serial label look-ups (known item (a)).
- Audit CPU: 93.5% inside validateChemicalReferences (the drawing pipeline), 289 calls for 32 distinct species.
- Verified bug: the stereo-inversion check refuses an SN2 that keeps configuration and passes one that inverts it.
