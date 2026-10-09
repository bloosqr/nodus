# Chemistry Studio route check: audit results

Area: the whole `plugins/chemistry-studio` plugin, route audit first. Code: branch `audit/2026-10-09` of
`bloosqr/nodus-research-skill-marketplace` (fe3b2d6) and `bloosqr/nodus` (a828b6b3).

## Summary

`verify-route` was profiled on synthetic routes of 2, 6, 14 and 20 steps. The routes use common reagents, name labels, salts and 53-heavy-atom intermediates. Every network dependency was stubbed with a fixed 300 ms round trip. On those routes, a 20-step call takes 40.6 s, which matches the owner's ~37 s. The time goes to three places, one after another:

| where | 20-step time | why |
|---|---|---|
| label name look-ups | ~28 s | 93 requests (OPSIN, then two PubChem) for 31 names, sent **one at a time**, never from the local mirror (known item (a)) |
| Python stereo enumeration | 6.4 s | a 3D embedding for every product and reactant, including those with nothing left to enumerate |
| the audit in the RDKit subworker | 6.2 s | 289 full *drawing* validations (two 2D layouts, layout penalty, SVG) for 32 distinct species |

The balancer and its coefficient search cost little on ordinary steps. On an unbalanced step with many species, they cost 0.5 s, because the 12⁴ search runs even when it cannot succeed. The single `inspectBatch`/route round trip per call costs about 0.55 s to load RDKit's WebAssembly; that is not where the time goes.

With patches 01–08 applied together (combined plugin suite: 166 pass, 0 fail, 1 skip; `logs/plugin-tests-all-patches-combined.log`):

| 20-step route, 300 ms per round trip | base | patched |
|---|---|---|
| no local mirror | 40.6 s | 13.3 s (paced at PubChem's 5 requests/s) |
| local PubChem mirror (synthetic) | 40.3 s | 3.0 s (31 OPSIN requests remain; a local OPSIN removes them) |
| fix round with one step changed, in a new worker | 40.3 s | 0.63 s |

All lengths are in `logs/verify-route-timings.log`. Each row is a call with columns (steps, wall ms, audit ms, Python ms, requests, continuous).

**Effect on an answer.** Route check is 32% of an answer's wall time, and verify-route at ~37 s per call is its bulk, so cutting it by 67–93% (and a re-check by 98%) should save roughly 21–30% of the whole answer. That moves the LLM's share from about 15% to about 19–21%. This is an estimate: it assumes verify-route dominates the route-check phase, as the owner's 37 s figure implies. Getting past 50% also needs the evidence and retrieval phases, which are outside this area.

**Correctness.** The stereo-inversion check refused a valid SN2 next to an untouched stereocentre, and it passed a step whose centre really is inverted. Route messages named the wrong species whenever the labels were not in reaction order. Atom indices in those messages pointed into RDKit's canonical string, not into the string the author wrote. A failing OPSIN or PubChem request threw away the other source's answer. Reviewing the rest of the plugin found 17 more verified bugs (10–26): in name resolution, the balancer, the scene and ChemFig export (silently dropped isotopes and radicals under a "validated" label, a TeX hang, a process crash), the legacy view, and the Python worker (no stereo deadline, a route search that ignores its budget, the local references cut at 256).

Patches are unified diffs against `audit/2026-10-09` unless their first line says otherwise. Stacked patches, each because it edits the same function as the one before it:
- 05 applies after 04
- 06 and 10 apply after 01
- 09 applies after 03
- 11 and 21 apply after 07
- 15 applies after 08

Patch 02 is for the nodus repository; all others are for the marketplace repository. No shared/ file listed in `GENERATED` was edited, so `npm run build:server-shared` does not need to be rerun.

## How it was measured

- A stub host (`network.fetch` answers PubChem and OPSIN from the route's own name map after a fixed latency; no request leaves the machine). The subworker runs `auditRoute` in-process, as the plugin's own test does. Python runs for real (`reactions_worker.py` in a venv with rdkit 2026.03, numpy, faiss-cpu, zstandard, rdchiral).
- The routes repeat acid → methyl ester (H2SO4) → alcohol (H2/Ru) → bromide (HBr) → nitrile (NaCN in DMSO, NaBr out) → acid one carbon longer (H2O, HCl, NH4Cl out). The salts are written as ions and labelled once.
- Heads are phenyl, or a 53-heavy-atom tert-butyl oligoaryl ether; each has a stereo variant. The synthetic local mirror is a `pubchem.sqlite` with the tables `_pubchem_mirror` reads, holding the route's names. Nothing was downloaded.
- CPU profiles came from `node --cpu-prof`; validator call counts came from an instrumented build.
- Tests:
  - plugin: `node --test plugins/chemistry-studio/test/*.test.mjs` with `CHEMISTRY_TEST_PYTHON` set. Baseline: 157 pass, 1 skip (the local-OPSIN test needs an OPSIN jar).
  - nodus: `node --test scripts/test-route-local-references.mjs scripts/test-molecule-inspection*.mjs`, 135 pass.
  - nodus `npm ci` could not complete here: `xlsx` is fetched from cdn.sheetjs.com, which this environment's network policy blocks (403). Dependencies were installed in a scratch copy without that one package. `npm run typecheck` then reports only the two errors that come from the missing `xlsx` (`electron/researchAttachments.ts`), none from the patch (`logs/nodus-typecheck-patched.log`).
  - Electron-only tests were not run.

---

## Findings (most severe first)

### 01 · speed + bug · route label look-ups bypass the mirror and the pacer, and run one at a time (known item (a): the patch)
**Where:**
- `plugins/chemistry-studio/src/worker.ts:676-709` (`resolveRouteLabels`)
- `src/engine/chemistryIdentity.ts:235-264` (`references`)
- `src/worker.ts:130` (`compile`)
- `capabilities/chemistry/capability.json` (`compile`, `verify-route` schemas)

**What goes wrong:**
- **Label pass:** every uncached label name goes through `resolveNameReferences` → `references()` with `chemistryDependencies()`, so it skips the local mirror, local OPSIN, `localOnly` and the PubChem pacer. It also does this one name at a time: on a 20-step route, 31 names cost 93 sequential round trips (≈28 s at 300 ms).
- **`compile`:** takes the same bare dependencies.
- **Two more defects in `references()`**, found while wiring it up:
  - A thrown OPSIN request (EBI down, or refused on a `localOnly` run) throws past the PubChem look-up, so every name comes back unchecked.
  - A thrown PubChem request (breaker open, 503, `localOnly`) throws away the OPSIN answer already found. That is the opposite of the breaker's own comment, which says a refusal should "fall through to the OPSIN fallback". With the pacer and breaker wired in, any refusal would have made every label unchecked.

**Verified by:**
- Profile: `logs/verify-route-timings.log`.
- Test `the route label check and compile ask the local references first, once per batch`. It runs one route with four labels and `localOnly`, then a `compile` of a named species. It asserts one Python call carrying all four names, mirror and local-OPSIN answers used, the unknown name unchecked, and zero network requests. It fails before the patch and passes after (`logs/regression-before-after.log`).
- Suite after: 158 pass, 1 skip.

**Patch:** `01-label-references-local-and-paced.patch`
- One `referenceDependencies(input, names, smiles)` helper gives `resolve-names`, `resolve-structure`, `compile` and the label pass the same dependencies: one batched local call (mirror + local OPSIN), then `breakerFetch` (paced), or `localOnlyFetch`.
- The label pass collects the distinct uncached names in route order (the `maxLabelsTotal` cap keeps its meaning), makes one local call for all of them, then resolves the rest four at a time.
- `references()` reads `opsinLocal` and `pubchemMirror` first. An unreachable source counts as no answer from that source, as in `resolveSpeciesName`; a CID given by number still fails on its own.
- `pubchemDir`, `opsinDir` and `localOnly` are declared in the `compile` and `verify-route` schemas. capability.json was edited by text insertion, not re-serialised.

**Saving, 20 steps at 300 ms:**
- 40.5 → 25.3 s with no mirror. Concurrency overlaps the OPSIN requests with the paced PubChem ones; the floor is the pacer's 62 × 200 ms.
- 40.5 → 15.2 s with the mirror. The remaining 31 OPSIN requests disappear with a local OPSIN.
- Caveat: on a zero-latency network with no mirror, the pacer's 200 ms spacing makes the label pass about as slow as today (12.5 s vs 12.7 s). That is the cost of obeying PubChem's limit.

### 02 · speed · the app never sends the mirror directories to verify-route or compile (known item (a), nodus side)
**Where:**
- `nodus/electron/ai/moleculeInspection.ts:257-274` (`invokeRoute`)
- `:726` (`drawReaction`)

**What goes wrong:** `mirrorInput()` is applied only to `resolve-names` and `resolve-structure`. Even with patch 01, the route check would never learn where the mirror is.

**Verified by:** new `scripts/test-route-local-references.mjs`.
- `the route check is sent the local reference directories when the package reads them`: fails before, passes after.
- `an older package that does not declare them is never sent them`: passes both, as a guard.
- The existing `test-molecule-inspection*.mjs` still pass (135 in total).

**Patch:** `02-nodus-send-local-reference-dirs.patch`. It adds `...mirrorInput(provider, ROUTE_TOOL)` and `...mirrorInput(provider, COMPILE_TOOL)`, schema-gated as for the other tools.

**Saving:** this is what makes 01's mirror path happen: 13.3 s → 3.0 s per 20-step call with all patches.

### 03 · speed + bug · the route audit draws every species, again on every mention; reported atom indices point into the wrong string
**Where:**
- `src/engine/chemistryRouteAudit.ts:30-41` (`summarize`), called from about 10 sites
- `src/engine/chemistryValidationCore.ts:426-509`

**What goes wrong:**
- **Speed:** each `summarize()` calls `validateChemicalReferences({ inspect: true })`, which runs the whole drawing path: OpenChemLib and RDKit 2D layouts, an O(n²) `layoutPenalty` on both, a scene and an SVG render. Nothing is memoised, so a species is summarised on every step that names it, again for each label, the label's candidates, the carriers and the target.
  - Counts: 289 calls for 32 distinct species on 20 steps, and 93.5% of the audit's CPU.
  - Per 53-atom species: about 80 ms, of which the RDKit layout is 27 ms, the OCL CIP 24 ms, the penalties 6 ms and the SVG 6 ms.
- **Bug:** `cipCentres` atom indices come from the chosen layout's molfile, usually RDKit's canonical order. The message says "count from zero in the structure as the application parsed it", and the code comment says the index "locates it in the very string the author wrote".
  - Example: for `N#CC[C@H](C)c1ccccc1` the report says atom 1; the centre is atom 3 of what the author wrote.
  - Example: for the large route the report said atom 49 for a centre that is atom 1.

**Verified by:**
- Call counting and `--cpu-prof`.
- A probe of indices.
- Equivalence: summary-only vs full inspection on all 493 SMILES literals in the test file. 402 are identical (composition key order aside); 91 fail with identical messages; 0 mismatch. Whole-audit JSON for 16 routes is identical, base vs patched, apart from the indices.
- Tests `the route check reads each species once…`, a guard that passes both, and `a stereocentre the route check names is numbered in the string the author wrote`, which fails before (atom 4) and passes after.

**Patch:** `03-route-audit-summarise-once.patch`
- A per-audit `Map<smiles, Promise<summary>>`; each caller gets a shallow copy, because the audit writes coefficients and names onto summaries.
- A `summaryOnly` inspection that keeps every refusal of the full path, including "no layout round-trips", which is now tested on OCL first and RDKit only if needed.
- It reads the summary from the parsed reference, so indices follow the author's string. It makes no second layout, penalty, scene or SVG.

**Saving:** audit 6.1 s → 0.42 s on 20 steps (0.75 s → 0.10 s on 2). On the owner's 37 s calls with large intermediates, that is ~5–6 s per call.

### 04 · bug · route messages name the wrong species when labels are not in reaction order
**Where:**
- `chemistryRouteAudit.ts:113-119` (`namesFor`)
- `:169-178` (inversion message)
- `:648-649` (`refiledReactant`)

**What goes wrong:** names are matched to summaries by position. `namesFor()` lists labels in label order. Summaries are in reaction-string order, with grouped salts moved and unlabelled species interleaved.
- **Labels in another order:** step `CCO.CC(=O)O.OS(=O)(=O)O>>CCOC(C)=O.O` with labels sulfuric acid, ethanol, acetic acid. The report tells the author "acetic acid was listed under Reactants … the check treated it as a condition", but the refiled species is H2SO4.
- **An unlabelled reactant:** the inversion message names "acetic acid" for the chloroester's centre.
- **The other messages** (side flip, agent role) show only a formula, not the name the model wrote.

**Verified by:**
- `probe-names.mjs`.
- Test `a route message names the species the author meant, whatever order the labels came in`: fails before, passes after.
- Suite: 158 pass.

**Patch:** `04-route-messages-name-by-structure.patch`
- A `namerFor(stepLabels)` matches a summary to the label written beside the same SMILES; a grouped salt's input is its declared SMILES, so it matches too.
- The side-flip and agent-role hints now read `"water (H2O)"`, the author's name with the formula.

### 05 · bug · the stereo-inversion check compares CIP letters, so it refuses correct steps and passes inverted ones
**Where:** `chemistryRouteAudit.ts:155-184` (`invertedConfiguration`)

**What goes wrong:** the check compares the multiset of R/S letters on each side. A step that changes a group two bonds from an untouched centre can swap CIP ranks.
- **False refusal:** `BrC[C@@H](C)c1ccccc1 + NaCN → N#CC[C@@H](C)c1ccccc1` keeps its configuration. CH2Br outranks phenyl, but CH2CN does not, so the letter goes S → R and the step is refused as "inverts a stereocentre".
- **Missed inversion:** the same step with the product written `[C@H]`, a real inversion, keeps the letter S and passes.
- **Cost:** on the large synthetic stereo route the check refused step 2 (an ester reduction next to the centre), so a valid 20-step route never verified. Each such refusal costs a fix round, that is an LLM call plus a re-check, for nothing.

**Verified by:**
- `probe-cipflip.mjs`: both directions are wrong on base and right after.
- A stress test over random RDKit writings of 12 molecules (129 pairs: same molecule must pass, inverted must be caught): base 123/129, patched 123/129. The 6 misses are the same on both: flipping one tropane bridgehead also removes the C3 centre, so neither version can compare them.
- Test `a stereocentre is compared through its branches, not by its CIP letter`, covering the SN2, the real inversion, an ester reduction, a rewritten SMILES and a tropine/pseudotropine epimer: fails before, passes after.
- Two older assertions on the message wording were updated. Suite: 159 pass.

**Patch:** `05-stereo-inversion-by-correspondence.patch` (apply after 04)
- Each specified centre on the left is matched to one on the right through its branches. A branch is labelled by a tree unfolding that excludes the centre, to depth 6. Branches agreeing at least two bonds out are placed one to one; an implicit H is an H; the one branch left over must start with the same element.
- RDKit's own `cw`/`ccw` tags (from `get_json`, relative to bond order), together with the permutation parity, then decide whether the arrangement survived.
- An ambiguous centre is not judged by geometry. Such centres (pseudo-asymmetric ring carbons) are still compared by letter, among themselves only, so the tropine epimer stays caught.
- The message names the centre in the author's string: "atom 2 of … (S) comes out as atom 3 of … (S) with the opposite configuration".

### 06 · speed · a fix round in a new worker looks every label name up again
**Where:** `src/worker.ts:64-66`. `referenceCache` is per worker, and workers die between phases (known item (e)).

**What goes wrong:** with all other patches, a re-check of a 20-step route with one step changed costs 0.66 s in the same worker but 13.2 s in a new one; 12.5 s of that is name look-ups already answered one round earlier. Without patch 01 the gap is 12.5 s vs 40.3 s.

**Verified by:**
- `fix-round.mjs` timings.
- Test `a fix round in a new worker reuses the label answers the last check found`, with two workers over one storage: fails before (on 01), passes after. Suite: 159 pass.

**Patch:** `06-route-label-references-kept-across-workers.patch` (apply after 01)
- Label answers that found a structure are kept for 24 h in `host().storage.cache`. That storage is on disk under the plugin's cache tree (`electron/capabilities/hostServices.ts:55`) and outlives the worker.
- One key, at most 2000 entries, oldest first out, well inside the 4 MB quota. Read and write failures are ignored.
- Negative answers are never kept, so a failed look-up is retried. This does not fix (e); it makes this one cache survive it.

**Saving:** a fix-round re-check of 20 steps: 13.2 s → 0.63 s (with 01–07), 25.3 s → 12.4 s (with 01 only).

### 07 · speed · the stereo enumeration embeds structures that have nothing to enumerate, and waits for the label look-ups
**Where:**
- `python/reactions_worker.py:1063-1108` (`_stereo_choices`)
- `src/worker.ts:753-756`

**What goes wrong:**
- For each of up to 48 species, `_stereo_choices` runs `EnumerateStereoisomers` and a two-seed ETKDG embedding per isomer, even when nothing is unassigned. In that case the answer is `{open: 0}` whether or not the one isomer embeds: 0.15 s at 50 heavy atoms, and 1.2 s for strychnine (agent measurement).
- The call reads only the steps, but it starts after the label look-ups finish.

**Verified by:**
- Equivalence: identical answers on 103 species (route species, tropinone, camphor, tartaric acid, E/Z alkenes, cages). The Python agent independently found 40/40 identical.
- Tests:
  - `the stereo enumeration runs while the route labels are looked up`: fails before, passes after.
  - `…answers a fully assigned structure without building it` (needs Python): a guard on the known answers.
- Suite: 159 pass.

**Patch:** `07-route-stereo-fast-path.patch`. `GetStereoisomerCount(...) <= 1` returns `{open: 0}` before any embedding, and `verifySynthesisRoute` starts the enumeration before the label pass and awaits it after.

**Saving:**
- 16.7 s → 3.6 s over the 103 species.
- 6.4 s → 0.3 s on the 20-step route, and that 0.3 s now overlaps the look-ups.

### 08 · speed · the coefficient search runs 12⁴ fraction combinations even past the dimension it can solve
**Where:** `src/engine/chemistryReaction.ts:248-270` (`smallestPositiveEquation`)

**What goes wrong:**
- Past `SEARCH_DIMENSION_LIMIT` (4), every combination leaves an exact zero, so all 20 736 candidates are refused. The code's own comment says so, yet the loop still runs, at 30–90 ms per call in BigInt fraction arithmetic.
- An unbalanced step calls the balancer again for every species `agentsThatBalance`, `sideFlipThatBalances` and `agentRoleThatBalances` try moving. One 9-species oxidation step with every plausible byproduct cost 540 ms of audit.

**Verified by:**
- `bench-balance.mjs`.
- Equivalence: `balanceReaction` base vs patched on 3000 random species sets (2–4 elements, 4–10 species, some ions): 3000/3000 identical results and messages, 2.09 s → 0.40 s.
- Test `the bounded coefficient search keeps its answers…` is a behaviour guard: it passes before and after. The speed is not asserted, because timing tests are flaky; it is in the logs.

**Patch:** `08-balancer-integer-search.patch`
- Return null at once past the limit.
- Search with one common denominator in exact JavaScript integers, behind a bound check; otherwise fall back to the old fraction search.

**Saving:** the 9-species step 540 → 88 ms; the 8-species hydrocarbon step 504 → 263 ms. That is about 0.1–0.5 s per unbalanced many-species step, in every fix round.

### 09 · speed · resolve-names draws every name it only needs to canonicalise
**Where:**
- `src/worker.ts:505-526` (`canonicalizeResolutions`) and `:654-665` (`attachCanonical`)
- `src/validator.ts:18-35`

**What goes wrong:** both read only `graph.canonicalSmiles`, but the batch inspector runs the full drawing validation for each SMILES.

**Verified by:**
- `bench-batch.mjs`: a route's 32 names at about 50 heavy atoms take 2134 ms → 386 ms.
- Test `resolve-names canonicalises without drawing, and the inspector still returns a full graph`: fails before, passes after. Suite after 03+09: 160 pass.

**Patch:** `09-canonicalise-without-drawing.patch` (apply after 03).
- `inspectBatch(smiles, signal, { canonicalOnly })`. The validator's batch then uses the `summaryOnly` read from 03.
- The `inspect` tool still gets the full graph, because its dossier needs the atom table.

**Saving:** about 1.7 s per resolve-names call on a 20-step route with large intermediates. That call is part of the route check phase.

---

Findings 10–26 come from three review agents I ran in parallel on the rest of the plugin: identity and balancer, scene/ChemFig/view, and the Python worker. Each found its bugs with a probe against synthetic data and no network. I re-ran the key probes on unmodified `audit/2026-10-09` myself, and every one reproduced:
- identity: `probe-smallest2`, `probe-nullreason`, `probe-labels`, `probe-timeout`
- Python: `opsin_probe`, `pubchem_probe`, `compat_probe`
- scene: `p4`, `p5`, `p27`, `p9`, `p19`

Every patch below has a regression test appended to `test/chemistry.test.mjs`. That test fails on its base and passes with the patch, and the full suite passes with each patch applied (`logs/regression-before-after-10-26.log`). Patches 12–14 and 22–24 append tests at the same end of the file, so applying several of them means joining those test blocks by hand. The code changes do not overlap, except 21 with 22/23 in `_pubchem_mirror`/`_opsin_local`, which `git apply -3` merges.

### 10 · bug · the label check compares a name against a structure resolve-names had already corrected
**Where:** `src/worker.ts:701` (`resolveRouteLabels`)

**What goes wrong:** the label pass uses raw `resolveNameReferences` candidates, without resolve-names' fix-ups (`refuseUnbalancedSalts`, `dihydrogenForHydrogen`, `covalentForIonicOxide`). Refused names are not cached either.
- resolve-names refuses "sodium diethyl propanedioate" (record `CCOC(=O)CC(=O)OCC.[Na+]`) and asks for the SMILES. When the author supplies `CCOC(=O)[CH-]C(=O)OCC.[Na+]`, verify-route reports "the name … denotes a different structure".
- In a new worker, "chromium trioxide" written `O=[Cr](=O)=O` is flagged too, because the raw candidate is `[Cr+6].[O-2]…`.
- Each such false refusal costs a fix round.

**Verified by:** `probe-labels.mjs`, and test `the route label check applies the fix-ups resolve-names applies to the same name` (fail → pass).

**Patch:** `10-label-check-fixups.patch` (apply after 01). `fixedCandidates()` runs the three fix-ups on the label candidates and drops refused ones, so the name is left unchecked rather than called wrong.

### 11 · speed + bug · the stereo enumeration has no deadline, so one cage molecule loses every species' answer
**Where:**
- `python/reactions_worker.py:1063-1108`, `:1575-1582`
- caller `src/worker.ts:726` (60 s)

**What goes wrong:**
- With no descriptors, one enumeration takes 54.5 s for strychnine, 47.5 s for docetaxel and 29.8 s for artemisinin.
- `["CCO", strychnine, quinine]` (both without descriptors) runs past the TS 60 s timeout. The TS side then returns `{}`, so all 48 species lose their answers and the audit falls back to RDKit's counts. Meanwhile the route check has waited 60 s.

**Verified by:** `stereo_timeout_probe.sh` (exit 124 at 60 s), and test `the stereo enumeration answers within its budget, and nulls only what it could not reach` (fail → pass). Suite after 07+11: 160 pass.

**Patch:** `11-stereo-enumeration-deadline.patch` (apply after 07). A 40 s request budget is checked before each embedding. Species not reached come back `null`, which the TS type already allows; assigned species are still answered.

**Saving:** caps the stereo pass at 40 s where it used to time out at 60 s, and keeps the answers that were computed.

### 12 · bug · a scene molfile drops isotopes and radicals, and a "validated" mechanism or ChemFig loses them
**Where:** `src/engine/chemistryScene.ts:8-20, 44-47` (`sceneFromMolfile`, `sceneMolfile`)

**What goes wrong:**
- **Isotopes:** the `M  ISO`/`M  CHG` lines lack the V2000 field spaces. RDKit accepts the CHG line and silently ignores the ISO line, so `[13CH3]O` round-trips to `CO`.
  - An electron-flow resonance of `CC(=O)[18O-]` returns `chemfig.status: 'validated'`, and its checks claim "isotope conservation", but its products are unlabelled `CC(=O)[O-]`.
  - Every isotopically labelled species gets `unsupported` ChemFig.
- **Radicals:** a radical is never written (no `M  RAD`), so `[CH2]C(=O)[O-]` becomes a closed shell and the mechanism module's radical refusal never fires.

**Verified by:** `p4`, `p5`, `p27`, `p1`. The two tests fail before (`unsupported`; "Missing expected rejection") and pass after.

**Patch:** `12-scene-molfile-isotope-radical.patch`. It corrects the field spacing, carries `radical` on a scene atom, and writes `M  RAD`.

### 13 · robustness · a branch nested 32 deep hangs TeX; the drawing is lost and later exports in the process fail
**Where:**
- `src/engine/chemistryScene.ts:165-178` (`exportSceneChemfig`)
- `src/engine/chemistry.ts:234, 252`

**What goes wrong:**
- Every tree edge becomes a nested `( … )` branch. node-tikzjax never returns at depth ≥ 32: a 31-atom chain compiles in 3.3 s and a 32-atom chain times out at 15 s. A 35-heavy-atom ether chain reaches depth 34.
- The request takes 16.8 s, more than the 15 s validate budget, so the host kills the subworker and the drawing is lost.
- In-process, `compilerTimedOut` then refuses even `CCO`.

**Verified by:** `p23`, `p24`, `p25`. The test fails before ("Chemfig compilation timed out") and passes after.

**Patch:** `13-chemfig-branch-depth.patch`. Past depth 30 the export is refused as `unsupported` (0.65 s), and later exports still work.

### 14 · robustness · a ChemFig line over ~5000 characters crashes the validator process
**Where:** `src/engine/chemistry.ts:247`

**What goes wrong:** lines are split only at `\chemfig`, and one molecule can reach 7500 characters. node-tikzjax throws an uncaught `RangeError: offset is out of bounds` from a timer, and the process exits 1 without posting a result. Seen with 128 atoms (5016 characters) and a branched 163-atom molecule.

**Verified by:** `p11`, `p26`. The test runs the validator in a child process: on base the child exits 1; after the patch it returns `unsupported`.

**Patch:** `14-tex-line-buffer.patch`. A line over 4900 characters is refused before compiling.

### 15 · bug · a two-direction balance needing a coefficient above 12 is called ambiguous, depending on species order; a balance past the ceiling is blamed on a missing reagent
**Where:** `src/engine/chemistryReaction.ts:250, 269, 535, 537-603`

**What goes wrong:**
- The multipliers are the free columns' own coefficients, capped at 12, while `MAX_COEFFICIENT` is 30. A search that finds nothing returns `null`, the same value as a tie.
- C12H26 + O2 → CO2 + CO + H2O in the order `[C12H26, O2, CO2, CO, H2O]` throws "admit more than one balanced equation". The order `[…, H2O, CO2, CO]` solves `1,13,13,1,11`.
- C16H34 + O2 → CO2 + H2O balances at 2:49:32:34, but the message is "cannot be balanced … add the missing reagent".

**Verified by:** `probe-smallest2`, `probe-nullreason`. Two tests: fail → pass. Suite after 08+15: 160 pass.

**Patch:** `15-balancer-search-ceiling.patch` (apply after 08; it keeps 08's integer search and its early return).
- The search goes up to 30 for one or two free directions (900 combinations) and keeps 12 for three or four.
- `'tie'` is separated from "none found", which gets its own message.
- An over-ceiling unique balance is reported with its coefficients.

### 16 · bug · reference requests ignore their abort signal, so the 10 s timeout and the user's cancel do nothing
**Where:**
- `src/deps.ts:23` (`void init;`)
- `src/worker.ts:583, 635`

**What goes wrong:**
- `readJSON` arms a 10 s timeout and forwards the turn's signal, but `routedFetch` awaits the host fetch without either. With 14 s replies a name resolves after 28.9 s with no timeout.
- After an abort at 1 s (6 s replies), the call returns after 6.06 s with a normal artifact marking the name `unresolved`, instead of throwing.
- This is distinct from known item (b), which concerns the pacer's own waits.

**Verified by:** `probe-timeout.mjs`. The test fails before (it times out with the fetch still hanging) and passes after.

**Patch:** `16-routed-fetch-abort.patch`. It races the host fetch against `init.signal`, and `resolveNames`/`nameStructures` re-check the signal after their pools. Note: a single PubChem reply slower than 10 s now opens the per-call breaker, as the breaker's comment intends.

### 17 · bug · the local mirror and local OPSIN answer only 256 of the 512 names the tools may send
**Where:** `python/reactions_worker.py:1499, 1513, 1539, 1549`

**What goes wrong:** `maxNames` reaches 512 at a context window of about 320 k tokens or more. Names 257–512 then go to the network, or come back unresolved on a `localOnly` run.

**Verified by:** `pubchem_probe.py` (512 sent, 256 answered). Test: fail (expected 512, got 256) → pass.

**Patch:** `17-local-references-512.patch`. A single `LOCAL_REFERENCE_LIMIT = 512`.

### 18 · robustness · a mirror missing an optional table, or a corrupt mirror, fails the whole local call
**Where:** `python/reactions_worker.py:1507, 1522-1523`

**What goes wrong:** a mirror with no `formula` table raises `sqlite3.OperationalError`, and a corrupt file raises `DatabaseError`. The process exits 1, so the TypeScript side discards the local OPSIN answers from the same call as well.

**Verified by:** `pubchem_probe.py`. Test: worker exited 1 → pass.

**Patch:** `18-pubchem-mirror-optional-tables.patch`. Optional tables are read through a helper that tolerates their absence; a corrupt file reports `available: false`.

### 19 · bug · a local OPSIN reply one line short is accepted, and the last name is called "not a systematic name"
**Where:** `python/reactions_worker.py:1545-1546`

**What goes wrong:**
- The trailing `""` from `split("\n")` hides a missing last line, so the last name gets `{'status': ''}`. TypeScript reads that as a local answer and never asks EBI.
- A name containing a tab has its message cut at the tab.

**Verified by:** `opsin_probe.py`. Test: fail → pass.

**Patch:** `19-opsin-reply-line-count.patch`. It drops the trailing empty element, requires an exact line count, and uses `split("\t", 3)`.

### 20 · speed + bug · the route search ignores its budget inside each expansion, and reports the budget as its time
**Where:** `python/reactions_worker.py:944, 1060`

**What goes wrong:**
- `lookup()` calls `_disconnect(...)` without `budget_seconds`. On a synthetic 40 000-row index, a 2 s budget took 256 s of wall time and still reported `seconds=2.0`.
- That is past the TS timeout of budget + 60 s, so every route found is lost. This is in the evidence-gathering phase.

**Verified by:** `route_budget_probe.py`. The test (1 s budget) fails before (6.6 s) and passes after.

**Patch:** `20-route-search-budget.patch`. It passes the remaining budget to each expansion and measures `seconds` from the start.

**Saving:** up to the whole timeout (budget + 60 s) on an index whose expansions are slow.

### 21 · speed · the stereo enumeration builds a 64-isomer sample only to answer null
**Where:** `python/reactions_worker.py:1092-1108`

**What goes wrong:** when the count of unassigned combinations is over 64, `EnumerateStereoisomers` still embeds a random sample of 64, and the function then returns `None` by its own rule. That costs 47.5 s for docetaxel and 9 s for cholesterol, for `null`.
- One answer changes: artemisinin without descriptors goes from open 6 to null. A full enumeration finds 64 buildable isomers of 128, which the function's own "≥ 64 → None" rule makes null; the old value came from the sample.

**Verified by:** `stereo_proposed_probe.py`, `stereo_truncation_probe.py`. Test: fail (about 39 s, open 6) → pass. Suite after 07+21: 160 pass.

**Patch:** `21-stereo-sampled-none.patch` (apply after 07). Return `None` at once when `GetStereoisomerCount > 64`.

### 22 · bug · an arrow on a ring-closure bond cannot be drawn, so a valid mechanism is refused
**Where:** `src/engine/chemistryScene.ts:162`, `src/engine/chemistryRuleRender.ts:12`

**What goes wrong:** the ring-closing bond is exported as `?[rN,order]`, which has no `@{bN}` anchor. Hydroxide opening 2-methyloxirane at the CH2 passes the electron ledger (`CC(O)C[O-]`) and is then refused with `Unknown electron-flow anchor: m1b3`.

**Verified by:** `p19.cjs`. Test: fail → pass.

**Patch:** `22-ring-closure-arrow-anchor.patch`. Bonds that carry an arrow are ranked into the spanning tree, after stereo bonds.

### 23 · bug · the lone-pairs depiction leaves out electrons and is still labelled verified
**Where:** `src/engine/chemistryScene.ts:96, 105` (`VALENCE_ELECTRONS`, `assignLonePairs`)

**What goes wrong:** Se, Te, As, Sb, Ge, Sn, Xe and the s-block and Al-group elements are missing from the table, and odd counts are rounded down. `[SeH2]` draws 0 lone-pair dots (fully verified), `[Xe](F)F` 12 dots instead of 18, and `[CH3]` drops its radical electron.

**Verified by:** `p20.cjs`. Test: 0 pairs on Se → pass.

**Patch:** `23-lone-pairs-main-group.patch`. It extends the table to the main group and draws an unpaired electron.

### 24 · bug · a legacy document renders a "Verified structure" badge for any status, and malformed payloads throw
**Where:** `src/view.ts:21` (`documentView`, reached from `renderLegacyResult`)

**What goes wrong:** a payload with `status: 'bogus'` or `needs-clarification` gets `{label: 'Verified structure', tone: 'success'}` over its SVG. `{}`, `null` and `{"species":[{"input":{}}]}` throw `TypeError` instead of `CHEMISTRY_LEGACY_UNREADABLE`.

**Verified by:** `p9.cjs`. Test: `TypeError` → pass.

**Patch:** `24-legacy-document-status.patch`. Anything but a `verified`/`partial` document with well-formed species is refused as unreadable.

### 25 · bug · the compatibility check flags standard acid deprotections as "nothing removes it"
**Where:**
- `python/reactions_worker.py:1339-1344`
- `python/compat_tables.py:311`

**What goes wrong:**
- Boc with "4 M HCl in dioxane" is classed as aqueous acid only, so it is flagged "the Boc carbamate is gone … none of the named reagents removes it".
- A ketal with "aq. HCl" or "H3O+", and a TMS ether with "1 M HCl", are flagged too.

**Verified by:** `compat_probe.py`. Test: fail → pass.

**Patch:** `25-compat-acid-deprotections.patch`
- HCl in dioxane, ether, EtOAc, MeOH or CPME counts as strong acid; "1 N HCl" stays a work-up.
- `aqueous-acid` is added to the removers of acetal, silyl ether and trityl.

### 26 · bug (low) · a reaction intent refuses coefficients the balancer itself produces
**Where:** `src/engine/chemistryIdentity.ts:137`, `skills/chemistry-studio/SKILL.md:48`

**What goes wrong:** the intent caps coefficients at 12, while the balancer and renderer allow 30. A user-written dichromate/iodide equation with 14 H+ is refused at parse time, which costs a repair round.

**Verified by:** `probe-intent-coeff.mjs`. Test: fail → pass.

**Patch:** `26-intent-coefficient-ceiling.patch`. A shared `MAX_REACTION_COEFFICIENT = 30` in `chemistryLimits.ts`, and SKILL.md now says 1–30.

---

## Suspected, not verified (or verified but not patched)

- **`verify-route` schema vs audit, step length.**
  - The schema accepts `steps` items up to 64 000 characters, and the budget-derived `maxReactionChars()` is never called. Both `auditRoute` (`chemistryRouteAudit.ts:575`) and `splitReactionSmiles` refuse anything over the fixed `MAX_REACTION_CHARS` = 16 000.
  - So with a large window, a 16–64 k-character step passes the host's schema check and is then refused by name. The refusal is visible, not silent; this was verified by code trace only.
- **Parallel steps.** After 03 the audit is 0.4 s for 20 steps, so splitting it across subworkers would save at most about 0.3 s. Each extra subworker also pays the 0.55 s RDKit WebAssembly load, and the manifest declares `subworkers.max: 1` (not enforced, known item (f)). Not worth it.
- **`agentMisplacementHint`** (`chemistryRouteAudit.ts:295, 304`) still names an Agent by formula, not by the author's name, because it is reached from inside `stepBalance`. This is the same class as 04, but it was left out because threading the names through costs more code than it is worth.
- **`netColumnBalance`** (`chemistryReaction.ts:467`) can write coefficients up to 61: a free value of up to 2 × 30, plus 1. Nothing re-checks them against `MAX_COEFFICIENT`.
- **`smallestPositiveEquation`** at dimension 3 or 4 with a ceiling of 12 could still return a non-smallest equation, or call one unique when a tying equation lies beyond the ceiling. No case was constructed.
- **`refuseUnbalancedSalts`** would refuse a genuine charged complex that PubChem writes with dots (a diammine record, for example). Whether PubChem records such ions that way could not be checked offline.
- **`cancelledSpectators`** keys species on formula and charge, so isomers cancel as spectators. That case was verified (an isomerisation declared 2:1 is refused), but it only fires when the declared coefficients do not balance, so the route audit, which passes all 1s, is unaffected. Not patched.
- **Local mirror name look-up** uses `WHERE name = ? COLLATE NOCASE`, which cannot use a plain index. On 1 M synonyms it took 2.6 s per 48 names, against 0.00 s with a NOCASE index. The mirror builder is in neither repository, so whether its index is NOCASE is unknown.
- **OPSIN pipe encoding:** `subprocess.run(text=True)` uses the locale encoding, so a non-ASCII name on a non-UTF-8 Windows locale could lose every OPSIN answer.
- **`--check`** reports the runtime as fine without importing `drfp` or `rdchiral`.
- **Compile time of large shallow structures:** about 100 ms per atom, so species of 100–135 atoms may exceed the 15 s validate budget even after 13 and 14.
- **Legacy blocks:** a forged `chemistry-document` fence with `"status":"verified"` would still render as verified (24 only rejects malformed ones). Whether model text can reach `renderLegacyResult` depends on the host.
- **Inversion check (05) abstains** at a centre whose branches cannot be placed one to one unless the letters among such centres differ. A coupling that rewrites two branches of one centre at once (both the acyl and the amine side) is therefore not judged. The old check judged it only by letter, and unsoundly.
- **The pacer and abort** (known item (b)) still apply to every patched path: a refused PubChem now fails fast to the other source (01), but a slow one still waits.
