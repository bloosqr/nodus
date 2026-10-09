# Audit 6: patches for the earlier findings

Base: branch `audit/2026-10-09` of both repositories. Every file:line below refers to that base.
- `bloosqr/nodus` at `a828b6b3`
- `bloosqr/nodus-research-skill-marketplace` at `fe3b2d6`

This area was nine findings that were already known. I verified each one first, then wrote a patch with a regression test, and ran each test before and after its patch. Eight of the nine held up as described. Item 6 was right for six of its eight files and wrong for the other two, so I patched only the six. Each patch is a unified diff against the base branch, and its first line names the repository it applies to. Logs are in `logs/`. They are stored as `.txt` because this repo's `.gitignore` ignores `*.log`.

## Results at a glance

| # | Patch | Repo | Category | Test before → after |
|---|-------|------|----------|---------------------|
| 1 | `01-pubchem-pacer-max-wait-and-abort.patch` | marketplace | speed | fail (60.9 s wait) → pass |
| 2 | `04-local-references-isolate-mirror-and-opsin.patch` | marketplace | robustness | fail → pass (2 tests) |
| 3 | `05-mirror-path-as-uri.patch` | marketplace | bug | fail → pass |
| 4 | `07-balance-unchecked-outcome.patch` + `07b-balance-unchecked-rendering.patch` | marketplace + nodus | bug | fail → pass (both sides) |
| 5 | `03-orphan-metal-counts-cancelled-spectators.patch` | marketplace | bug | fail → pass |
| 6 | `02-group-salts-only-with-spectator-ion.patch` | marketplace | bug | fail → pass |
| 7 | `08-refiled-step-not-plainly-balanced.patch` | nodus | bug | fail → pass (2 tests) |
| 8 | `09-refiled-reactant-one-explicit-edit.patch` | marketplace | bug | fail → pass |
| 9 | `06-electron-rerun-strip-node-test-context.patch` | nodus | test-gap | guard fails (6 files) → passes; see below |

File numbers follow the order of the task list; the table above is ranked by severity.

**All patches applied together:**
- **Plugin:** `node --test plugins/chemistry-studio/test/*.test.mjs` gives 164 tests, 163 pass, 0 fail, 1 skipped. The skip is the existing local-OPSIN test, which needs `CHEMISTRY_TEST_OPSIN`; there is no local OPSIN here. Baseline before any patch: 158 tests, 157 pass, 1 skipped. `npm run validate`, which includes `tsc`, passes (`logs/plugin-validate-patched.txt`).
- **Plugin patch checks:** every plugin patch passes `git apply --check` on a clean checkout, alone and in sequence (01, 02, 03, 04, 05, 07, 09). The tree that results is identical to the one I tested.
- **nodus:** 06, 07b and 08 apply alone and together. With them applied, `node --test scripts/test-molecule-inspection.mjs scripts/test-electron-rerun-test-context.mjs` gives 131/131. `npm run typecheck` shows the same two errors as the unpatched baseline, both in `electron/researchAttachments.ts` because `xlsx` is not installed (see Environment). Logs: `logs/nodus-typecheck-baseline.txt` and `logs/nodus-typecheck-patched.txt`.
- **Generated files:** none of these patches edits a file listed in GENERATED (`scripts/build-server-shared.mjs`). `shared/moleculeInspection.ts` is not in that list, so `npm run build:server-shared` does not need to be rerun.
- **Constraints:** no added line uses any of the forbidden words, and `shared/routeRules.ts` is not touched.

---

## 1. The PubChem pacer waits up to a minute per look-up and ignores the abort signal (known item b)

- **Where:** `plugins/chemistry-studio/src/worker.ts:380` (`takePubchemTurn`) and `:409` (`breakerFetch`).
- **Category:** speed. It is also a robustness issue.
- **What goes wrong:**
  - After a refusal, or after a Black grade, `notePubchemFeedback` sets the pace to 60 s for 5 minutes.
  - Every queued look-up then sleeps in a plain `setTimeout` until its turn.
    - With `NAME_CONCURRENCY = 4` and *n* names, turn *k* is about 60·*k* s away, so any resolve call with more than three names runs into its 180 s timeout.
    - The sleep ignores the turn's abort signal. It also ignores `readJSON`'s own 10 s timeout, because `routedFetch` in `deps.ts:18` drops `init` (`void init`).
    - So when the wait ends, the request is **still sent**, to a server that has just throttled us, for a caller that already gave up.
- **How I verified it:** a new test, *"a PubChem turn more than about 8 s away falls back at once, and an abort ends the wait"*.
  - **Black case:** two `resolve-structure` look-ups. The second sleeps the whole minute: the test takes 60 897 ms and fails `logs/01-before.txt`.
  - **Red case:** a 5 s pace, with an abort after 600 ms. Before the patch the queued request is sent once the wait ends. After, it never is.
- **Fix:**
  - A look-up whose turn is more than `PUBCHEM_MAX_WAIT_MS = 8_000` away now throws at once. The callers already treat that error as "use the fallback", and the turn is not reserved, so turns queued behind it don't move back.
  - Both sleeps now use an abortable pause, and `breakerFetch` passes `init.signal` in. That signal carries both the turn's abort and `readJSON`'s timeout.
  - A wait cut short throws before the request is sent, so it is not counted as an outage and does not open the breaker.
  - The existing Yellow 1 s and refusal tests still pass.
- **Result:** fails before, passes after (`logs/01-after.txt`).
- **Saving (measured on the stub):**
  - With a Black pace, 2 look-ups take 888 ms and 8 look-ups take 920 ms, each sending one request; the rest is in-process RDKit work. Before the patch, 2 look-ups took 60.9 s.
  - For 8 names before the patch, the arithmetic is turns at 0, 60, 120 … s, so the call is cut off by the 180 s timeout.
  - Per answer: in any answer that resolves names within 5 minutes of a refusal or a Red/Black grade, this saves up to about 180 s per resolve call (`resolve-names`, `resolve-structure`) and roughly one route check's worth of fix rounds.
  - Outside that window it saves nothing, so it does not move the steady-state 15% LLM share. It removes the worst-case stalls.

## 2. A half-built or corrupt PubChem mirror makes the whole local-references call fail, losing local OPSIN too

- **Where:**
  - `plugins/chemistry-studio/python/reactions_worker.py:1583-1591` (`handle`, the local-references branch)
  - `plugins/chemistry-studio/src/worker.ts:544` (`localReferencesFor`, `if (run.code !== 0) return {}`)
- **Category:** robustness. It also costs speed.
- **What goes wrong:**
  - A mirror folder can be in two broken states:
    - it holds `pubchem.sqlite` with only some tables (a build that was interrupted): the error is `sqlite3.OperationalError: no such table: inchikey`;
    - the file is not SQLite at all: the error is `DatabaseError: file is not a database`.
  - Either exception aborts `handle`, and Python exits non-zero.
  - The host then returns `{}` and logs nothing, so the local OPSIN answers from the same call are thrown away and every name goes to the network: PubChem through the pacer, and EBI.
  - Under `localOnly` (timing traces), every name becomes unresolved.
- **How I verified it:**
  - A Python probe reproduced both exceptions.
  - A new Python test builds both broken mirrors, with OPSIN stubbed, and fails before the patch because `handle` raises.
  - A new host test sets `python.run` to exit 1 with a traceback. Before the patch nothing was logged (`logged = []`).
- **Fix:**
  - The mirror part and the OPSIN part are each wrapped in their own `try`.
  - A broken mirror now reports `{"available": false, "error": "<Type>: <message>"}`, so the caller asks the network for those names. The reason is also written to stderr.
  - The host now logs a `warn` with `stderr` (its last 2000 characters) when the exit code is non-zero.
  - Small addition: the host also logs `pubchem.error` when it is present, because with the patch the exit code is 0 and a silently half-built mirror would otherwise never be noticed.
- **Result:** both tests fail before and pass after (`logs/04-*.txt`). The existing mirror and local-only tests still pass.
- **Saving (estimate):** for each answer while the mirror is broken, every name the local OPSIN parsed (there are no PubChem REST calls in this path) is sent back to the network instead.
  - At the pacer's Green floor of 200 ms per request, with 2 PubChem requests per name, 40 names cost at least 16 s of pacing, plus round trips and EBI calls.
  - During a hold (finding 1), it is much worse.
  - Not measured against the network: the data rules forbid PubChem REST and EBI.

## 3. The mirror path is put raw into a `file:` URI and breaks on `#`, `?` or `%` (it also creates a stray database)

- **Where:** `plugins/chemistry-studio/python/reactions_worker.py:1496`, `sqlite3.connect(f"file:{path}?mode=ro", uri=True)`.
- **Category:** bug.
- **What goes wrong:**
  - A folder name containing `#` or `?` cuts the URI short. SQLite then opens the shorter path **without `mode=ro`**, so it uses the default read-write-create mode, and **creates an empty file there**. The probe left an empty `/tmp/m` behind, which I deleted. The lookup then fails with `no such table: synonym`.
  - A `%41` in the name is percent-decoded instead, and the call fails with `unable to open database file`.
  - Before patch 04, either failure also lost the OPSIN answers (finding 2).
- **How I verified it:** a probe, then a new test that creates mirrors in the folders `lib #1`, `what?` and `a%41b`.
  - Before: all three calls raise `OperationalError`, and a stray file is created.
  - After: all three return `CCO`, and no stray file appears.
- **Fix:** the URI is built with `pathlib.Path(path).resolve().as_uri()` followed by `?mode=ro`.
- **Result:** fails before, passes after (`logs/05-*.txt`).
- **Saving:** the same as finding 2 for a user whose library path contains these characters, because the mirror never opened for them.

## 4. "Too many free species" is reported as "not balanced" and advises adding a species

- **Where:**
  - `plugins/chemistry-studio/src/engine/chemistryReaction.ts:529-534`
  - `chemistryRouteAudit.ts:189-204, 969`
  - nodus `shared/moleculeInspection.ts:1616, 2300, 2538`
- **Category:** bug, on the fix-round path.
- **What goes wrong:**
  - When the null space has more than `SEARCH_DIMENSION_LIMIT = 4` dimensions, the solver throws an ordinary error.
  - The route audit then reports `Step N is not balanced: This step leaves 5 species free to vary … it has NOT been shown to be unbalanced …`, which contradicts itself.
  - The message then appends `missingSpeciesAdvice` and `imbalanceAdvice`: "a species this step consumes is missing from Reactants", "Add the missing reagent or byproduct …".
  - Adding a species adds another free one, so that advice sends the model the wrong way.
  - nodus prints `FAIL — NOT balanced (… balance was not checked …)`. The case is the existing repeated-sulfate test step.
- **How I verified it:**
  - **Plugin:** I tightened the existing test *"a shared counterion written once per side …"*. It now requires a `balanceUnchecked` field, a "split" action, no add-a-species wording, and a blocked line that does not say "is not balanced". It fails before (`logs/07-before.txt`).
  - **nodus:** a new test builds an audit with `balanceUnchecked` set. It fails before because normalisation dropped the field and the line read "NOT balanced" (`logs/07b-before.txt`).
- **Fix:**
  - **Plugin (07):**
    - The solver throws a new `BalanceUnchecked` error. Its message ends with the single action: "Split it into consecutive steps, each naming fewer species."
    - `stepBalance` returns `unchecked: true` and skips the agent-misplacement hint.
    - The side-flip hint is skipped for this case.
    - The step gets `balanceUnchecked`, and the blocked line reads "Step N was not checked for balance: …".
    - `balanced` stays `false`, so no host, old or new, ever passes such a step.
  - **nodus (07b):**
    - `normalizeRouteAudit` keeps `balanceUnchecked`.
    - The step line reads `FAIL — balance NOT checked (…)`.
    - `routeStepFailure` returns `balance not checked (…)`.
- **Result:** both sides fail before and pass after.
- **Compatibility:**
  - Old plugin with new nodus: no change.
  - New plugin with old nodus: the advice is fixed, but the line still says "NOT balanced", so apply both.
- **Saving (estimate):** each such step that follows the old advice costs at least one wasted fix round: an LLM call plus a route check of about 37 s. I did not measure how often this branch fires on real routes.

## 5. The orphan-metal message ignores a metal reactant cancelled as a spectator (known item d)

- **Where:** `plugins/chemistry-studio/src/engine/chemistryReaction.ts:591`. `reactantMetals` was built from `reduced`, which leaves out the cancelled spectators.
- **Category:** bug, on the fix-round path.
- **What goes wrong:**
  - Reactants `CCBr + [OH-] + [Na+]`; products `CCO + [Br-] + [Na+] + NaBr`.
  - `[Na+]` is on both sides, so it is cancelled before solving.
  - The spare NaBr is then reported as *"carries a metal that nothing under Reactants supplies … the reagent that brings the metal is missing from Reactants"*, but a sodium ion is declared right there.
  - The right advice is that NaBr takes no part and can be deleted.
- **How I verified it:** a new `balanceReaction` test. Before the patch it returned exactly the wrong message (`logs/03-before.txt`).
- **Fix:** `reactantMetals` is built from every declared reactant in `active`, spectators included.
- **Result:** fails before, passes after. The existing orphan-metal and reagent tests (the NaBH4, lithium amide and sodium cases) still pass.

## 6. `groupSalts` merges ions that react with each other (known item c)

- **Where:** `plugins/chemistry-studio/src/engine/chemistryReactionShared.ts:38` (`groupSalts`) and `:53` (`reactionSmilesSpecies`). This is the `compile` and drawing path.
- **Category:** bug.
- **What goes wrong:**
  - Every consecutive run of ions whose charges sum to zero became one species.
  - So `[H+].[OH-]>>O` was drawn with a single reactant `[H+].[OH-]` turning into water.
  - The same happened to `[Ag+].[Cl-]>>Cl[Ag]` and `CC(=O)[O-].[H+]>>CC(=O)O`.
- **How I verified it:** a `compile` probe showed the reactant lists `["[H+].[OH-]"]`, `["[Ag+].[Cl-]"]` and `["CC(=O)[O-].[H+]"]`. A new test asserts two reactants for each, and also that sodium nitrite in the existing nitrosation step stays one salt.
- **Fix:**
  - A closed run is grouped only when one of its ions also appears as a component on the other side, which is what a spectator does.
  - Agents have no other side and keep the old grouping: an agent takes no part, so its ions cannot react with each other in the step.
- **Result:** fails before, passes after. The existing salt test (sodium sulfate on both sides) still passes.

## 7. A refiled step prints "balanced" beside FAIL

- **Where:** nodus `shared/moleculeInspection.ts:2300` (step line) and `:2559` (`routeStepFailure`).
- **Category:** bug.
- **What goes wrong:**
  - A step that balanced only after the checker moved a declared reactant to Agents printed `- Step 1 FAIL — balanced. "water" was listed under Reactants …`.
  - I reproduced this with the real formatter. `routeStepFailure` returned the bare refile sentence.
- **How I verified it:** I extended two existing tests to require the new wording. Both fail before (`logs/08-before.txt`).
- **Fix:**
  - The line now reads `FAIL — balanced only after the checker refiled a declared reactant.`
  - `routeStepFailure` returns `balanced only after the checker refiled a declared reactant: <reason>`. That value is also used in the fix prompts and the "not drawn" list.
  - The patch's hunks don't overlap 07b's, so the two apply in either order.
- **Result:** fails before, passes after. With 08 and 09 together, the line reads:

  > `- Step 1 FAIL — balanced only after the checker refiled a declared reactant. "the carbodiimide" was listed under Reactants, and the step balances only if it takes no part, so the check treated it as a condition. Make one edit to this step: move "the carbodiimide" to Agents, or name under Products the product it becomes.`

## 8. In a rescued step, the refiled-reactant message does not ask for one explicit edit

- **Where:** `plugins/chemistry-studio/src/engine/chemistryRouteAudit.ts:651`.
- **Category:** bug, on the fix-round path.
- **What goes wrong:**
  - The message ended in two conditionals: "If that is right, list it under Agents. If it is genuinely consumed, then the product it becomes is missing …".
  - Read together with "the check treated it as a condition", that sounds as if nothing needs doing.
- **How I verified it:** I tightened the existing test *"a reactant nothing accounts for is named, not silently refiled"* to require the one-edit sentence and to reject "If that is right". It fails before (`logs/09-before.txt`).
- **Fix:** the message now ends: `Make one edit to this step: move "<name>" to Agents, or name under Products the product it becomes.` Plurals are handled.
- **Result:** fails before, passes after. No other code or test in either repository depends on the old wording; I checked with grep.

## 9. Electron re-runs of node:test suites inherit NODE_TEST_CONTEXT (6 of the 8 listed files)

- **Where:**
  - `scripts/test-backup-vault-revision.mjs:11`
  - `scripts/test-teaching-exams.mjs:20`
  - `scripts/test-teaching-rubrics.mjs:17`
  - `scripts/test-vector-scan.mjs:28`
  - `scripts/test-work-deletion.mjs:32`
  - `scripts/test-writing-workshop-candidate-pools.mjs:28`
- **Category:** test-gap.
- **What goes wrong:**
  - Under `node --test`, each of these files re-runs itself with `ELECTRON_RUN_AS_NODE=1` and the runner's `NODE_TEST_CONTEXT`.
  - Electron 43.4 runs Node 24.18 on V8 15, while the host runner here is Node 22.22 on V8 12.
  - So the child's results reach the parent as binary V8-serialised events dumped into TAP comments, and a failure cannot be read.
- **How I verified it:**
  - **Probe** (`logs/` only; not part of the patch): a file that re-runs itself under the real Electron binary with one failing test.
    - With the context inherited, the output was raw `test:enqueue`/`test:fail` bytes.
    - With the context stripped, it printed `✖ inner FAILING test`.
    - With plain `node` as the child (same V8), both variants are readable, so the bug only shows under Electron.
  - **Real files, before:** I ran all six with `node --test`. Four printed binary event streams (`logs/06-before-*.txt`, binary rendered with `cat -v`).
  - **Real files, after:** none of the six prints a binary event, and every failure is readable (`logs/06-after-*.txt`).
  - These suites still fail in this container, and for an unrelated reason: `better-sqlite3` cannot be built for Electron because the Electron headers download is blocked (see Environment). I could not run them to green, so I cannot say whether they pass once the native module exists.
- **Fix:**
  - The six files move onto `requireElectronRuntime(fileURLToPath(import.meta.url), '<same flag>')`, which deletes `NODE_TEST_CONTEXT`. Their `execFileSync` import is dropped where it is no longer used.
  - A new guard, `scripts/test-electron-rerun-test-context.mjs`, fails on any `node:test` suite that re-runs itself under Electron without stripping the variable.
    - Before the patch it lists exactly these six files (`logs/06-guard-before.txt`).
    - After, it passes (`logs/06-guard-after.txt`).
    - It needs no Electron, so it runs headless.
- **Two of the eight listed files are wrong, so I skipped them:**
  - `scripts/test-settings-background-inspection.mjs` never re-runs under Electron. It runs in-process with `installRuntimeHooks`.
  - `scripts/test-custom-provider.mjs` launches Electron on a generated `child.cjs` that never loads `node:test`, so the inherited variable has no effect. `requireElectronRuntime` re-runs the calling script itself, so it does not fit this case either.
  - `scripts/test-vector-scan-worker.mjs` already strips the variable.

---

## Suspected, not verified

1. **`references()` throws away an OPSIN answer when the PubChem part throws.** In `chemistryIdentity.ts:235-262`, the name path calls OPSIN first and then PubChem. A throw from the PubChem `readJSON` loses the OPSIN candidate, and `resolveNameReferences` returns `[]`. This happens on a pacer give-up, a refusal or the breaker.
   - Today `verify-route` labels don't go through `breakerFetch` (known item a), so this does not happen yet.
   - Once (a) routes them through the pacer, finding 1 would turn every label in a throttled window into "unchecked" instead of falling back to OPSIN.
   - Traced in the code only; not exercised.
2. **`routedFetch` ignores the request signal** (`deps.ts:23`, `void init`). A slow host fetch is not cancelled by `readJSON`'s 10 s timeout or by the turn's abort until the host's own timeout.
   - Patch 01 covers the pacer wait, not the network round trip.
   - Traced only.
3. **`productStereoChoices` drops a non-zero Python exit without logging it** (`worker.ts:727`). It has the same logging gap as finding 2, so stereo counts silently fall back.
   - Traced only.
4. **`groupSalts` (patch 02) matches ions by exact SMILES string.** An ion written `[Na+]` on one side and `[Na+1]` on the other would not count as a spectator, so the salt would be split.
   - Not tested.
5. **Splitting reacting ions (patch 02) adds species to a drawing,** so a scheme near `reactionSmilesSpecies`'s 12-species cap could cross it.
   - Not tested.
6. **A pacer turn reserved by a caller that then aborts still moves `nextAt` back by one interval.** It wastes at most one slot of at most 8 s.
   - Not measured.

## Environment and what could not run

- **Python:** a venv with rdkit, numpy, faiss-cpu, zstandard and rdchiral, installed from PyPI. `CHEMISTRY_TEST_PYTHON` points at it.
- **Downloads:** no dataset was downloaded or committed, and no request went to the PubChem REST API or EBI. All plugin tests use the stubbed host network.
- **nodus `npm ci`:** fails here with a 403 on `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`.
  - I installed with `xlsx` temporarily removed from `package.json` and the lockfile, using `--ignore-scripts`, then restored both files.
  - That leaves two `typecheck` errors, both in `electron/researchAttachments.ts`, on the baseline and with the patches applied.
- **Electron:** the binary (43.4.0) downloaded, but `electron-rebuild` for `better-sqlite3` failed with a 403 on the Electron headers. So no suite that opens a real database under Electron can pass here. Finding 9 lists what did run.
- **Incident in my own session:**
  - A stray `rm -f /dev/null` in one of my commands deleted the container's `/dev/null`.
  - Restoring it with `mknod` was refused by the session's permission policy.
  - Afterwards I ran git with stdin redirected from an empty file, and the test results were unaffected.
  - The repositories were not touched by this, but this container has no `/dev/null` until it is recreated or the session restarts.
