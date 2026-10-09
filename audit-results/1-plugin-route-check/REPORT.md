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

With patches 01–07 applied together (combined suite: 166 pass, 0 fail, 1 skip):

| 20-step route, 300 ms per round trip | base | patched |
|---|---|---|
| no local mirror | 40.6 s | 13.3 s (paced at PubChem's 5 requests/s) |
| local PubChem mirror (synthetic) | 40.3 s | 3.0 s (31 OPSIN requests remain; a local OPSIN removes them) |
| fix round with one step changed, in a new worker | 40.3 s | 0.63 s |

All lengths are in `logs/verify-route-timings.log`. Each row is a call with columns (steps, wall ms, audit ms, Python ms, requests, continuous).

**Effect on an answer.** Route check is 32% of an answer's wall time, and verify-route at ~37 s per call is its bulk, so cutting it by 67–93% (and a re-check by 98%) should save roughly 21–30% of the whole answer. That moves the LLM's share from about 15% to about 19–21%. This is an estimate: it assumes verify-route dominates the route-check phase, as the owner's 37 s figure implies. Getting past 50% also needs the evidence and retrieval phases, which are outside this area.

**Correctness.** The stereo-inversion check refused a valid SN2 next to an untouched stereocentre, and it passed a step whose centre really is inverted. Route messages named the wrong species whenever the labels were not in reaction order. Atom indices in those messages pointed into RDKit's canonical string, not into the string the author wrote. A failing OPSIN or PubChem request threw away the other source's answer. The agents' reviews of the rest of the plugin add verified bugs in name resolution, the balancer, the scene and ChemFig code, the view, and the Python worker (findings 09 onwards).

Patches are unified diffs against `audit/2026-10-09` unless the first line says otherwise; 05 applies after 04, 06 after 01. Patch 02 is for the nodus repository; all others are for the marketplace repository. No shared/ file listed in `GENERATED` was edited, so `npm run build:server-shared` does not need to be rerun.

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

AGENT_FINDINGS_PLACEHOLDER

---

## Suspected, not verified (or verified but not patched)

- **`verify-route` schema vs audit, step length.**
  - The schema accepts `steps` items up to 64 000 characters, and the budget-derived `maxReactionChars()` is never called. Both `auditRoute` (`chemistryRouteAudit.ts:575`) and `splitReactionSmiles` refuse anything over the fixed `MAX_REACTION_CHARS` = 16 000.
  - So with a large window, a 16–64 k-character step passes the host's schema check and is then refused by name. The refusal is visible, not silent; this was verified by code trace only.
- **Parallel steps.** After 03 the audit is 0.4 s for 20 steps, so splitting it across subworkers would save at most about 0.3 s. Each extra subworker also pays the 0.55 s RDKit WebAssembly load, and the manifest declares `subworkers.max: 1` (not enforced, known item (f)). Not worth it.
- **`agentMisplacementHint`** (`chemistryRouteAudit.ts:295, 304`) still names an Agent by formula, not by the author's name, because it is reached from inside `stepBalance`. This is the same class as 04, but it was left out because threading the names through costs more code than it is worth.
- **Unbuilt-step and refused-salt names** (agent finding 3) are re-resolved by the label pass without resolve-names' corrections. The agents' findings below cover the verified part.
- **Inversion check (05) abstains** at a centre whose branches cannot be placed one to one unless the letters among such centres differ. A coupling that rewrites two branches of one centre at once (both the acyl and the amine side) is therefore not judged. The old check judged it only by letter, and unsoundly.
- **The pacer and abort** (known item (b)) still apply to every patched path: a refused PubChem now fails fast to the other source (01), but a slow one still waits.
