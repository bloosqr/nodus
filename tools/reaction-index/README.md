# Reaction index (offline builder + query prototype)

Turns an Open Reaction Database (ORD) snapshot into a compact, fast known-reactions index.
This is **offline tooling** — it is not shipped in the app and is not run at query time. The
app consumes the built artifact through the `nodus:reactions` native capability (later phase).

## Source
- `open-reaction-database/ord-data` (Hugging Face), pinned revision recorded in `manifest.json`.
- Fetch with `./fetch-ord.sh [dest]` (default `./ord-data`), which downloads the pinned revision
  and verifies the expected total byte count. Do not commit the Parquet files.
- Data licence **CC-BY-SA-4.0** — attribute and share-alike on any derived artifact.
- Cite: Kearnes et al., *J. Am. Chem. Soc.* 2021, 143 (45), 18820–18826, doi:10.1021/jacs.1c09820.

## What it produces
| Artifact | Answers |
|---|---|
| `exact.tsv.zst` | exact precedent: canonical unmapped reaction hash → count + sample ids |
| `templates.tsv.zst` | retro reaction-center SMARTS → `count`, per-extractor `rdchiral`/`fast` counts, sample ids |
| `products.tsv.zst` | product → reactions that make it (reverse map) |
| `reactions.faiss.zst` + `reaction-keys.txt.zst` | DRFP similarity search (binary HNSW, Hamming) |
| `manifest.json` | source revision, licence, counts, sizes, sha256, template provenance tallies |

## Template extraction (hybrid)
Templates come only from atom-mapped sources (ORD `REACTION_CXSMILES`, type 6). Two extractors
are used and every template row records which produced it:
- **RDChiral** for reactions at or below `--template-threshold` atoms (default 150) — the mature,
  whole-molecule extractor, higher round-trip fidelity.
- **The fast centre extractor** (`template_fast.py`) above the threshold — works only on the
  reacting atoms, so its cost is independent of molecule size. Lower fidelity, but never hangs.

A watchdog handles RDChiral's uninterruptible C++ calls: a row group that runs longer than
`--task-timeout` (default 30 min) is requeued once with the fast extractor, so nothing blocks.
`--force-fast <substr>` routes whole datasets that are known to hang (e.g. `e7830cd6`) straight
to the fast extractor and discards their existing checkpoints so the file is rebuilt uniformly.

## Build
```bash
python3 -m venv .venv && source .venv/bin/activate
uv pip install -r requirements.txt        # or: pip install -r requirements.txt
python build_index.py --root ./ord-data --out ./index
```
Useful flags:
- `--force-fast e7830cd6` — fast-extract the pathological datasets (see above).
- `--workers N` — defaults to `cpu_count - 2`, leaving two logical CPUs free.
- `--task-timeout SECONDS` — watchdog threshold before swapping to the fast extractor (default 1800).
- `--no-fp` — skip the DRFP/faiss step (exact + templates + products only).
- `--reuse-fp` — re-merge over the same checkpoints but re-record the existing faiss artifacts
  (exact keys are deterministic, so the similarity index stays valid); avoids the costly DRFP pass.
- `--fresh` — delete checkpoints and rebuild from scratch.
- `--limit N` — first N row groups (smoke test).

Checkpointed: each row group is written to `index/parts/` as it finishes, so a re-run skips
finished work and an interrupted build resumes. The merge refuses any checkpoint missing the
per-template provenance fields, so a stale/mixed `parts/` is caught rather than silently merged.
The merge prints `completeness OK: <n>/<total> checkpoints` (or a hard `WARNING` naming the count
of missing groups) before writing artifacts.

## Watching progress
```bash
python progress.py            # one snapshot: phase, done/total, ETA, checkpoints, log highlights
python progress.py --watch    # refresh every 5s (--watch 10 for a custom interval)
```
Reads `index/progress.json`, counts `index/parts`, detects a live build via `index/build.pid`
(written by the builder), and echoes `build.log` highlights. Safe to run while the build runs.

## Query prototype
```bash
python query.py ./index
```
Loads the artifact and exercises `exact` (O(1) hash lookup), `similar` (faiss Hamming search),
and `make` (product reverse lookup). This mirrors the future `nodus:reactions` API.

## Not here (later phases, app side)
- Download-on-demand + integrity checking of the published artifact (GitHub Release asset).
- The `nodus:reactions` native capability exposing `exact / similar / make / apply`.
- The evidence tool (`known-reactions`) and the hybrid synthesis planner.
