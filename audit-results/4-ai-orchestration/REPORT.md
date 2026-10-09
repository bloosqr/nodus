# Audit 4 — AI orchestration (`electron/ai/`): route and evidence path

Code audited: `audit/2026-10-09` of `bloosqr/nodus` (a828b6b3) and of `bloosqr/nodus-research-skill-marketplace` (fe3b2d6).
All line numbers are on those commits. Every patch in this directory is a unified diff against `audit/2026-10-09` of the repository named on its first line; `06-*` is for the marketplace, every other patch is for nodus.

No `shared/` file listed in GENERATED (`scripts/build-server-shared.mjs`) is edited by any patch. `shared/moleculeInspection.ts` is edited (03, 10, 22) but is not generated, so `npm run build:server-shared` does not need rerunning. `shared/routeRules.ts` is not touched.

## Summary

24 verified findings, most severe first. "Saving" is per answer unless stated.

| # | Finding | Category | Where (file:line) | Saving / impact | Test before → after |
|---|---|---|---|---|---|
| 01 | Retrieval, the turn plan and the target inspection wait for the whole evidence gather, though retrieval needs only its ORD disconnections | speed | electron/ai/researchAssistant.ts:633, 653-655, 735 | first turn of a target: min(retrieval, gather tail) — up to the whole retrieval phase (owner's 21%); every turn: one plan call (~1.2 s) overlapped | new test fails → passes; 13/13 |
| 02 | The corpus inventory is rebuilt ~96 times per turn, synchronously on the main thread | speed | electron/ai/researchCorpusRun.ts:111, 165, 182, 259, 307; documentaryPreparation.ts:816, 892 | measured 15.5 s → 4.5 s per turn at 14,000 works (96 → 26 builds; 95 → 1 in the regression test) | fails → passes |
| 03 | A correction chip is taken as the conversation's route request: that turn gets no route evidence and an 8,000-character retrieval query | bug | shared/moleculeInspection.ts:1453 | route evidence lost for the round and every later follow-up; retrieval query 20 → 7,963 characters | fails → passes |
| 04 | Every correction round re-plans the chip text and re-runs the whole supervisor, for the same retrieval question | speed | researchAssistant.ts:735; researchCorpusRun.ts:149 | ~1 + 4–9 LLM calls (≈1.19 s each, so ~6–12 s) plus the searches and reads they trigger, per fix round | fails (2 calls) → passes (0) |
| 05 | The route report's ORD lookup, textbook lookup, compatibility check and stock check start only after the 37 s verify-route, though none reads the audit | speed | electron/ai/moleculeInspection.ts:994-1000, 1048-1056 | the ORD lookup (6.4 s measured in the code's own comment) off the step-support critical path; compatibility, stock and textbook off the post-audit path | 463 → 321 ms in the mock; fails → passes |
| 06 | verify-route asks OPSIN and PubChem's REST API again, one name after another, for every name the resolve pass just found nothing for | speed (marketplace) | chemistry-studio src/worker.ts:520-525 (cache fill), 699-704 (label loop) | 2 network round trips per unresolved, author-structured name, serial, inside the 37 s call; also fewer PubChem REST requests | fails → passes; plugin suite 158/158 (1 skipped) |
| 07 | The evidence cache keeps a gather in which a phase failed, and serves it to every correction for 30 minutes | bug | electron/ai/synthesisEvidence.ts:496 (and catches at 152, 186, 233, 255, 478) | corrections lose ORD evidence after one transient failure | fails → passes |
| 08 | A route review that failed reads exactly like a clean review: "Route checked: balanced and connected", with no word that the blocking check never ran | bug | moleculeInspection.ts:1058 (requestRouteReview 574-578 returns null) | a route can be presented as checked without its blocking review | fails → passes |
| 09 | The turn's own citation receipts invalidate the vector-scan worker's caches between its searches | speed | electron/citations/scopedLegacyCitations.ts:42; researchCorpusRun.ts:184 | cached scan 127 ms vs 409 ms after a write (30,000 × 1024 vectors, measured); the vault changed before 5 of 6 searches in one turn | fails → passes |
| 10 | The app's own "Nothing in this reply was checked" note counts as a delivered route, so the follow-up loses the route lane | bug | shared/moleculeInspection.ts:1412, 1456 | the next turn gets no Chemistry Studio, no checks and no unchecked notice | fails → passes |
| 11 | After ~6 correction rounds the original request leaves the replayed history | bug | researchAssistant.ts:618 | the model no longer sees starting materials, scale or stereochemistry wording the chips do not repeat | fails → passes |
| 12 | The evidence cache key includes the chat model, which no gather tool reads | speed | synthesisEvidence.ts:396 | a model switch between a request and its correction re-gathers everything (the code measures a gather at ~394 s) | fails → passes |
| 13 | Every chat turn downloads the provider's whole model catalogue before retrieval starts | speed | electron/ai/thinkingEffort.ts:57-65 (via researchGenerationOptions.ts:12) | one catalogue request per turn, bounded by a 5 s deadline (0.2–5 s; estimate) | 3 → 1 reads; fails → passes |
| 14 | The name-correction LLM call ignores the stop button | bug | moleculeInspection.ts:508-514 | after a stop the route check waited 4.9 s in the test (up to the 180 s provider timeout, twice) | fails → passes |
| 15 | A stop during the route check replaces what the reader saw with the raw draft | bug | researchAssistant.ts:258-266 | the stored answer loses the repainted text; a `chemistry-plan` block comes back as "generation interrupted" | fails → passes |
| 16 | A route request that asks for a web search is not recognised as an explicit web request | bug | researchWebStep.ts:50; researchAssistant.ts:730 | the explicit web step never runs on route turns, and with web off the model is not told so | fails → passes |
| 17 | Every correction round sends the chip to molecule inspection, opening a chemistry worker for junk tokens | speed | researchAssistant.ts:633 | one worker start + one inspect call per fix round (~0.3–1.5 s; estimate) | fails → passes |
| 18 | Planner and supervisor calls wait out the 180 s completion timeout; one query embedding against a failing endpoint makes 9 HTTP attempts | robustness | researchTurnPlanner.ts:86; researchActionCoordinator.ts:155; aiClient.ts:2433-2437 | worst case per stalled step 180 s → 30 s; embedding 9 → 3 attempts (8.5 s → 4.2 s measured on a 503 endpoint) | fails → passes |
| 19 | A failure on the first opening search fails the whole turn; the same failure on the second or third is tolerated | robustness | researchCorpusRun.ts:137 | one documentary timeout ends the turn | fails → passes |
| 20 | The early repaint of the route report renders "Loading…" placeholders until the turn ends | speed (perceived) | src/components/ChatMarkdown.tsx:61-68; src/views/ResearchAssistantModal.tsx:1105 | the route report, chips and drawings are hidden for as long as the review runs | probe; typecheck only |
| 21 | The three opening queries are embedded one request at a time | speed | researchCorpusRun.ts:137-141 → 161 | 2 embedding round trips per turn (~0.2–1 s; estimate) | fails → passes |
| 22 | Superseded answers re-send their textbook-scheme and compatibility sections on every round | speed | shared/moleculeInspection.ts:1266 | prompt size: those two sections × up to 5 earlier answers per round | fails → passes |
| 23 | Non-streaming chat (`research:chat`, notebook runs) runs the route check without the turn's abort signal | bug | researchAssistant.ts:349 | deleting a notebook mid-route-check does not stop it | traced; typecheck only |
| 24 | Every streamed delta re-renders every earlier answer in the timeline | speed (renderer) | ChatMarkdown.tsx:42; ResearchAssistantModal.tsx:612-622 | 2.1 ms per delta with 6 earlier 230K-character answers (~4.2 s of main-thread time over 2,000 deltas) | bench; typecheck only |

All 24 patches together, with the four hand-merges described under **Applying the patches together**: every suite listed there passes, and the Electron project typechecks.

## Where an answer's time goes, and what these patches change

The owner's measured shares are: route check 32%, evidence gathering 29%, retrieval 21%, LLM 15%.

- **Evidence (29%)** is already cached across corrections (`synthesisEvidence.ts:383`). So its cost is the first turn of each target. On that turn, patch 01 lets retrieval (21%) run during the gather's tail instead of after it. Patches 07 and 12 are about the cache itself: 07 stops it serving a failed gather; 12 stops it missing after a model switch.
- **Retrieval (21%)** repeats in full on every turn, corrections included. Patches 02, 09 and 21 cut its fixed costs:
  - 02: inventory builds, the largest measured;
  - 09: vector-cache reloads;
  - 21: embedding round trips.

  Patch 04 removes the planning and supervisor calls from correction rounds, which are most rounds in a route conversation. Together these are most of the 78 short planning calls (about 93 s across 12 turns).
- **Route check (32%)** is dominated by verify-route (37 s, single core). Patch 05 moves four lookups from after the audit to beside it. Patch 06 removes the network lookups verify-route repeats for names already known to resolve to nothing; this is a different defect from known issue (a), which is about which resolver those lookups bypass.

I could not measure end-to-end shares. No real library, model key or reaction index is available here, and no PubChem or OPSIN traffic is allowed. Each saving below is therefore measured on a synthetic fixture or estimated, and the basis is stated.

## Findings

### 01 — Retrieval waits for the whole evidence gather (speed)
**Where:** `electron/ai/researchAssistant.ts:633`, `:653-655`, `:735`. The flow in `buildResearchChatPrompt` is serial:
1. `await inspectResearchMolecules(...)`
2. `await gatherSynthesisEvidence(...)`
3. `synthesisRetrievalQuery(routeQuestion, gathered)`
4. `await planResearchTurn(...)`
5. `run.investigate(retrievalQuestion)`

**What goes wrong:**
- `synthesisRetrievalQuery` (`shared/synthesisEvidence.ts:300-305`) reads only `evidence.disconnections`, so retrieval needs only ORD's disconnections.
- The gather keeps running long after those are known (`synthesisEvidence.ts:461-484`): the route search spends up to its 60 s budget, and the textbook schemes' second level waits on ORD and then runs up to `DISCONNECT_BUDGET_SECONDS` (180 s) per molecule.
- `planResearchTurn` reads only the conversation.
- `inspectResearchMolecules` reads only the question.

**Scenario:** a first request for a target of ≤32 atom symbols. ORD answers in seconds. Retrieval then waits for the route search's minute and the textbook second level before it starts.

**Verified:** a new test in `scripts/test-research-synthesis-context.mjs` holds the gather's tail open until retrieval embeds. It covers both the cloud path and the academic-vault notebook path (every academic chat takes the notebook path; `authorizeNotebookRequest` pins a scope).
- Before the patch it fails: "retrieval waited for the whole gather".
- After the patch: 13/13 pass.
- Logs: `logs/01-before.txt`, `logs/01-after.txt`.

**Patch:**
- `gatherSynthesisEvidence` gains `onDisconnections`, called as soon as ORD answers and on a cache hit.
- `buildResearchChatPrompt` starts the gather, the target inspection and the turn plan together. Retrieval starts on the early evidence, and the full evidence is awaited before the prompt is written.
- The budget is unchanged in one case: a local window outside a notebook has no final fit, so it still waits for the whole gather (`exactBudget`).
- Elsewhere the evidence so far sizes the retrieval budget, the evidence rule is counted as sent, and the final `enforceContextBudget` fit (`researchAssistant.ts:832-838`) keeps the request inside the window.

**Trade-off:** on a tight notebook window, retrieval may accept slightly more evidence than the final fit then keeps.

**Saving (estimate):** on a cache-miss turn, min(retrieval time, gather time after ORD answers). The basis is the gather's own budgets: 60 s for the route search, 180 s per molecule for the textbook second level. When the tail is longer than retrieval, this is up to the whole retrieval phase (owner's 21%). On every turn, the plan call (~1.2 s, from 93 s / 78 calls) and the target inspection (one worker start) also leave the serial path.

### 02 — The corpus inventory is rebuilt about 96 times per turn (speed)
**Where:**
- `electron/ai/researchCorpusRun.ts:111` (`validate`), `:165`, `:182`, `:259`, `:307`;
- `electron/ai/documentaryPreparation.ts:816`, `:892`.

**What goes wrong:**
- `researchCorpusInventory()` has no cache. Each call reads every work, every Global Library item and every note, synchronously on the main thread.
- `validate()` runs before and after every step, and each search asks again, twice more inside the documentary search.

**Verified:**
- On a synthetic 14,000-work vault, one build takes 189 ms.
- One turn of 3 opening searches and 9 decisions makes 96 builds: 15.5 s of a 16.5 s investigate. With the patch it makes 26 builds, 4.5 s. (Probe re-run here; the 26 includes 24 builds forced by the probe's own documentary stub.)
- New test `scripts/test-research-inventory-builds.mjs`: 95 builds before, so it fails; 1 build after, so it passes.
- Existing suites research-corpus-run, chat-agent, actions, evidence-request, zotero-agents and null-idea-statement all pass.
- Logs: `logs/02-*.txt`.

**Patch:** `ResearchCorpusRun.inventory()` keeps the inventory for one second, with a by-id map. `retrieveSharedDocumentaryEvidence` takes the run's getter. A check after any step longer than a second rebuilds, so a permission change made meanwhile is still caught.

**Saving:** ~11 s per turn at 14,000 works (measured). A real build is larger, because it also walks the Global Library and notes.

### 03 — A correction chip becomes the conversation's route request (bug)
**Where:** `shared/moleculeInspection.ts:1453` (`routeConversationState`).

**What goes wrong:**
- Fix chips name the synthesis, and their shared rules name reagents. So `looksLikeSynthesisRequest` accepts a chip under its 8,000-character cap.
- The missing-species chip is 7,963 characters and is accepted. The step-fix chips (8.5–9K) escape only by length.
- On that turn and every later human follow-up, `route.request` is the chip:
  - `findRequestedTarget` returns null, so `gatherSynthesisEvidence` logs "no target found" and sends no route evidence;
  - the retrieval query becomes the whole chip.

**Verified:**
- Probe (`logs/03-probe-*.txt`): request taken is the original: false → true; target null → `CCOC(=O)c1ccc(N)cc1`; retrieval query 7,963 → 20 characters.
- New test in `test-molecule-inspection.mjs`: fails → passes (130/130).

**Patch:** skip `isRouteFixPrompt` turns when choosing the request.

### 04 — Corrections re-plan the chip and re-run the supervisor (speed)
**Where:** `researchAssistant.ts:735`; `researchCorpusRun.ts:149`.

**What goes wrong:**
- A correction's retrieval question is its request's (the target and its reaction classes).
- Yet `planResearchTurn` plans the chip text, and its queries are searched too.
- `deepenResearch` then runs the whole supervisor loop again: one LLM call per decision, plus the groundwork reads.

**Verified:** new test, a correction in the academic notebook path counting `completeJson` calls: 2 before (with the stub failing, which ends the loop early), 0 after. Synthesis-context 13/13 and the three corpus suites pass.

**Saving:** the call counts come from code inspection; the latency from the owner's figure (93 s / 78 calls ≈ 1.19 s). That gives 1 plan call + 4–9 decisions ≈ 6–12 s of model latency per fix round, plus the searches and document reads those decisions trigger.

**Trade-off:**
- A correction searches only the target and its classes. It still carries the passages earlier answers cited (`seedPriorEvidence`).
- It no longer reads further on the supervisor's initiative.
- If that matters, keep the plan skip and drop the supervisor skip.

### 05 — Route-report lookups wait for verify-route (speed)
**Where:** `electron/ai/moleculeInspection.ts:994-1000` and `:1048-1056`.

**What goes wrong:** none of the following reads the audit:
- `lookupReactionPrecedent` (the ORD index);
- `lookupTextbookPrecedent`;
- `checkStepCompatibility`;
- `startingMaterialStockLine`.

All four read the labels or queries, yet they start only after `await invokeRoute(...)` (≈37 s).

**Verified:**
- New test `scripts/test-route-report-overlap.mjs`, with a mocked runner, 300 ms audit and 150 ms lookups.
  - Before: every lookup starts at 308 ms, after the audit ends; the report takes 463 ms; the test fails.
  - After: they start at 5–8 ms; the report takes 312–321 ms.
- The existing test "post-answer checks preserve structural verification…" (`test-research-synthesis-context.mjs:220`) asserted the call order. The patch changes it to assert the set of tools that ran, which is what it checks; its comment is kept.
- 134/134 and 12/12 pass. Logs: `logs/05-*.txt`.

**Saving:**
- The ORD lookup comes off the step-support path. It took 6.4 s in the measurement quoted at `moleculeInspection.ts:1007-1009`, where step support is the long pole on a failing route.
- Compatibility, stock and textbook now overlap the audit, saving whatever they cost beyond the review.

### 06 — verify-route re-asks the references for names already known to fail (speed, marketplace)
**Where:** `plugins/chemistry-studio/src/worker.ts:520-525` and `:699-704`.

**What goes wrong:**
- The resolve pass caches only resolved names in the worker's `referenceCache`.
- The app then sends verify-route labels with the same names, including names that failed and were given as structures.
- `resolveRouteLabels` sends each name that missed the cache back through `resolveNameReferences`, serially, inside the 37 s call. That is one PubChem REST request and one OPSIN request per name.
- The answer is "unchecked" either way.
- Known issue (a) is about these calls bypassing the mirror, the local-only switch and the pacer. This finding is that they are made at all.

**Verified:** new plugin test (resolve-names, then verify-route on one worker, all references answering 404).
- Before: `opsin/ws/frobnicated%20ethyl%20widget.json` and `pubchem/rest/pug/compound/name/…/cids/JSON` are requested again; the test fails.
- After: no request. Plugin suite 152/152 with 7 skipped, and with `CHEMISTRY_TEST_PYTHON` (Python 3.13, rdkit, numpy, faiss-cpu, zstandard, rdchiral) 158/158 with 1 skipped. Base was 157/157 with 1 skipped.

**Patch:** remember `[]` only for a name a reference actually answered: status `unresolved`, with feedback and no structure. A lookup that failed on the network carries no feedback and is not remembered. A refused salt keeps its structure and is still compared against it.

**Saving (estimate):** two serial round trips per unresolved name, typically 0.5–2 s each, so seconds per name on routes with several author-structured species. It also sends fewer requests to PubChem's REST API.

### 07 — The evidence cache keeps a gather in which a phase failed (bug)
**Where:** `synthesisEvidence.ts:496`. The failures are swallowed at `:152`, `:186`, `:233`, `:255` and `:478`.

**What goes wrong:**
- The comment says "Only a completed gather is kept … a half-gathered result cannot be served to the next turn as a whole one". But only aborts are excluded.
- A disconnection search that throws (a runtime deadline, a worker that died) is cached as "no disconnections" for 30 minutes.

**Verified:** new test in `test-synthesis-evidence-without-ord.mjs`. The first gather has a failing tool; the second has a working one. Before: the second turn gets `undefined`, served the failed gather; the test fails. After: it is re-gathered, and a completed gather is still served from memory; the test passes.

**Patch:** phases record failures and a degraded gather is not remembered.

**Trade-off:** a failure that repeats on every attempt now costs its time again on each round. The 180 s template budget (`worker.ts:56`) makes the runtime-limit failure the unusual case.

### 08 — A failed route review reads as a clean one (bug)
**Where:** `moleculeInspection.ts:1058`. `requestRouteReview` returns `null` on a failed call or an unreadable reply (`:564-578`).

**What goes wrong:**
- `formatRouteAudit` with `review = null` prints "Route checked: balanced and connected", with no mention of the review.
- The interim repaint said "the verdict waits for the model review", and the review is described as blocking (`:1001-1004`).
- So a timeout or 5xx turns a blocking check into silence. The code's own comment at `:565-567` names this hazard but only logs it.

**Verified:** new test in `test-molecule-inspection-compatibility.mjs`: fails → passes (134/134).

**Patch:** when the review is `null`, one line under the verdict says the model review did not run.

### 09 — Citation receipts invalidate the vector-scan cache between searches (speed)
**Where:** `electron/citations/scopedLegacyCitations.ts:42` (an INSERT per new receipt), called from `researchCorpusRun.ts:184` and `:315`. The worker keys its cache on `PRAGMA data_version` (`electron/workers/vectorScanWorker.ts:70-72`).

**Verified:**
- New test `scripts/test-research-receipts-between-searches.mjs`, reading `data_version` from a second connection as the worker does. Before: the vault changed before 5 of 6 later searches; the test fails. After: 0 of 6, with the same 48 passages of evidence; receipts are written at the end; the test passes.
- Cache benchmark (`logs/09-vector-cache-bench.txt`, 30,000 × 1024): cached scan 127 ms; after one unrelated write 409 ms; after an ignored insert 110 ms.
- The five corpus suites pass.

**Patch:** a receipt's id is its content hash, so `investigate()` collects the rows and writes them in one transaction in a `finally`. Other callers write immediately, as before.

**Saving (estimate):** ~0.3 s per 30,000 vectors per invalidated search, for up to ~5–10 searches per turn. On a library of the size `researchAssistant.ts:107` describes (44,138 passages, 13,799 ideas) that is roughly 2–5 s per turn.

### 10 — "Nothing in this reply was checked" counts as a delivered route (bug)
**Where:** `shared/moleculeInspection.ts:1412` and `:1456`.

**What goes wrong:**
- The note names the four labels itself, so `countRouteSteps(note)` is 1.
- After an unchecked first answer, "Please give me the full route." gets `delivered=true` and `asksForRoute=false`.
- That turn loses Chemistry Studio, the route lane and the notice. This is the hole that `skillExecution`'s comment (`researchAssistant.ts:230-237`) says it closes.

**Verified:** new test: fails → passes.

**Patch:** the note becomes a constant, removed before counting.

### 11 — The original request leaves the replayed history (bug)
**Where:** `researchAssistant.ts:618` (`.slice(-MAX_HISTORY_MESSAGES)`, 12).

**What goes wrong:**
- After about 6 correction rounds the request is out of `conversacion`.
- The target survives, because `routeConversationState` and `requestedTargetFor` read the full history.
- But the model no longer sees the starting materials, scale or stereochemistry wording, which chips do not repeat.

**Verified:** new test (8 rounds): `conversacion[0]` is the request after the patch, not before.

**Patch:** prepend `routeConversationState(turns).request` when it is not in the window. This adds the request's length, about 0.1–2K characters.

**Caveat:** the compact local path (`slice(-4)`, `:624`) still drops it.

### 12 — The evidence cache is keyed on the chat model (speed)
**Where:** `synthesisEvidence.ts:396`.

**What goes wrong:**
- No gather tool reads the model: propose-disconnections, search-routes and check-stock take neither the model nor the chat budget (`worker.ts`), and passages use the embedding configuration.
- Switching model between a request and its correction therefore misses the cache and re-gathers everything (394 s in the measurement quoted at `:362`).

**Verified:** new test (two models, one target): before, a second gather; after, served from memory. Fails → passes; evidence suites 32/32, synthesis-context 12/12.

### 13 — The model catalogue is fetched on every turn (speed)
**Where:** `electron/ai/thinkingEffort.ts:57-65`, called from `researchGenerationOptions.ts:12` on every turn before retrieval.

**What goes wrong:** `listModels` performs a live GET of the provider's catalogue (up to a 5 s deadline). Its result is stored by `rememberThinkingCatalog` but never read back here.

**Verified:**
- New test `scripts/test-thinking-catalog-cache.mjs`: 3 turns made 3 reads before (fails) and 1 after (passes); a failed read is not remembered.
- job-thinking-effort, native-effort and evidence-request pass, run under node with their flags.

**Patch:** keep a completed read for 10 minutes, per provider, endpoint and model.

**Saving (estimate):** one catalogue request per turn, typically 0.2–1 s and up to the 5 s deadline; OpenRouter's catalogue is the largest.

### 14 — The name-correction LLM call ignores abort (bug)
**Where:** `moleculeInspection.ts:508-514` (`requestCorrectedNames`; the review call at `:562` passes the signal).

**Verified:** new test `scripts/test-route-names-abort.mjs`. With a stop at 100 ms, the check returned 4,909 ms after the stop before the patch, and 2 ms after it, returning nothing as the other stopped paths do.

**Patch:** pass the signal, and rethrow on abort so `resolveNamedRoute` returns its legacy result.

### 15 — A stop during the route check returns the raw draft (bug)
**Where:** `researchAssistant.ts:258-266`.

**What goes wrong:** the AbortError is caught by the fail-open `catch`, which returns the unstripped `answer`. The repainted, skill-executed text is lost, and the `chemistry-plan` block comes back and renders as "generation interrupted". A user stop is also logged as `audit pipeline failed`.

**Verified:** new test: before, the raw draft is returned (fails); after, the last repaint is kept.

### 16 — "Search the web" is lost on route turns (bug)
**Where:** `researchWebStep.ts:50`; `researchAssistant.ts:730` passes `retrievalQuestion` (e.g. "paracetamol synthesis") as the grant's question.

**What goes wrong:** `explicit` is computed from that derived query, so it is false. The explicit web step never runs on route turns, and with web off the prompt lacks `web_search: 'disabled_by_user'`.

**Verified:** new test (notebook path, web off): the field is missing before the patch and present after. web-research-flow 5/5 and chat-agent pass.

### 17 — Corrections are sent to molecule inspection (speed)
**Where:** `researchAssistant.ts:633`.

**What goes wrong:** both chip kinds yield the SMILES candidates `["(glycine","L-alanine)","synthesis)","initiator)"]`, which come from the shared rules text (`logs/17-probe.txt`). So `inspectResearchMolecules` opens a chemistry worker and inspects junk on every fix round.

**Verified:** new test: inspect calls 1 → 0.

**Saving (estimate):** one worker cold start plus one inspect call per round, ~0.3–1.5 s (basis: the cold-start notes at `synthesisEvidence.ts:452-456`).

### 18 — Timeouts and retries on the research steps (robustness)
**Where:** `researchTurnPlanner.ts:86` and `researchActionCoordinator.ts:155` have no `timeoutMs`, so they use the 180 s cloud default (`aiClient.ts:402`). The OpenAI-compatible embedding client at `aiClient.ts:2433-2437` sets neither `timeout` nor `maxRetries`.

**What goes wrong:**
- The SDK defaults are 600 s and 2 retries, nested inside `withProviderRetries`.
- One `embed()` against a 503 endpoint made 9 HTTP attempts (8.5 s).

**Verified:** new test `scripts/test-research-step-bounds.mjs`: 9 → 3 attempts (4.2 s), and the planner's timeout goes from unset to 30 s. ai-provider-retries 6/6, ai-transient-network 7/7, embedding-contract 5/5 and ai-json-retry pass.

**Saving:** none in the normal case. The worst case per stalled step drops from 180 s to 30 s, and per embedding from ~30 minutes to ~3 minutes.

**Caveat:** the SDK's own retry of connection resets now relies on `withProviderRetries` and the queue.

### 19 — The first opening search's failure fails the turn (robustness)
**Where:** `researchCorpusRun.ts:137`, outside the try/catch that covers queries 2–3.

**Verified:** new test with `documentary_retrieval_timeout` on the first search: `investigate` rejects before the patch; after it, the turn continues with `research_read_unavailable`. Deep Research and other single-query runs still throw.

### 20 — The early repaint renders placeholders (perceived speed)
**Where:** `src/components/ChatMarkdown.tsx:61-68` renders chips, artifacts and views only when `!streaming`. `ResearchAssistantModal.tsx:1105` passes `streaming={message.id === streamingId}`, and `streamingId` stays set until the turn ends.

**What goes wrong:** the deterministic route report repaint (`moleculeInspection.ts:1033`, `researchAssistant.ts:278`) shows "Preparing tool… / Cargando…" until the review returns.

**Verified:** server-rendering the real component (`logs/20-render-probe.txt`). The renderer patch typechecks; there is no component test.

**Patch:** once the main process repaints with a finished answer, that message renders as complete.

### 21 — Opening queries are embedded singly (speed)
**Where:** `researchCorpusRun.ts:137-141` → `:161`.

**Verified:** new test: 0 batched and 3 single requests before; 1 batched and 0 single after. If the batch fails, each search embeds its own query, as before.

**Saving (estimate):** 2 round trips per turn, ~0.2–1 s on cloud.

### 22 — Superseded answers replay textbook and compatibility sections (speed)
**Where:** `shared/moleculeInspection.ts:1266`. `HISTORY_LATEST_ONLY` lacks `### Known reactions (textbook schemes)` and `### Functional-group compatibility`. The ORD section is already latest-only.

**Verified:** new test: fails → passes.

**Saving:** the size of those sections × up to 5 earlier answers per round. They could not be sized without a real route.

### 23 — Non-streaming chat's route check ignores abort (bug)
**Where:** `researchAssistant.ts:349`. `finalizeWithAudit(..., execution)` gets no signal; `withRouteEvidence` on the same line does.

**What goes wrong:** this path serves `research:chat` (`electron/ipc/academic.ts:1742`) and notebook runs, whose controller is aborted when the notebook is deleted (`researchNotebookService.ts:57`). Such a run continues through the whole route check.

**Verified:** traced; the patch typechecks. No test: this path needs a full model round trip.

### 24 — The timeline re-renders every earlier answer per delta (renderer speed)
**Where:** `ChatMarkdown.tsx:42` (not memoised) and `ResearchAssistantModal.tsx:612-622` (`onDelta` → `setMessages`).

**What goes wrong:** each delta re-runs `splitChatVisuals` and parses every capability block of every earlier answer.

**Verified:** benchmark (`logs/24-render-bench.txt`): 2.1 ms per delta with 6 earlier 230K-character answers. The streaming answer's own full re-parse is 77 ms per render at 8.9K characters (O(n²) over a stream). The renderer patch typechecks; there is no app-level render-count test.

**Patch:** memoise `ChatMarkdown`. The streaming answer's own O(n²) is not addressed: it needs `onDelta` coalescing.

## Applying the patches together

Each patch applies alone to `audit/2026-10-09`. Each nodus patch was also run alone against the related suites (molecule-inspection, compatibility, synthesis-evidence ×2, route-evidence, ai-provider-retries, web-research-flow, research-synthesis-context, corpus-run, chat-agent, actions, evidence-request, plus the tests it adds) and the Electron typecheck: no failures and no type errors for any patch (`logs/per-patch-suites.txt`). Most pairs also apply together with `patch -p1 --fuzz=3` in numeric order. The test files gain tests at shared anchors, so `git apply` without fuzz refuses some pairs.

Four pairs overlap in code and need these hand-merges:

- **01 + 04:**
  - the plan line becomes `correction ? literal-from-retrievalQuestion : await (planned ?? planResearchTurn(...))`;
  - 01's early `planned` must also be skipped on a correction: `!(chemistryRoute && isRouteFixPrompt(question))`, or 01 starts a plan call that 04 then discards.
- **01 + 17:** `const inspecting = genealogy || !chemistryEnabled || isRouteFixPrompt(question) ? Promise.resolve([]) : …`.
- **02 + 09:** the `readOriginal` call becomes `recordScopedSourcePassage(…, this.inventory().documents, this.pendingReceipts)`.
- **19 + 21:** keep 21's `embedMany` line, then 19's loop over every query, passing `vectors[index]`.

With all 24 applied this way (the scratch tree is not committed; output in `logs/all-patches-together.txt`):
- Electron and renderer typecheck clean.
- molecule-inspection 132, compatibility 5, route-report-overlap 1, route-names-abort 1, synthesis-evidence 15, without-ord 18, route-evidence 4, thinking-catalog 2, step-bounds 2, ai-provider-retries 6, ai-transient-network 7, embedding-contract 5, web-research-flow 5.
- research-synthesis-context 18/18; inventory-builds, opening-searches (2) and receipts-between-searches pass.
- corpus-run, chat-agent, actions, evidence-request, zotero-agents, null-idea-statement, job-thinking-effort, native-effort and ai-json-retry exit 0.

## LLM calls on one route turn

- **Planner:** 1 call (`researchTurnPlanner.ts:86`), on every academic turn.
- **Supervisor:** one call per decision (`researchActionCoordinator.ts:155`).
  - The loop runs to 14 rounds (6 when light), within a 128 KB decision budget.
  - It typically makes 4–9 decisions, plus up to 2 refused finishes.
- **Web step:** 0–5 calls (plan, pick ×2, reformulate, rate).
- **Answer:** 1 call, plus up to 2 citation-recovery resamples.
- **Route check:** name corrections, 0–2 calls; route review, 1 call.
- **Revision pass:** optional and off by default.

That is about 1 + 4–9 (+0–5 web) short calls per turn, which fits the measured 78 calls across 12 turns. Patch 04 removes the planner and supervisor calls from correction rounds; patch 18 bounds them.

## Suspected, not verified

1. **Overlapping the opening searches.** Their scans could overlap fully. They are serial only because `retrieve` updates the shared budget as it goes. Possible saving: about two searches per turn.
2. **`agentGroundwork` reads up to 3 documents serially** (`researchActionCoordinator.ts:57-62`), each in a new documentary worker with a 30 s deadline.
3. **Documentary retrieval spawns a worker per call** (`documentaryPreparation.ts:856`), and its `semanticSearch` uses the per-row SQL callback that the vector worker cache replaced elsewhere. The `[documentary] retrieval Xs` log lines would size it.
4. **The vector scan host's 180 s timeout** (`electron/db/vectorScanHost.ts:99-117`) rejects every pending scan. Each one then reruns in the main process, and a new worker rebuilds every cache.
5. **No abort signal in the scans.** `retrieveHierarchical` and the vector scans take none, so a cancelled turn's scans run to the end.
6. **The web step on fix rounds.** Web passages cited earlier are not carried into later turns. A re-run web step (afterLibrary on a thin result) researches the same question again. `recordWebPassage` writes change `data_version` mid-turn, with the same effect as 09.
7. **Abort during the route review.** `requestRouteReview` swallows the AbortError and returns `null`. The report is then built and returned in full after a stop. With 08, it says the review did not run.
8. **`e.sender.send` in `onDelta`** (`electron/ipc/academic.ts:1760`) has no `isDestroyed()` check. Closing the window mid-stream may throw.
9. **`isRouteFixPrompt` matches user-typed text** starting "Correction needed for step …". Such a message is treated as a chip and exempted from citations.
10. **`stripDrawingRequests`** (`shared/moleculeInspection.ts:2500`) leaves an unterminated `chemistry-plan` fence, or a `~~~` fence, in place.
11. **verify-route re-resolves structure-named labels.** A species named back from its structure (`resolve-structure`) carries a name the resolve pass never looked up, so verify-route resolves it over the network. The check is circular. This is the same mechanism as 06; it is not patched, because caching that name changes what the label check compares against.
12. **The route review uses the default 180 s timeout and retries**, and the turn waits on it. A shorter bound would help, but review budgets of several thousand tokens make a safe figure model-dependent.
13. **`appendStructureAudit` runs serially** between name resolution and the route report (`researchAssistant.ts:310`). It could overlap the report. The inspect worker is warm by then, so the saving is probably under a second.
14. **`findSmilesCandidates` accepts parenthesised words** ("(glycine", "synthesis)") as SMILES. On an ordinary question this opens a worker to inspect junk; 17 covers only the chip case.

## Test environment and honest notes

- **`npm ci` failed.** The `xlsx` tarball on cdn.sheetjs.com is blocked here (403). I installed with the registry's `xlsx@0.18.5`, ran `npm rebuild better-sqlite3` (Node ABI), and restored `package.json` and the lock file. Nothing from that is committed.
- **`npm run typecheck`** passes on base (renderer and Electron). Each nodus patch was typechecked against the Electron project; patches 20 and 24 against the renderer project.
- **Electron-rerun tests.** Electron headers are blocked, so better-sqlite3 cannot be built for Electron's ABI. Tests that re-run under Electron were run under plain node by passing their own flag (for example `node scripts/test-research-synthesis-context.mjs --native-synthesis-context`); they pass on base. `test-research-effort-memory.mjs` launches Electron itself and could not run.
- **Plugin.** `npm ci` succeeded. `node --test plugins/chemistry-studio/test/*.test.mjs` gives 151/151 with 7 skipped on base. With `CHEMISTRY_TEST_PYTHON` set to a venv holding rdkit, numpy, faiss-cpu, zstandard and rdchiral, it gives 157/157 with 1 skipped.
- **No network to references.** No request was sent to PubChem's REST API or to EBI OPSIN; plugin tests stub the network. No dataset was downloaded.
- **Who verified what.** Three auditors worked on this area: me, one on retrieval and planning, one on the route report and timeline. I re-ran or rewrote every test and probe cited here.
- **Logs.** `logs/` holds the before and after output of each test, the probes, the benchmarks and `per-patch-suites.txt`: each patch alone on base against the related suites.
