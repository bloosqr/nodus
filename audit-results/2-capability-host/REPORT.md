# Audit 2 — capability host (work in progress)

Partial results, pushed early. The full report replaces this file.

Verified so far (patches 01–03, nodus):

- 01: a Python process killed by a signal is reported as exit code 0; stderr is unbounded; UTF-8 split across pipe reads is corrupted; an EPIPE on stdin becomes a main-process uncaught exception.
- 02: cancelling a Python call leaves the processes it started running (no process-group kill).
- 03: nothing bounds how many Python interpreters run at once (12 concurrent calls → 12 processes on 4 cores).

Measured: persistent Python worker vs one process per call — see logs/persistent-vs-oneshot.txt.

Added (still partial):

- 04 / 04b: persistent Python interpreters (host + plugin). One answer's Python traffic 19.7 s → 10.0 s (logs/04-bench-python-answer.txt).
- 05: validator subworker kept between calls, `subworkers.max` enforced. One route-check round's subworker traffic 8.4–9.3 s → 0.72 s warm (logs/05-bench-subworker-round.txt).

Added (still partial): 06 (worker stop predicates never matched), 07 (per-call cancellation), 08/08b (tool concurrency), 09/09b (worker reuse per conversation scope), 10 (process-lived endpoint refusals). Integrated benchmark: logs/integrated-rounds.txt (51.1 s → 24.8 s).
