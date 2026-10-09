# Audit 2 — capability host (work in progress)

Partial results, pushed early. The full report replaces this file.

Verified so far (patches 01–03, nodus):

- 01: a Python process killed by a signal is reported as exit code 0; stderr is unbounded; UTF-8 split across pipe reads is corrupted; an EPIPE on stdin becomes a main-process uncaught exception.
- 02: cancelling a Python call leaves the processes it started running (no process-group kill).
- 03: nothing bounds how many Python interpreters run at once (12 concurrent calls → 12 processes on 4 cores).

Measured: persistent Python worker vs one process per call — see logs/persistent-vs-oneshot.txt.
