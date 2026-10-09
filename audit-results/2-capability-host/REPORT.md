# Audit 2: the capability host

**Area:** `electron/capabilities/` (runner, workerHost, workerBootstrap, pythonRuntime, hostServices), `packages/capability-api`, and the IPC paths that carry capability calls. On the plugin side: the parts of `plugins/chemistry-studio` that the host runs (the worker's Python and subworker calls, and its manifest).

**Code audited:** `bloosqr/nodus@audit/2026-10-09` (a828b6b3) and `bloosqr/nodus-research-skill-marketplace@audit/2026-10-09` (fe3b2d6).

## Summary

The host's own overhead on one answer's chemistry checks can be cut by about half, measured end to end. The test drives the real Chemistry Studio worker, validator subworker and `reactions_worker.py` through the real runner, workerHost, bootstrap, host services and Python runtime. It models one conversation as an evidence gather plus three route-check rounds:

| Run | base | patched |
|---|---|---|
| 1 | 52.2 s | 23.9 s |
| 2 | 49.6 s | 24.6 s |
| Reference requests | 108 | 68 |

- The route audits produced are byte-identical (logs/integrated-final.txt).
- Network calls are a local stub that answers from a synthetic table. Nothing was sent to PubChem or OPSIN.

Most of the gain comes from three causes:

1. **Validator subworker reloaded on every call.** Each call forks a fresh process that reloads RDKit and OpenChemLib as WebAssembly: about 1.05 s per call, against about 35–50 ms once warm. This was not among the known items.
2. **Fresh Python interpreter on every call.** Each call re-imports RDKit and re-reads index tables: 0.2–1.8 s per call.
3. **Worker per runner (known item e).** Module caches die between answer phases, so every correction round re-resolves every name.

Two correctness bugs sit on the same path:

- **One timeout kills the whole worker.** A single call's timeout or cancellation cancels every call that worker is carrying, then kills it two seconds later even if it complied. The route report runs about six tools side by side on one worker.
- **Old workers are never stopped.** Uninstall, update, rollback, approve and discard never stop a plugin's workers, because their predicates never match the worker keys.

**How much of the 50% goal this covers.** In the owner's measurement a verify-route call takes about 37 s. Of that, my area accounts for about 1.5–2 s:

- validator cold start: 1.05 s;
- Python start-up for stereo enumeration: about 0.4 s;
- the audit itself: under 0.82 s even for 10 labelled steps (logs/subworker-and-worker-cost.txt).

The other ~35 s is label resolution over the network and the PubChem pacer (known items a and b). So these patches remove roughly 25–30 s of host overhead per answer, about 8% of an answer's wall time. That estimate assumes three verify-route calls per answer at 32% of the time, which puts an answer near 350 s; that figure is my inference, not a measurement. The LLM's share moves from about 15% to about 16–17%. Reaching more than 50% needs items a, b and retrieval; this area cannot do it alone.

## How the patches are organised

- **Two series.** Each `NN-*.patch` is a unified diff whose first line names the repository and the patches it must follow.
  - nodus: `01`–`14`, in numeric order.
  - marketplace: `04b`, `08b`, `09b`, `12b`, in that order.
- **Checked on clean trees.** I applied both series to clean `audit/2026-10-09` checkouts with `git apply`.
- **Numbering is application order, not severity.** The findings below are ranked separately.
- **No GENERATED files touched.** No file under `shared/` (or anything in `scripts/build-server-shared.mjs`'s `GENERATED` list) is touched, so `npm run build:server-shared` is not needed.
- **API additions are backward compatible.** `packages/capability-api` gains an optional `parentCallId` on host calls and an optional `persistent` flag on `python.run`.
  - Both ends of the host-call protocol are the host's own code.
  - The flag is ignored by a host that predates it.
  - Verified in both directions. Old host with the new plugin: 51.1 s, identical audit. New host with the old plugin: 41.6 s, identical audit (logs/integrated-compat.txt).
- **Marketplace patches need a release.** They change `capability.json` and the bundled worker, so they need a version bump to reach users. None of them changes permissions, so none triggers a permission re-approval.

## Findings, most severe first

Each finding gives the location on the base branch, the category, what goes wrong, how I verified it, the saving where it is a speed finding, and the patch and its regression test with the before/after result. Before/after logs are in `logs/NN-before.txt` and `logs/NN-after.txt`.

### 1. A validator subworker is forked, loaded and killed for every request (speed; new)

- **Where:** `electron/capabilities/runner.ts:138`. The `subworker` adapter calls `utilityProcess.fork` per request and kills the process after its one answer. The limit read at `:136` (`subworkers.max`) is only tested for `< 1`, never enforced; that is known item f.
- **What goes wrong:** Every structure check, resolve-pass canonicalisation, structure naming, route audit and step drawing starts a process that loads RDKit and OpenChemLib as WebAssembly before parsing anything.
  - Per call, for example `{batch: ['CCO', …]}`: fork-per-call 1.09–1.14 s, against 44–53 ms in a reused process (logs/subworker-and-worker-cost.txt).
  - Per route-check round: the resolve pass, structure naming, structure check, route audit and six step drawings send 10 subworker requests.
- **Verified:** benchmark through the host's own `createCapabilityAdapters().subworker` with the real validator. One round's subworker traffic goes from 8.42 s, 8.78 s, 9.34 s to 1.90 s, 0.72 s, 0.72 s; the first patched round pays one cold load (logs/05-bench-subworker-round.txt).
- **Saving:** about 7.7 s of wall time per route-check round, mostly on its sequential critical path. The resolve pass, naming, structure check and audit are awaited one after another (`moleculeInspection.ts:600-700`, `:994`). That is about 23 s per answer with three rounds; the basis is the measured round time multiplied by the round count.
- **Patch `05-subworker-pool-and-max`:** a new `electron/capabilities/subworkerPool.ts`.
  - A process that answered (a refusal counts as an answer) is kept for the next request to the same entry.
  - A process that timed out, was cancelled, exited or failed to post is killed and never reused.
  - Kept processes are retired after 120 s idle or 100 uses.
  - `subworkers.max` is enforced across turns with an abortable semaphore. The budget starts when the slot is granted, and queue time is logged beside it.
  - Memory: a warm validator holds about 134 MB (logs/kept-process-memory.txt).
- **Test:** `scripts/test-capability-subworker-pool.mjs`, real child processes through the runner's adapter.
  - Before: 3 of 4 fail (reuse, max enforced, queued cancel).
  - After: 4 of 4 pass.
  - The fourth test, "never reused after a failure", passes in both and guards the change.

### 2. One call's deadline or cancellation fails every call on that worker, and the worker is killed even when it complies (bug; new)

- **Where:**
  - `workerHost.ts:143-148`: the per-call `onAbort` and the timeout both call `this.cancel()`.
  - `cancel()` at `workerHost.ts:158-165` posts a process-wide `cancel` and arms an unconditional kill after 2 s.
  - `workerBootstrap.ts:128-136` aborts the single process-wide controller and rejects every pending host call.
- **What goes wrong:** `appendRouteReportAndDrawings` deliberately runs the ORD precedent, step support, textbook precedent, compatibility, stock and two drawings side by side on one runner. Its comment at `moleculeInspection.ts:1011-1012` says "Concurrent invokes are safe on one worker". If any one of them hits its budget (for example `check-compatibility` at 120 s) or is cancelled, every other call on that worker fails. Two seconds later the process is killed whatever it did.
- **Verified:** `scripts/test-capability-worker-calls.mjs`, using the real bootstrap and a test capability in a real child process.
  - Test 1: call A with a 1 s budget and call B, which needs 3.5 s. Before the patch, B is rejected; after, B completes in the same process.
  - Test 2: aborting one caller's signal. Before, it kills the other caller's call.
- **Patch `07-per-call-cancellation-and-services`:**
  - The bootstrap tracks the current call with `AsyncLocalStorage`. `host.signal` is that call's, and host calls carry `parentCallId`.
  - `cancel {invocationId}` (a field the protocol already had) aborts that call alone.
  - The host aborts that call's in-flight host services and refuses its later host calls. It kills the process only if the call is still running when the grace period ends.
  - A host call is answered with the services of the call that made it. This is what makes worker reuse safe (finding 4).
  - A startup aborted by one caller no longer kills a worker other callers are waiting on.
- **Test result:** before, 0 of 3 pass; after, 3 of 3. The existing `test-capability-worker-cancellation.mjs` passes 3/3 after the patch, and `test-capability-api-v2`, `bootstrap-publication` and `migration` are unchanged.

### 3. Every Python call starts a fresh interpreter and reloads RDKit and the index tables (speed; requested prototype)

- **Where:**
  - `pythonRuntime.ts:205-241`: one `spawn` per call.
  - `reactions_worker.py:1703`: reads one request and exits.
  - All seven `host().python.run` call sites in `src/worker.ts`.
- **Start-up cost** (logs/python-startup-cost.txt; 4 cores, Python 3.13, RDKit 2026.03.6):
  - bare interpreter: 26 ms;
  - `import rdkit.Chem`: 333 ms;
  - `--check`: 414 ms.
- **Per request, one-shot against a served process** (logs/persistent-vs-oneshot.txt; synthetic index of 1.9 M reactions and 82,940 templates; identical output):

  | Request | One-shot | Served | Saved |
  |---|---|---|---|
  | known-reactions (6 steps) | 2.10 s | 0.33 s | −1.77 s |
  | propose-disconnections | 0.71 s | 0.03 s | −0.68 s |
  | stereo enumeration | 0.53 s | 0.15 s | −0.38 s |
  | compatibility check | 0.22 s | 0.01 s | −0.22 s |

- **One answer's Python traffic through the host:** an evidence gather plus three rounds goes from 19.7 s to 10.0 s (logs/04-bench-python-answer.txt).
- **Saving on the critical path:**
  - about 0.35 s per verify-route (stereo enumeration runs before the audit);
  - about 0.5–0.7 s per disconnection level in the evidence gather;
  - about 1.8 s per precedent lookup. That branch runs beside the route review, so it saves wall time only when it is the last thing outstanding.
  - In the integrated benchmark, the plugin half accounts for about 9 s of the 26.7 s.
- **Patch `04` (host):** `python.run({ …, persistent: true })` starts the script with `NODUS_PYTHON_SERVE=1` and keeps it.
  - Protocol: one `{"id","stdin"}` line in, one `{"id","code","stdout","stderr"}` line out. The caller gets exactly what a one-shot run returns.
  - Reuse is only after a clean answer. A timeout, a cancellation, a malformed or out-of-turn reply, or an exit kills the interpreter.
  - Each served interpreter is retired after 120 s idle or 200 uses. At most 2 idle are kept per script, and running ones count against the machine-wide limit (finding 10).
  - A call that carries a secret is never served.
- **Patch `04b` (plugin):** `reactions_worker.py` gets a `serve()` loop.
  - Replies go out on a private duplicate of stdout. File descriptor 1 is pointed at stderr, so stray output (including C-level) never corrupts a reply.
  - Per-directory caches are dropped when the directory's file names, sizes or modification times change. A re-imported stock list or a rebuilt index is never answered stale.
  - The lazy index store is kept per process.
  - Every `python.run` in `worker.ts` passes `persistent: true`.
- **Tests:**
  - `scripts/test-capability-python-host.mjs` test 8 (reuse; timeout, cancel and exit; parallel calls get separate interpreters) and test 9 (secrets are never served). Before: test 8 fails. After: both pass.
  - Plugin tests "every Python call asks the host for a persistent interpreter" and "serves requests in a loop, and forgets a stock list that changed". Before: both fail; the loop test needed a 60 s bound because a one-shot script waits for end of input. After: both pass.
  - Developing this loop surfaced a stale-cache bug in my own first draft, which this test now covers.
- **Memory trade-off:** a served interpreter holds 102 MB after stereo enumeration and 563 MB after a precedent lookup on the 1.9 M-key synthetic index, because the key list is loaded (logs/kept-process-memory.txt). The same peak was paid transiently per call before. Now up to two such processes stay for 120 s.
  - Recommended follow-up for the plugin, not done here: map neighbour indices to keys through a seekable file instead of a list of 1.9 M strings.

### 4. Worker per runner: the worker, its caches and its pacer die between an answer's phases (speed and correctness; known item e — designed and patched)

- **Where:**
  - `runner.ts:196` sets `scopeKey = randomUUID()` per runner.
  - `runner.ts:212` stops the worker on dispose.
  - Every phase opens its own runner: `synthesisEvidence.ts:457`, `researchAssistant.ts:283`, `routeEvidencePass.ts:51`, and `inspectResearchMolecules` with no runner.
- **New detail beyond item e:** two plugin caches written to save correction rounds never survive to one.
  - `namedStructures` (`worker.ts:602`) was written to save "21 s again on its correction (measured 2026-10-09)", according to the plugin's own comment.
  - `referenceCache` (`worker.ts:66`) is the other.
  - Each turn's audit runner is disposed, so both are dead code in practice.
- **Hazard once reuse exists:** `resolveRouteLabels` caches failed lookups (`cache.set(name, [])` at `worker.ts:703`). With a reused worker, a name that met a refusal or outage would stay "unresolvable" for the rest of the conversation.
- **Patch `09` (host):** `leaseCapabilityScope(scope)` in workerHost.
  - Runners that name the same scope share one worker per plugin, capability and digest. A runner without a scope behaves exactly as before.
  - The scope is the conversation: `research:<vault>:<conversationId>`, plumbed through `InspectOptions`, `EvidenceOptions` and `RouteEvidenceOptions`.
  - Lifetime: leases are reference-counted. After the last release the worker lives 10 minutes, so it spans the model's turn and the correction. A scope older than 60 minutes starts afresh at its next lease, and at most 4 idle scopes are kept.
  - Per-call services and cancellation (finding 2) make sharing safe.
- **Patch `09b` (plugin):**
  - Only successful lookups are kept, bounded at 4096 entries, oldest first out.
  - A failed lookup is asked again by the next call.
  - `resolve-names` reuses names this worker already resolved, copied, never shared by reference.
- **Verified:**
  - `scripts/test-capability-worker-scope.mjs` (real runner, workerHost and bootstrap): before, a second runner of the same scope gets a fresh worker with empty module state; after, it shares the worker.
  - Plugin tests "a name that found nothing is asked again…" and "resolve-names answers a name this worker already resolved…": both fail before, pass after.
- **Saving:**
  - Integrated benchmark: 108 → 68 reference requests, and about 7.8 s of the total. Compare "new host + plugin without 09b" at 32.6 s with the full patch at 24.8 s (logs/integrated-compat.txt).
  - That 7.8 s is with references answered instantly. Each avoided PubChem request also saves the pacer's 200 ms floor (1 s under Yellow) plus real network latency. Per the plugin authors' own measurement, it saves 21 s per correction round of structure naming on a long route.
- **Process-lived pacing (also part of item e):** see finding 11.

### 5. Removing, updating, rolling back, approving or discarding a plugin never stops its workers (bug; new)

- **Where:**
  - The worker key at `workerHost.ts:284` is built from the capability id: `nodus:chemistry@2.5.28+<digest>`.
  - Every caller that retires a package's workers matches keys containing the plugin id (`chemistry-studio`): `ipc/capabilities.ts:242, 251, 260, 279` and `updates.ts:90`. That never matches.
- **What goes wrong:**
  - After an update, the old version's detached (settings/health/render) worker and any turn workers keep running the old bytes indefinitely, despite the comment "The old process is running the old bytes; it goes before the new version is used."
  - After removal with `purgeData`, a still-running worker can recreate the plugin's data directory through its storage host calls.
- **Verified:**
  - `scripts/test-capability-worker-lifecycle.mjs` test 1 calls exactly what the IPC paths call. Before, both workers stay alive; after, both stop, and a plugin whose id merely contains this one's is left alone.
  - The existing `test-capability-updates.mjs` only asserted that some stop was called (`__stopped.length`), which is how the no-op went unnoticed. It now asserts the plugin id: fails on base, passes after (logs/06-updates-after.txt).
- **Patch `06-stop-workers-by-plugin-id`:**
  - The key starts with `<pluginId>/`.
  - `stopPluginWorkers(pluginId)` matches that prefix exactly and also stops the plugin's kept subworkers.
  - All five call sites use it.

### 6. A Python process killed by a signal reports exit code 0; stderr is unbounded; split UTF-8 is corrupted; EPIPE escapes as an uncaught exception (bug; new)

- **Where:**
  - `pythonRuntime.ts:234`: `code ?? 0`.
  - `:232`: `stderr += chunk.slice(0, 64_000)` caps each chunk, never the total.
  - `:231`: `stdout += chunk` decodes chunk by chunk.
  - `:236-238`: no `'error'` listener on `stdin`.
- **What goes wrong:**
  - **Signal kills look like success.** An interpreter killed by the OOM killer or a user's `kill` reports success with truncated stdout. The plugin then either parses a partial object or swallows a `JSON.parse` error into an empty result (finding 7). The one-shot precedent lookup used to peak at 3 GB per process (`reactions_worker.py:121-123`), and there was no limit on concurrent interpreters (finding 10), so an OOM kill is realistic.
  - **stderr is unbounded:** 20 MB written to stderr was kept as 19.6 MB in the main process.
  - **UTF-8 corruption:** a 3-byte character straddling a 64 KB read turns into replacement characters. The chemistry worker prints ASCII-only JSON, so it is not affected; any non-ASCII output from another plugin is.
  - **EPIPE:** an interpreter that exits before reading a large stdin raises EPIPE as an uncaught main-process exception. `processSafety.ts` logs it as a fault.
- **Verified:** `logs/01-before.txt`. The probes were confirmed first (signal → code 0; stderr 19,637,504 characters kept; 32 replacement characters; uncaught EPIPE).
- **Patch `01`:**
  - `close` maps a signal to 128+n and notes it in stderr.
  - stderr keeps the last 64 KB, where the traceback is.
  - Both streams decode with `setEncoding('utf8')`.
  - EPIPE on stdin is ignored, since the exit status says why.
- **Test:** `scripts/test-capability-python-host.mjs` tests 1–4. Before, 4 of 4 fail; after, all pass.

### 7. Silent failure paths: worker logs are dropped, and Python's stderr is thrown away (robustness; new)

- **Where:**
  - `workerHost.ts:233` forwards `log` frames to `options.onLog`, and no caller passes one (`runner.ts:200`, `ipc/capabilities.ts:46`, `dataMigrations.ts:48`).
  - Workers and subworkers run with `stdio: 'ignore'` (`workerHost.ts:188`, `runner.ts:138`), so a plugin has no channel for diagnostics at all.
  - In the plugin, `localReferencesFor` and `productStereoChoices` return `{}` on any failure, discarding stderr (`worker.ts:544, 727`). The five Python-backed tools throw "The reaction lookup failed." and similar, with the traceback discarded (`worker.ts:785` and the like).
- **What goes wrong:** a broken runtime, a missing index file or a killed interpreter silently disables the local PubChem mirror and local OPSIN (the speed fix for item a) and stereo enumeration. Nothing in any log says why.
  - On the app side, `lookupReactionPrecedent` and `lookupTextbookPrecedent` turn any error into `null` (`moleculeInspection.ts:311, 336`). The route report's `.catch(() => '')` branches (`:1015-1056`) do the same.
  - The runner's own `[capability] … failed` line is the only trace, and it carries only the plugin's generic message.
- **Verified:**
  - Worker-lifecycle test 2: a `log` frame reaches the main log. Fails before, passes after.
  - Plugin test "a failed Python call says why, and a silent fallback is logged": fails before, passes after.
- **Patch `12` (host):** `log` frames go to `console[level]` with the capability id when no `onLog` is given.
- **Patch `12b` (plugin):** the error carries the exit code and the interpreter's last stderr line, for example `The reaction lookup failed (exit 1: SystemExit: the reaction index is missing exact.tsv.zst).` The two fallbacks `host().log('warn', …)` why they fell back.

### 8. A capability result that cannot be cloned crashes the worker process and every call on it (robustness; new)

- **Where:** `workerBootstrap.ts:157`. `post()` runs inside a `.then` with no handler, so a `DataCloneError` becomes an unhandled rejection.
- **Verified:** worker-calls test 5. A tool returning `{ draw: () => … }` failed with `nodus:probe exited (code 1)`, and its neighbour call was lost with the process. This was verified in a Node child. Electron's utility process uses Node's default unhandled-rejection mode, but I have not run it under Electron.
- **Patch `13`:** the failed post becomes that call's error result.
- **Test result:** before, the test fails; after, 5 of 5 pass.

### 9. `ensureRuntime` starts three interpreters before every Python tool call (speed; new, small)

- **Where:** `pythonRuntime.ts:125-137` and `:155`. `findSystemPython` runs `python3` twice (version, then path), and the marker check runs `venv/bin/python --version`. The plugin calls `ensureRuntime` before each of its Python calls.
- **Measured:** 59 ms per call on a built environment; four at once take 70 ms (logs/ensure-runtime-cost.txt).
- **Saving:** about 2 s of CPU per answer (roughly 35 calls), about 0.2 s of it on the critical path.
- **Patch `11`:** within 10 minutes of a full check, the pointer and READY marker still naming the same lock answer `{ready: true}`. Anything else (a rebuild, a removal) is checked in full again.
- **Test:** python-host test 10 counts interpreter starts through a PATH shim. Before, it fails; after, it passes, and a half-rebuilt environment is still reported as not ready.

### 10. No machine-wide limit on Python interpreters (robustness; known item f — designed and patched)

- **Verified:** 12 concurrent calls ran as 12 interpreters at once on a 4-core machine. The evidence gather alone runs up to about 9: `DISCONNECTION_PROCESSES = 4`, plus three textbook calls, plus the route search and the stock check.
- **Patch `03`:**
  - A `Semaphore` (new file `hostLimits.ts`, also used by 05 and 08) sized `max(2, cores − 1)`, leaving one core for the main process that serves every host call.
  - Waiting is abortable. The interpreter's deadline is armed after admission, so time spent queued is never reported as running time.
- **Tests:** python-host tests 6 (peak running ≤ limit; a call queued past its own 1 s budget still succeeds) and 7 (a call cancelled while queued never starts and rejects within 300 ms). Before, both fail; after, both pass.

### 11. A server's refusal is forgotten by the next worker (robustness; known item e, process-lived host services — designed and patched)

- **Where:** the pacer lives in the plugin worker's module state (`worker.ts:365`). The host's network channel (`hostServices.ts:254-271`) keeps nothing.
- **What goes wrong:** after a 429 or 503, the next runner's worker (the next phase, or another conversation) asks again. PubChem's block grows while requests continue.
- **Patch `10`:** a process-lifetime table keyed by plugin and endpoint.
  - After a 429 or 503, nothing is sent to that endpoint for that plugin, from any worker, until the server's `Retry-After` has passed. Without one, a back-off doubles per refusal from 1 to 30 minutes.
  - A request in that window fails at once, with no wait, so the plugin's breaker falls back to OPSIN or to unresolved immediately instead of waiting out a pace (compare item b). It is not charged as a paid call.
  - The refusal itself still reaches the worker that asked.
- **Limit:** the per-request pace (at most 5 per second) stays the plugin's. With 09 one pacer serves a whole conversation, but two conversations at once each have their own. A shared host-side pace would need the manifest to declare a rate, which is a contract change; listed under suspected items.
- **Test:** `scripts/test-capability-endpoint-refusal.mjs`. Before, it fails; after, it passes.

### 12. Manifest `concurrency` is not enforced (robustness; known item f — designed and patched)

- **Where:** `packages/capability-api/src/manifest.ts:21-22` defines it as "how many invocations of this tool may run at once inside one worker". `runner.ts:240` passes nothing of it.
- **Patch `08`:**
  - `handle.call(…, { queue: { key: 'invoke:<toolId>', limit: tool.concurrency } })` uses an abortable per-handle semaphore.
  - The tool's deadline and the runner's timing line restart at admission, and queue time is logged beside the budget.
  - Different tools do not wait for each other.
- **Patch `08b` (plugin):** the manifest declared 1 for tools the app already runs side by side. Enforcing that would serialize them and slow every answer, so the values are raised to what the app sends:

  | Tool | Concurrency | What the app runs at once |
  |---|---|---|
  | `propose-disconnections` | 4 | `DISCONNECTION_PROCESSES = 4` |
  | `known-reactions` | 2 | ORD and textbook together |
  | `compile` | 2 | `DRAW_CONCURRENCY = 2` |
  | `check-stock` | 2 | evidence gather and route report |

  - `subworkers.max` stays 1. Raising it counts as a permission expansion under `permissionsExpandV2`, and with 05 a warm validator answers a drawing in tens of milliseconds, so serializing costs little. The 05 benchmark used max 1.
- **Tests:**
  - Worker-calls test 4 checks that a concurrency-1 tool never overlaps, a queued call keeps its budget, a cancel while queued is prompt, and other tools are unaffected. Before, it fails; after, it passes.
  - Plugin test "each tool declares at least the concurrency the application runs it at": fails before, passes after.

### 13. Cancelling a Python call leaves the processes it started running (robustness; requested — kill by process group)

- **Where:** `pythonRuntime.ts:213` spawns without its own process group, and `:225` kills only the interpreter.
- **What goes wrong:** the plugin starts helpers. `_opsin_local` runs Java under a 120 s timeout (`reactions_worker.py:1541`), and `_import_stock` uses a multiprocessing pool. After cancel or timeout these run on, unbudgeted.
- **Verified:** probe and python-host test 5. A `sleep 60` started by the script outlived the cancelled call before the patch and is gone after.
- **Patch `02`:**
  - On POSIX the interpreter leads its own group (`detached`) and the host kills `-pid`. This also runs after a clean exit, to reap leftovers.
  - On Windows the host walks the tree with `taskkill /T /F`.
  - On `process.exit` the host kills every live group.

### 14. A runtime check cancelled behind another build waits out that build (robustness; new, small)

- **Where:** `pythonRuntime.ts:36-46`. `withRuntimeLock` chains builds per shared environment and nothing aborts the wait. pip alone has a 15-minute budget (`:179`).
- **Verified:** python-host test 11. Before, a cancelled second caller was still waiting after 1.5 s; after, it rejects at once while its turn in the chain still passes without running.
- **Patch `14`:** the wait is abortable, and the chain entry is removed only when it settles, so serialization is never broken for a newcomer.

## Checks requested

- **Timeout semantics: from enqueue or from start?**
  - Before these patches nothing was queued. Tool deadlines are armed after the worker is ready (`workerHost.ts:132-148`), Python deadlines at spawn, and subworker deadlines at fork. A subworker's 15 s validation budget therefore included the ~1.05 s WebAssembly load, contended by unbounded interpreters.
  - Every queue the patches add arms the deadline at admission and logs the wait separately: Python slots (03), subworker slots (05) and tool slots (08). Each is tested with a queued call whose own budget is shorter than its wait.
  - Nested budgets: the verify-route tool budget (180 s) equals its subworker budget (180 s), so the inner one can never fire first. Not changed.
- **Cancellation propagation:** see findings 2 (process-wide cancel), 13 (process groups), 10 (abortable admission), 14 (provisioning lock), and 7's note on app-level catches that turn an abort into `null`. That last point is harmless: the next `throwIfAborted` stops the report.
- **Silent-null error paths:** see findings 6 (exit code 0), 7 (dropped logs and stderr) and 8 (a crash reported as an exit).
- **stdout/stderr buffering limits:** see finding 6. stdout's 32 MB cap is applied after the append, which is acceptable. The persistent path applies the same cap to each reply line, with a hard stop at twice that for an unterminated line.

## Suspected, not verified

1. **Worker crash traces are lost.** Workers and subworkers run with `stdio: 'ignore'`, so a crash trace from the worker or validator never reaches a log; only "exited without a result" does. Patch 12 adds a log channel but does not capture stdio. Not tested under Electron.
2. **Electron's unhandled-rejection mode.** Finding 8 was verified in a Node child standing in for the utility process. I assume Electron's utility process keeps Node's default `--unhandled-rejections=throw`.
3. **Combined PubChem rate across conversations.** Two conversations at once each pace PubChem at up to 5 requests per second, even after 09. A host-side shared pace needs a declared rate (`minIntervalMs` on a network permission), which is a contract change because `validateTrustedPermissions` uses exact keys.
4. **Per-invoke synchronous reads.** `resolveTrustedCapability` (`pluginStoreV2.ts:421-443`) reads and validates `plugin.json` and `capability.json` synchronously on the main thread for every invoke. Not measured; probably a few milliseconds.
5. **Settings IPC cannot be cancelled.** `capabilities:runAction`, `getSettings`, `applySettings` and `health` (`ipc/capabilities.ts:74-115`) pass no signal, so closing the settings view cannot cancel a 300 s action.
6. **Main-thread work may delay host calls.** Every capability host call is served on the main process's event loop. If retrieval's vector scans or the 1 GB vector cache (item g) block that loop during the evidence gather, they delay every worker's host calls. I did not measure this; it belongs to the retrieval audit.
7. **Memory of the shared worker.** A shared conversation worker is the small chemistry worker (fork to ready in 70 ms; RDKit lives in the subworker). Its memory with caches full over a long conversation was not measured. The caches are bounded (4096 entries each).

## Environment and how results were produced

- **Machine:** Linux, 4 cores, Node 22.22, Python 3.13.16.
- **Python packages:** a venv with the lock's pinned versions (rdkit 2026.3.6, drfp 0.3.7, faiss-cpu 1.15.1, zstandard 0.25.0, numpy 2.3.5, rdchiral 1.1.0) installed from PyPI. Used as `CHEMISTRY_TEST_PYTHON` and as the runtime in the benchmarks.
- **nodus `npm ci`:** fails here because `xlsx` comes from cdn.sheetjs.com, which the proxy refuses with 403. I installed with that one package removed from a local copy of the manifests. The two resulting `xlsx` type errors are the only typecheck errors, on base and patched alike.
- **nodus tests on a clean checkout with 01–14 applied:** `logs/final-nodus-tests-patched.txt`, covering all `scripts/test-capability-*.mjs` plus related chemistry tests.
  - 372 pass, 1 skip.
  - 1 fails: `test-capability-vision-transport.mjs`, which re-runs under Electron and also fails on the unpatched base.
  - Ten more research tests that re-run under Electron or need native bindings built for it fail identically on base (`logs/nodus-related-base-failing.txt`). They cannot run headless here, and I skipped them.
- **Plugin tests on a clean checkout with 04b, 08b, 09b, 12b applied:** 163 pass, 1 skip (needs a local OPSIN); typecheck and `validate-plugins` clean (`logs/final-plugin-tests-patched.txt`). The unpatched base was 157 pass, 1 skip.
- **Data rules:**
  - No dataset was downloaded. The benchmark index is synthetic, generated locally: templates from seed patterns, hash keys, random fingerprints.
  - No request was sent to PubChem's REST API or EBI OPSIN. Every benchmark replaces `fetch` with a local stub (404, or a synthetic name table), and the tests use stub hosts.
  - Nothing besides this directory was committed or pushed.
- **Benchmark harness:** the benchmark scripts are not committed, since only patches, this report and logs may be. Their method is described above. Electron's `utilityProcess` is replaced by `child_process.fork` with a preload that gives the child a `process.parentPort` of the same shape. Everything else is the real code bundled with esbuild, as the repository's own tests do.
