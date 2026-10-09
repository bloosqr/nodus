# Audit 3: library database, retrieval queries and vector scans

Area: `nodus` `electron/db/` and `electron/workers/`, plus the callers on the answer path that drive them (`electron/ai/synthesisEvidence.ts`, `electron/ai/documentaryPreparation.ts`, `electron/ai/researchNotebookService.ts`, `electron/export/exportImport.ts`).
Base: `audit/2026-10-09` of github.com/bloosqr/nodus at `a828b6b3`. The marketplace repository cloned fine. Nothing in this area needed it, and nothing was written to it.

This report has seven verified findings, each with a patch and a regression test. Every test fails on the base and passes with its patch. After them come the suspected but unverified items, then how everything was run.

## Summary

| # | Finding | Category | On the answer path? | Measured effect (synthetic 1000 docs / 100k passages / 1024-d) | Patch |
|---|---|---|---|---|---|
| 1 | A vault restore opens through the old vault's write-ahead log while the vector-scan worker is up, so the restore silently does not happen | bug (data integrity) | no (restore) | the restored vault reads back the pre-restore rows | `07-restore-reads-through-stale-wal.patch` |
| 2 | Synthesis gather: the dense passage lane scores the whole library in the main process, 7 queries one after another | speed | yes (evidence gathering) | 10.4 s → 3.3 s per gather; longest main-thread block 1.5 s → 0.25 s | `01-synthesis-dense-lane-off-main-thread.patch` |
| 3 | The vector-scan worker drops its cache on any write to the vault | speed | yes (retrieval) | the next scan after a one-row write takes 5.9 s instead of 0.42 s | `02-vector-scan-cache-per-table-generations.patch` |
| 4 | Passage-index triggers scan the whole FTS index once per deleted or rewritten passage | speed / robustness | indirectly (holds the writer lock) | replacing one work's 100 passages: 5.3 s → 12 ms | `03-passages-fts-trigger-index.patch` |
| 5 | The lexical passage lane reads every match's id into JS, then filters by scope | speed | yes (both stages) | per call: 296 → 100 ms; 330 → 146 ms scoped; 253 → 62 ms | `04-lexical-lane-paged-and-scoped.patch` |
| 6 | Documentary per-source lookups run one statement per source (N+1), plus O(N²) finds and whole-payload reads | speed | yes (retrieval) | preparation inventory 158 → 68 ms; scope resolution 41 → 29 ms; shared retrieval main thread 93 → 60 ms; statements per inventory 507 → 9 (96 sources) | `05-documentary-lookups-batched.patch` |
| 7 | Documentary semantic scan: read-only store not memory-mapped, and every element checked in a separate pass | speed | yes (retrieval) | per call: semantic 825 → 780 ms, lexical 333 → 248 ms | `06-documentary-semantic-scan-mapped.patch` |

**Wall-time effect per answer.** These are estimates, not end-to-end measurements: no LLM or chemistry plugin was run here.
- **Evidence gathering:** about −7 s per answer from #2. The gather runs once per answer and is cached across fix rounds (`synthesisEvidence.ts` evidence cache). A further ~1.3 s of main-thread lexical time comes off with #5 (7 calls × ~0.19 s).
- **Retrieval:**
  - #3 saves ~1.6–4.8 s for each table that has to rebuild after any vault write. Passages measured at 1.65 s per rebuild; up to 4.8 s under page-cache pressure.
  - #5 saves ~0.2 s per lexical call. `retrieveHierarchical` makes two calls per probe per query.
  - #6 and #7 save together ~0.2 s per shared documentary retrieval, plus ~0.1 s per inventory or scope resolution.
- **Whether #3 fires in a real answer:** that depends on whether the vault is written between scans. Citation receipts, chat messages and settings all write to it, so it is likely at least once per turn. I could not count it on a real trace.

Patches #1–#7 are independent. Each applies alone to `audit/2026-10-09`, and all seven apply together in numeric order (`logs/00-isolation.txt`). **Patch 02 should ship with patch 07.** With 02, the worker's cache no longer moves with `PRAGMA data_version`, so it must be dropped when the vault file is swapped underneath it. 07 does that by stopping the worker before a restore.

No `shared/` file listed in GENERATED (`scripts/build-server-shared.mjs`) is touched, so `npm run build:server-shared` does not need rerunning. `shared/routeRules.ts` is untouched.

---

## 1. A restore opens through the old vault's write-ahead log (bug, high)

**Where:**
- `electron/workers/vectorScanWorker.ts:32-44`: `databaseFor` opens a read-only connection per vault and keeps it for the life of the worker.
- `electron/db/database.ts:275`: `replaceDbFile` does `closeDb(); fs.copyFileSync(source, target); openDatabase(target)`.
- Callers: `electron/export/exportImport.ts:602` (`restoreBackupArchiveSafely` → `restoreBackupArchive` → `replaceDbFile` at :854) and `:1220` (`restoreBackupArchiveFile`).

**What goes wrong.** Once any semantic search has run in the session, the vector-scan worker holds an open connection to the vault. During a backup restore, `closeDb()` is then not the last close. SQLite keeps `nodus.sqlite-wal` and `-shm`, and the backup copied over `nodus.sqlite` is opened through the old log. The app reads the pre-restore pages, and the restore reports success.

There is a second-order risk I did not test: a later checkpoint would write old-vault pages into the restored file.

**How verified:**
- With plain better-sqlite3 (`logs/07-wal-probe-output.txt`): with the extra read-only connection open, the reopened vault shows the old 210 rows instead of the 50 imported ones. Without that connection, the control run shows the 50 imported rows and leaves no WAL behind.
- With the real worker (`scripts/test-vector-scan-restore.mjs`): on the base, `AssertionError: the restored vault is the backup` lists `old-0 … old-209`. With the patch it passes, and a later scan starts a fresh worker on the restored file.

**Patch** (`07-restore-reads-through-stale-wal.patch`):
- `vectorScanHost.ts` gets `stopVectorScanWorker()`. It terminates the worker, which closes its connections, and rejects pending scans (their callers fall back to the in-process scan).
- A deliberate stop no longer marks the worker permanently unavailable: a `retired` set, and the exit handler only clears its own instance.
- Both restore paths `await stopVectorScanWorker()` before the vault file is replaced, including the rollback path.

**Test:** `scripts/test-vector-scan-restore.mjs` fails before (above) and passes after (`logs/07-restore-through-stale-wal-test.txt`).

## 2. Synthesis gather: dense lane on the main thread, queries in series (speed, largest saving)

**Where:** `electron/ai/synthesisEvidence.ts:313-315` (`textbookPassages`).

**What goes wrong.** For each of up to 7 queries (`synthesisEvidenceQueries` caps at 7), it awaits `embed()` and then calls the synchronous `findSimilarPassages`. That is a `vec_cosine` callback over every embedded passage of the scoped works, bound-parameter query vector included, inside the main process. The worker-backed `findSimilarPassagesPaged`, with its cached vectors, already exists and returns the same rows.

**How verified:**
- Profiled and benchmarked on the fixture (`logs/01-synthesis-passages-bench.txt`): 1.18 s per `findSimilarPassages` call against 0.37 s for the paged worker scan.
- The whole 7-query lane:
  - with a 250 ms embedding round trip: **10.1–10.6 s before, 3.3–3.4 s after**;
  - with instant embeddings: 8.2–8.5 s before, 3.2–3.3 s after.
- Longest main-thread block (`monitorEventLoopDelay`): **1.5–1.7 s before, 0.24–0.27 s after**. The remainder is the lexical lane, which #5 addresses.
- The same 8 passages are returned. The test also checks that the paged and synchronous scans rank identically.

**Patch** (`01-…`):
- Request all query embeddings up front. Each failure stays limited to that query's dense lane, as before.
- Use `await findSimilarPassagesPaged(...)` for the dense lane.
- `scripts/test-synthesis-evidence-without-ord.mjs` gets the new export in its `passagesRepo` stub. Without it, that suite's bundle fails to build.
- Trade-off: when the 8-passage cap is reached early, later queries' embeddings have already been requested. That is at most 6 extra embedding calls per gather.

**Test:** `scripts/test-synthesis-evidence-passages.mjs`.
- Before: `AssertionError: the dense lane never scores the library in the main process`.
- After: it passes, and also checks concurrency, the passages found, and paged-vs-synchronous ranking (`logs/01-synthesis-passages-test.txt`).

## 3. Vector-scan cache invalidated by any write (speed)

**Where:** `electron/workers/vectorScanWorker.ts:72` (cache keyed on `PRAGMA data_version`) and `:162` (the filtered rows live inside that cache).

**What goes wrong.** `data_version` changes on any commit by another connection. One `settings` row, a citation receipt (`research_scope_receipts`) or a chat message throws away the passages cache (100k × 1024 floats) and every cached filter result. The next scan rebuilds both.

**How verified** (`logs/02-vector-scan-generations-bench.txt`, 100k passages): warm scan 0.39–0.47 s. After one unrelated write:
- **before:** 2.05 s in the first run and 5.86 s in the logged run (cache rebuilt, 1.0–4.8 s);
- **after:** 0.42 s, with no rebuild.

**Patch** (`02-…`):
- New `electron/db/vectorScanGenerations.ts`: a `vector_scan_generations` table with insert/update/delete triggers on every table a scan reads. They are installed in `openDatabase`, like `ensureBackupRevisionTriggers`.
- The worker keys the vectors on the scanned table's counter. Each statement's filtered rows are keyed on the counters of every table its SQL reads (`FROM`/`JOIN` names).
- If any of those names has no counter, or the table is missing, it falls back to `data_version`. So a missed table costs speed, never freshness.
- The table is listed as not synced in `syncTables.ts`. `test-sync-package` passes.

**Test:** two new cases in `scripts/test-vector-scan-worker.mjs`, both comparing results against the per-row callback.
- An unrelated write must not rebuild.
- Archiving through a joined table must change the answer at once without rebuilding the vectors, and a vector-table write must rebuild.
- Base worker: cases 5 and 6 fail (`expected 3 / actual 4`, `expected 4 / actual 5`). Patched: 6/6 pass (`logs/02-vector-scan-generations-test.txt`).

## 4. Passage-index triggers scan the whole FTS index per row (speed / robustness)

**Where:** `electron/db/migrations.ts:8866,8870`: `DELETE FROM passages_fts WHERE passage_id=old.passage_id` in `passages_document_fts_au` and `_ad`. `passage_id` is `UNINDEXED`, so the plan is `SCAN passages_fts VIRTUAL TABLE INDEX 0:`.

**What goes wrong.** Every deleted or text-rewritten passage reads the full FTS index. `replaceWorkPassages` (re-indexing one work) and work deletion each take seconds inside a write transaction. During that time any other writer to the vault waits; `busy_timeout` is 5000 ms, so a writer can fail with `SQLITE_BUSY`. I did not test that failure mode.

**How verified** (`logs/03-passages-fts-trigger-bench.txt`, copies of the 100k fixture):
- Replacing one work's 100 passages: **5.3 s before, 10–12 ms after**.
- Rewriting one passage's text: 66 ms before, 0 ms after.
- FTS `integrity-check` passes after.
- The migration itself takes 0.92 s on 100k passages.

**Patch** (`03-…`): migration 201 (`SCHEMA_VERSION` 200 → 201).
- Index `passages_fts_content(c0)` (FTS5's content table; `c0` is `passage_id`).
- Recreate both triggers to delete `WHERE rowid IN (SELECT id FROM passages_fts_content WHERE c0=old.passage_id)`.
- Why not couple FTS rowids to `passages.rowid`: `passages` has no INTEGER PRIMARY KEY and the app runs `VACUUM INTO` for backups.
- A schema bump makes older peers refuse snapshots from this build (`replicaService.ts:494`). That is the usual cost of any migration.

**Test:** `scripts/test-passages-fts-triggers.mjs` checks the trigger's plan uses the index, and that the index stays in step through insert, rewrite and delete with integrity-check passing.
- Before: `…finds the row by index, not by scanning every row (SCAN passages_fts VIRTUAL TABLE INDEX 0:)`.
- After: passes.

## 5. Lexical lane reads the whole BM25 ranking (speed)

**Where:** `electron/db/passagesRepo.ts:69` (`lexicalPassageSearch`). Callers: `textbookPassages` (7 per gather) and `retrieveHierarchical` (literal probes, globally and again inside the routed works).

**What goes wrong.** Every match's `passage_id` comes back to JS, up to 100k for a common word. The scope (for example 12 routed works) is applied in JS afterwards, so a scoped call walks the corpus-wide ranking in 64-row joins.

**How verified** (`logs/04-lexical-lane-bench.txt`): **296 → 100 ms** unscoped, **330 → 146 ms** scoped to 12 works, **253 → 62 ms** for a rarer term. The hits are identical (same ids in the same order).

**Patch** (`04-…`): read the ranking `LIMIT pageSize OFFSET n`, with the scope pushed into the FTS query (`AND nodus_id IN (SELECT value FROM json_each(?))`). It fetches the next page only if the first does not fill the pool. bm25 uses whole-index statistics whatever the WHERE, so the order is unchanged. The index's `nodus_id` is kept equal to the passage's by its triggers.

**Test:** `scripts/test-lexical-passage-search.mjs` compares the candidate pool with the old whole-ranking implementation across scopes, archived and stale works, and limits, and bounds the rows any statement returns.
- Before: `no statement returned more than a page of the ranking (largest 1800)`.
- After: passes.

## 6. Documentary per-source lookups: N+1, O(N²), whole-payload reads (speed)

**Where** (`electron/ai/documentaryPreparation.ts`):
- `revisionsFor` :316 and `chunkCount` :323, one prepare and run per source and per revision;
- the `documentary_requests` lookup per source :374;
- `store.preference('paused')` per source :394;
- `pinPublishedResearchDocument` :347, called per source from `researchNotebookService.ts:63,88`;
- `jobIdentity` per published key in `attachmentRevisions`;
- after the worker replies: `latest.find` per scope document :893 (O(N²));
- `getJob(passage.index_key)` per passage :896, which reads `payload_json` (it can hold a whole extracted text) only to get the identity.

This is the "per-document revision queries, issued one at a time" and "statement preparation" cost in the brief.

**How verified:**
- Statement counter in `scripts/test-documentary-inventory-batched.mjs`: **129 statements for 24 sources and 507 for 96** before; **9 for either** after.
- Fixture bench (`logs/05-documentary-batched-bench.txt`), outputs hash-identical before and after:
  - `getResearchPreparationInventory` **158 → 68 ms**;
  - scope resolution 41 → 29 ms;
  - shared retrieval main-thread time 93 → 60 ms.
- The existing documentary and research suites all pass (`logs/05-related-suites.txt`).

**Patch** (`05-…`):
- `DocumentaryStore` gains `revisionsOf`, `chunkCounts`, `jobIdentities` and `publishedDocuments`. Each is one statement over `json_each`, in the same per-source order.
- `documentaryPreparation.ts` adds `documentaryLookups`, `latestRequests` and `pinPublishedResearchDocuments`, and passes them through `revisionsFor` and `attachmentRevisions`.
- `paused` is read once, and the scope and passage lookups are indexed.
- The single-document `pinPublishedResearchDocument` stays as a wrapper.

**Test:** `scripts/test-documentary-inventory-batched.mjs` checks that the statement count is constant in the library size and that each source's state (published with passages, queued with no partial revision, catalogued) is unchanged.
- Before: `the statements do not grow with the library (129 for 24 sources, 507 for 96)`.
- After: passes.

## 7. Documentary semantic scan (speed, small)

**Where:**
- `electron/db/documentaryStore.ts:36`: the read-only store sets no `mmap_size` or `cache_size`.
- `:288`: an extra `Number.isFinite` pass over every element before the products.

**How verified** (`logs/06-documentary-semantic-bench.txt`, 100k passages in scope, the store opened as the retrieval worker opens it): semanticSearch **825 → 780 ms**, lexicalSearch **333 → 248 ms**.

**Patch** (`06-…`):
- Map the read-only store (1 GiB) and set a 32 MB cache.
- For Float32 blobs, replace the pre-pass with one `Number.isFinite(sumOfSquares)` test after the loop. This is exact: a float32's square cannot overflow a double, so a non-finite sum means a non-finite element. Legacy JSON vectors keep the pre-pass.

**Test:** `scripts/test-documentary-semantic-scan.mjs` checks for an identical ranking against the old algorithm, with NaN, ±Infinity and legacy JSON rows.
- Before: `the read-only store is memory-mapped`.
- After: passes.

The large saving here is structural and not patched; see S1.

---

## Suspected, not verified

- **S1. Documentary retrieval spawns a new process and rescans every vector on every call.** `documentaryPreparation.ts:855`; the worker uses `parentPort.once`.
  - Each call measured 1.4 s wall on the fixture: semantic 0.78–0.88 s and lexical 0.25–0.33 s, plus process start.
  - A long-lived retrieval process holding the vectors (like `vectorScanWorker`, keyed on a `documentary_passages` write counter rather than `data_version`, because preparation heartbeats write constantly) should bring the semantic part to ~0.05–0.1 s. Estimated saving: **~0.8–1 s per shared retrieval call**, of which a research turn makes 3 or more.
  - Not built or measured.
- **S2. The research inventory is rebuilt on every call.**
  - `researchCorpusRun.retrieve` calls `validate()` (which builds a full inventory) twice plus `researchCorpusInventory()` twice, and `retrieveSharedDocumentaryEvidence` builds two more.
  - With the Global Library configured, each build reads one JSON file per item (`researchCorpusInventory.ts:32`, `getGlobalLibraryItem`).
  - 12 ms per build on my fixture, which has no Global Library; it is not measured with one.
  - A cache keyed on vault `data_version` + `total_changes()` would not be enough: the library lives in files and a separate catalog, so the key would also need the catalog's revision.
- **S3. Remaining O(N²) lookups.**
  - `researchCorpusRun.ts:166` (`current.find` per scope document when `pinRevisions`);
  - `scopedLegacyCitations.ts:28,35` (`current.find` per recorded passage).
  - Traced only. Negligible at 1,000 sources; about 10⁸ comparisons at 14k.
- **S4.** The documentary store's writable connection is WAL with the default `synchronous=FULL` (`documentaryStore.ts:37`), so every lease renewal and progress update fsyncs. Not measured; not on the answer path.
- **S5.** `documentaryStore.lexicalSearch` (:273) joins and sorts every FTS match before `LIMIT`, the same pattern as #5. About 250–330 ms per call at 100k matches. Not patched.
- **S6.** Synchronous main-thread `findSimilarPassages` is still used by `semanticSearch.ts:90`, `studyGuide.ts:101,353`, `chapterIdeas.ts:203` and `liveRelations.ts`. Same cost as #2, about 1.2 s per call at 100k. Not on the route-answer path; not changed.
- **S7. Column order makes the scan filters read overflow pages.**
  - `passages.page_number` and `source_ref` were added after the 4 KB `embedding` blob, and `embedding_provider`, `embedding_model` and `embedding_dim` also follow it. A filter reading those columns, or `MAX(page_number)` in `scannedWorkLookup`, walks each row's overflow chain.
  - This is the "~10 µs a row" filter cost noted in `vectorScanWorker.ts`. Patch #3 makes it rarer, but each rebuild still pays it.
  - A covering index or a column move is untested.
- **S8.** `adjacentPassages` (`documentaryStore.ts:305`) uses `ABS(p.ordinal-origin.ordinal)<=?`, which cannot use the `(index_key, ordinal)` range. It reads all passages of the revision; 12 ms for 20 expansions on the fixture. Minor.

## How it was run

**Install.**
- `npm ci` failed: the proxy refuses `cdn.sheetjs.com`, where the lockfile pins `xlsx-0.20.3.tgz`.
- I installed with `xlsx` removed from `package.json`, restored `package.json` and `package-lock.json` afterwards, and unpacked `xlsx@0.18.5` from the npm registry into `node_modules` only, so that modules importing it can load. Nothing from this is committed.

**Electron.**
- Rebuilding better-sqlite3 for Electron failed: `www.electronjs.org` headers are refused by the proxy.
- All Electron-gated suites therefore ran under **Node 22.22** with a Node-built better-sqlite3, by passing each suite's own re-exec flag (for example `node scripts/test-vector-scan-worker.mjs --electron-vector-scan-worker-test`). Nothing ran under Electron itself.

**Typecheck.** `npm run typecheck` (renderer and electron) exits 0 with all seven patches applied to a clean `audit/2026-10-09` worktree. `tsc -p electron/tsconfig.json` is clean with each patch alone (`logs/00-isolation.txt`).

**Suites on the combined tree** (`logs/08-combined-suites.txt`):
- 22 existing related suites pass, plus the 7 new ones.
- Four fail identically on the unpatched base because they need built `dist-electron` workers or the backup utility process: `auto-backup`, `backup-vaults`, `primary-sources-migration-repositories` and `documentary-writers`.
- `documentary-compaction` skips itself for the same reason.

**Fixture.**
- Synthetic, built through the app's own migrations and repositories:
  - vault: 1,000 works and 100,000 passages, each with a 1,024-d float32 embedding, FTS and triggers;
  - documentary store: 1,000 published sources with 100,000 passages and vectors, one request row each.
- Text is drawn from a 30-word vocabulary, so common-word searches match nearly every passage. That is a worst case for the lexical numbers.
- Benchmarks used `dist-electron` worker bundles built with esbuild. "Before" runs swap the base files back in.
- 4 cores, 15 GB RAM. Medians of 3–5 runs unless noted.
- No PubChem, OPSIN, ORD or other external data was used, and no network calls were made by tests (they stub `fetch`).
