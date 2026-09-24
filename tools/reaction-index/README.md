# Reaction index (offline builder + query prototype)

Turns an Open Reaction Database (ORD) snapshot into a compact, fast known-reactions index.
This is **offline tooling** — it is not shipped in the app and is not run at query time. The
app consumes the built artifact through the `nodus:reactions` native capability (later phase).

## Source
- `open-reaction-database/ord-data` (Hugging Face), pinned revision recorded in `manifest.json`.
- Data licence **CC-BY-SA-4.0** — attribute and share-alike on any derived artifact.
- Cite: Kearnes et al., *J. Am. Chem. Soc.* 2021, 143 (45), 18820–18826, doi:10.1021/jacs.1c09820.

## What it produces
| Artifact | Answers |
|---|---|
| `exact.tsv.zst` | exact precedent: canonical unmapped reaction hash → count + sample ids |
| `templates.tsv.zst` | retro reaction-center SMARTS → count + sample ids (mapped sources only) |
| `products.tsv.zst` | product → reactions that make it (reverse map) |
| `reactions.faiss.zst` + `reaction-keys.txt.zst` | DRFP similarity search (binary HNSW, Hamming) |
| `manifest.json` | source revision, licence, counts, sizes, sha256 |

## Build
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install ord-schema rdkit rdchiral drfp hnswlib faiss-cpu zstandard numpy
python build_index.py --root /path/to/ord-data --out ./index
```
- Checkpointed: each row group is written to `index/parts/` as it finishes, so a re-run skips
  finished work and an interrupted build resumes. Delete `parts/` to rebuild from scratch.
- Progress prints every few seconds and mirrors to `index/progress.json`.
- `--no-fp` skips the DRFP/faiss step (exact + templates + products only).
- `--limit N` runs the first N row groups (smoke test).

## Query prototype
```bash
python query.py ./index
```
Loads the artifact and exercises `exact` (O(1) hash lookup), `similar` (faiss Hamming search),
and `make` (product reverse lookup). This mirrors the future `nodus:reactions` API.

## Not here (later phases, app side)
- Download-on-demand + integrity checking of the published artifact.
- The `nodus:reactions` native capability exposing `exact / similar / make / apply`.
- The evidence tool (`known-reactions`) and the hybrid synthesis planner.
