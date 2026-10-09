# Audit 5: shared route parsing, reports and correction prompts

Scope: `shared/moleculeInspection.ts` (label parsing, step segmentation, route report, step-failure verdicts, correction prompts, name feedback), `shared/routeRules.ts`, and how `electron/ai/moleculeInspection.ts` and `electron/ai/researchAssistant.ts` consume them. I also covered the renderer's streamed-answer path (`src/components/ChatMarkdown.tsx`, `shared/chatSkills.ts`). Base: `audit/2026-10-09` of both repositories.

Every patch is a unified diff against `audit/2026-10-09` of **bloosqr/nodus**. Its first line names the repository and gives the `git apply` command. Each patch applies on its own, and all ten apply together in numeric order (checked). Each one adds its own regression test as a new `scripts/test-route-*.mjs`. None touches `shared/routeRules.ts`. None touches a file in `GENERATED` (scripts/build-server-shared.mjs), and I checked that no `GENERATED` entry imports `moleculeInspection.ts` or `routeRules.ts` transitively, so **`npm run build:server-shared` does not need to be rerun**. No patch is proposed for the marketplace repository.

Patch numbers follow the order I found the issues. The findings below are ranked by severity, and each one names its patch.

## Summary

| # | Finding | Category | Patch | Effect |
|---|---|---|---|---|
| 1 | Role-label regex is quadratic in a run of blanks, and every drawing is masked to one | speed | `01-role-marker-linear.patch` | A follow-up turn after a passed route spends **15 s (8 steps) to 52 s (29 steps)** of main-thread time before the model is asked; **14 ms / 96 ms** after the patch |
| 2 | A refused intermediate link (wrong stereoisomer or charge carried) passes the route | bug | `02-broken-links-pass-the-route.patch` | Report says "balanced and connected", no fix chip, final report drawn |
| 3 | Name feedback cuts names at 200 characters, so a long name's correction is never applied | bug + speed | `10-name-feedback-cuts-long-names.patch` | Up to 2 wasted name-correction LLM calls, then an unbuilt step and a fix round |
| 4 | "Byproducts: none; <explanation>" turns the explanation into a species | bug + speed | `03-none-then-prose-becomes-a-species.patch` | Phantom byproduct: a correction call, then an UNBUILT step and a fix round |
| 5 | A note after a name ("(1.2 equiv)", "(cat.)", "(solvent)") stays in the name | speed + bug | `09-trailing-notes-in-names.patch` | Misses the mirror, goes to paced PubChem, then a name-correction call |
| 6 | Conditions on the Agents line ("110 °C", "12 h", "reflux") are looked up | speed | `07-condition-agents-spend-pubchem-turns.patch` | 0.2 / 1 / 5 s of PubChem pacer per phrase (Green/Yellow/Red), serialized |
| 7 | Typographic hyphens and primes (U+2010/2011/2212, ′ ’ ″) miss the PubChem mirror | speed | `06-unicode-hyphens-miss-the-mirror.patch` | Each such name goes to the network through the pacer |
| 8 | Full-width `；` is not a separator, though full-width `：` is accepted | bug | `04-fullwidth-semicolon.patch` | Two species read as one unresolvable name |
| 9 | Evidence table segments steps differently from the species/prose parser | bug (drift) | `05-evidence-blocks-drift.patch` | A step citing a textbook is reported as "model knowledge only" |
| 10 | Final report says "every step passed" under a header that says the check failed | bug | `08-final-report-contradicts-review.patch` | Report contradicts its own verdict |

Tests, all patches applied (`logs/all-patches-tests.txt`): `npm run typecheck` passes. `test-molecule-inspection` passes 129/129, `test-molecule-inspection-compatibility` 4/4, `test-route-evidence` 4/4, `test-synthesis-evidence` 15/15, `test-synthesis-evidence-without-ord` 16/16. All 10 new regression test files pass (23 tests). Every new test was run against the base source and fails there, except "unchanged behaviour" guard cases, which pass on both (`logs/NN-before.txt` / `logs/NN-after.txt`).

---

## 1. The role-label scan is quadratic in blank runs, and drawings are masked to blanks (speed)

**Where:** `shared/moleculeInspection.ts:796` (`ROLE_MARKER`), `:801` (`NAME_ROLE_MARKER`) and `:574` (the same pattern in `stepProseText`), combined with `maskDrawnRegions` at `:861`.

**What goes wrong.** The markers begin `(?:`{1,2}|\*\*|__)?[ \t]*\b(reactants|…)`. With the optional prefix absent, `[ \t]*` is retried from every position of a run of blanks, and each attempt scans to the end of the run. The cost is therefore quadratic in the run length. Before any label is read, `maskDrawnRegions` replaces every `nodus-view` fence and `<svg>` with spaces of the same length. So every drawing in an answer becomes exactly such a run. Route drawings are stored inline in the answer as `nodus-view` JSON fences (`runner.renderView` → `serializeChatVisualPart`). The code's own comments measure them at about 20 KB each (604,000 characters of SVG on one route).

The hot callers run on the main process, before the model call and inside the audit:
- `routeConversationState` (`shared:1448`) runs `countRouteSteps` over the first assistant turn after the request. On a follow-up turn it is called up to three times: `researchAssistant.ts:639`, `:643` (`asksForRoute`) and `:229` (`asksForRoute` in `skillExecution`). If the route passed on its first answer, that turn carries the final report's drawings.
- On a turn whose answer holds a model-drawn SVG (the existing test at `test-molecule-inspection.mjs:~1800` records one seen live), `resolveNamedRoute` runs `countRouteSteps`, `findStepNamedSpecies` and `annotateSpeciesSmiles`, and the legacy path adds two more.

**Verified by:** benchmarks (`logs/bench.mjs` → `logs/01-role-marker-bench.txt`, `logs/bench-history.mjs` → `logs/01-history-bench.txt`), the regression test `scripts/test-route-label-scaling.mjs`, and a 40,000-answer differential fuzz.

| input | base | patched |
|---|---|---|
| 100 KB blanked drawing, `countRouteSteps` | 13,215 ms | < 5 ms |
| answer with one 20 KB / 40 KB drawing, `countRouteSteps` | 597 / 2,408 ms | 0.4 / 0.6 ms |
| passed route, 8 steps × 20 KB drawings (162 KB) | 4,596 ms per call | 4.2 ms |
| passed route, 29 steps × 20 KB drawings (588 KB) | 16,335 ms per call | 33 ms |
| **follow-up turn** after the 8-step / 29-step route (the 3 calls above) | **15,108 / 52,412 ms** | **14 / 96 ms** |

**Saving.** Measured: 15–52 s of blocked main thread on every follow-up turn in a conversation whose route passed on its first answer. With a model-drawn 20–40 KB SVG, about 0.6–2.4 s per call times 3–5 calls on that turn. The time sits before the LLM call or inside the route-check phase. Nothing else on the main process (IPC and other answers) runs meanwhile.

**Patch** `01-role-marker-linear.patch`: the blanks before a label are taken either after the optional markup or from the start of their own run (`(?<![ \t])[ \t]+`), so matching is linear. The match starts at the same offset as before, so every segment offset, and every in-place annotation, is unchanged. Checks:
- **Differential fuzz** (`logs/fuzz.mjs`, synthetic answers mixing heading styles, label markup, full-width colons, separators, notes, drawings and fences): 0 of 40,000 answers differ in `countRouteSteps`, `findStepNamedSpecies`, `findStepProse`, `findStepConditions`, `stepDeclaresRacemic`, `findStepBlocks` or `annotateSpeciesSmiles` (`logs/01-differential-fuzz.txt`).
- **First attempt rejected:** making the blanks part of the markup group alone changed `annotateSpeciesSmiles` on inline labels (2,816 of 20,000 differed), so it was replaced.
- **Regression test:** fails before (2 of 3), passes after (3 of 3).

## 2. A refused intermediate link passes the route (bug)

**Where:**
- `shared/moleculeInspection.ts:2234` (the `formatRouteAudit` verdict reasons);
- `:2646` (`namedRouteProblems`, which feeds the fix chips);
- `electron/ai/moleculeInspection.ts:814` (`routePasses`, the final-report gate).

**What goes wrong.** Take a route where step 3 consumes the other enantiomer, or the free acid instead of the salt, of what step 1 made. chemistry-studio's route audit (`chemistryRouteAudit.ts:817`, `:989`) returns:
- a link with `ok: false, reason: 'constitution-only'`;
- a `blocked` sentence;
- `continuous: false`.

The link is still an edge in its connectivity graph, so no step is `isolated`. Nodus decides the route's fate only from step failures, `isolated`, the target and the review. It never reads failing links. The result:
- The header reads "**Route checked: balanced and connected** — every intermediate is carried over" directly above "Step 1 → 3 FAIL — same constitution but different stereochemistry or charge".
- `formatNamedRouteFixPrompts` returns `''`, so no correction is offered.
- `routePasses` lets the final report draw the route as passed.

`ROUTE_CONTINUITY_SYSTEM_RULE` (`shared:58`) tells the model such a route "is rejected as discontinuous". The two halves of the application disagree.

**Verified by:** traced through the plugin's audit code and nodus's three verdicts. The regression test `scripts/test-route-link-verdict.mjs` feeds the audit shape the plugin produces. It fails before (header passes, no chip) and passes after. A guard case (all links hold) passes both before and after.

**Patch** `02-broken-links-pass-the-route.patch`:
- adds `brokenRouteLinks(audit)` (a non-`carried` link with `ok: false`);
- adds it to the header reasons, to the route-level problems behind the fix chips, and to `routePasses`, so all three verdicts read one predicate.

The electron typecheck passes (`logs/02-typecheck-electron.txt`).

## 3. Name feedback cuts names at 200 characters, so the correction never lands (bug + speed)

**Where:** `shared/moleculeInspection.ts:2882` and `:2889` (`parseNameFeedback`), `:1223` (`isPlausibleSpeciesName`). Consumed at `electron/ai/moleculeInspection.ts:629` and `:636`.

**What goes wrong.** The parser keeps names up to `MAX_SPECIES_NAME` (4000). Its comment records that a 200-character cut once left five steps of a long-chain route unbuilt. The name-feedback path still cuts at 200:
- `from` comes back as the first 200 characters of the name. The rename is applied with `renamed.has(entry.name)`, keyed by the full name, so it never matches and the correction is silently dropped. The structure branch (`item.name === entry.from`) is dropped the same way.
- `to` is cut to 200, so a long corrected name is syntactically incomplete and cannot resolve.

`NAME_FEEDBACK_ATTEMPTS` is 2, so both model calls are spent for nothing. The route is then checked with the species missing, so the step is UNBUILT and a fix round follows.

**Verified by:** the regression test `scripts/test-route-name-feedback-long.mjs`, using a 6-unit nested name (about 290 characters) that the parser keeps whole. Before the patch, `from` comes back cut and the correction note is empty. After, both pass. The rename lookup was traced at `electron/ai/moleculeInspection.ts:636`.

**Saving:** on a route with any unresolved name over 200 characters (long-chain targets), 2 name-correction model calls (budget up to 8,000 tokens each) plus one fix round (a model answer plus a route check). That is the routes the owner calls the hardest.

**Patch** `10-name-feedback-cuts-long-names.patch` uses `MAX_SPECIES_NAME` for both slices and for the plausibility bound.

## 4. "none" followed by an explanation becomes a species (bug + speed)

**Where:** `shared/moleculeInspection.ts:1029` (`parseRoleEntries`).

**What goes wrong.** Splitting happens before the "none" check, so only the first fragment is dropped:

| line | parsed as |
|---|---|
| `Byproducts: none; the rearrangement loses no atoms` | byproduct "the rearrangement loses no atoms" |
| `Byproducts: None. The acid is a catalyst; it is regenerated` | byproduct "it is regenerated" |
| `Agents: none; the reaction is run neat at 120 °C` | agent "the reaction is run neat at 120 °C" |

A phantom byproduct is unresolvable. It is sent to name correction (a model call that cannot succeed, because there is no species), and the step is reported UNBUILT, which costs a fix round. It also spends PubChem turns.

**Verified by:** the probe `logs/edge.mjs` and the regression test `scripts/test-route-label-none.mjs`, which fails before (2 of 3) and passes after.

**Patch** `03-none-then-prose-becomes-a-species.patch`: a side whose first entry is `none` / `n/a` / `nil` / a dash / "no <word>" is empty, and the rest of that line is ignored. A bare `NO` (nitric oxide) is still a species. A differential fuzz with no none-markers in the vocabulary gives 0 of 20,000 differences (`logs/03-differential-fuzz-without-none-markers.txt`). With them, the differences are the intended ones.

## 5. A note after a name stays in the name (speed + bug)

**Where:** `shared/moleculeInspection.ts:1094` (`findStepNamedSpecies`; names come from `parseRoleEntries`).

**What goes wrong.** Each of these is sent to the resolvers whole:
- `sodium borohydride (1.2 equiv)`
- `sulfuric acid (cat.)`
- `methanol (solvent)`
- `ethanal (distilled off as it forms)`
- `acetic acid (glacial) (excess)`

The local mirror matches synonyms exactly. Running the plugin's own `_pubchem_mirror` against a synthetic mirror (`logs/09-mirror-probe.*`) gives "sodium borohydride" a hit and "sodium borohydride (1.2 equiv)" a miss, which then goes to network PubChem through the pacer. An unresolved reactant or product then triggers the name-correction model call. An agent so written is never resolved at all.

**Verified by:** the mirror probe and the regression test `scripts/test-route-label-notes.mjs`, which fails before and passes after. A guard case keeps `iron(III) chloride`, `copper (II)`, `tetrakis(triphenylphosphine)palladium (0)`, `(2R)-butan-2-ol`, `but-2-ene (E)` and an unbalanced `ε-caprolactam (azepan-2-one`, and passes both before and after.

**Saving (estimate):** per affected answer, one name-correction model call (one call covers the batch), plus one paced PubChem turn (0.2 / 1 / 5 s) per annotated name.

**Patch** `09-trailing-notes-in-names.patch` strips trailing whitespace-preceded parentheticals that contain a lowercase word. The visible change: the in-place annotation replaces "sodium borohydride (1.2 equiv)" with "sodium borohydride — `SMILES`". The fuzz without notes gives 0 of 20,000 differences.

## 6. Conditions on the Agents line spend PubChem turns (speed)

**Where:** `electron/ai/moleculeInspection.ts:615` (`resolveAll` over every name, agents included). The contract invites conditions there: `ROUTE_LABEL_LINES`, "other condition the step does not consume".

**What goes wrong.** "110 °C", "12 h", "reflux" and "hν" each go through `resolveSpeciesName`. The local mirror misses, then network PubChem is called through `takePubchemTurn`. That is serialized at 200 / 1,000 / 5,000 ms per request for the Green / Yellow / Red grades (`worker.ts:363`), and OPSIN fails too. The outcome is always "unresolved", and for an agent that is simply dropped. The request also adds load to a service that has recently throttled the owner.

**Verified by:** traced through `resolveNamedRoute` → `resolve-names` → `resolveSpeciesName` → `pubchemByName`. An agent with no resolution ends exactly as a failed lookup ends: `status: 'unresolved'`, kept out of `critical` and out of the labels. The regression test `scripts/test-route-condition-agents.mjs` fails before (3 of 3; the helper does not exist) and passes after.

**Saving (estimate, from the pacer constants):** a 10-step route with 2 condition phrases per step makes 20 avoidable requests: 4 s at Green, 20 s at Yellow, 100 s at Red, serialized.

**Patch** `07-condition-agents-spend-pubchem-turns.patch` adds `isConditionPhrase` (whole-entry temperatures, times, pressures, wavelengths, light and heat). It still resolves "10% palladium on carbon", "2 M hydrochloric acid", "nitrogen" and "light petroleum". `resolveNamedRoute` skips such agents. The electron typecheck passes.

## 7. Typographic hyphens and primes miss the mirror (speed)

**Where:** `shared/moleculeInspection.ts:830` (`cleanSpeciesName`).

**What goes wrong.** These are passed through as written:
- `4‑nitrophenol` (U+2011);
- `4‐nitrophenol` (U+2010);
- `2−methylpropan−2−ol` (U+2212);
- `N,N′-dicyclohexylcarbodiimide` (U+2032 prime);
- `N,N’-…` (U+2019).

**Verified by** the plugin's `_pubchem_mirror` run against a synthetic SQLite mirror (`logs/06-mirror-probe.*`): every one of these misses while the ASCII form hits, so each goes to network PubChem through the pacer. The regression test `scripts/test-route-label-unicode.mjs` fails before and passes after.

**Not verified:** whether PubChem's or OPSIN's own services normalise these. I did not call them (data rules), and I have no local OPSIN.

**Saving (estimate):** one paced PubChem turn (0.2–5 s) per affected name. In local-only mode, possibly a name-correction call.

**Patch** `06-unicode-hyphens-miss-the-mirror.patch` maps them to ASCII; the structure-fallback dash still works. The fuzz without typographic punctuation gives 0 of 20,000 differences.

## 8. The full-width semicolon is not a separator (bug)

**Where:** `shared/moleculeInspection.ts:991` (`splitEntrySpans`).

**What goes wrong.** The role markers accept the full-width colon `：`, but entries split only on `;`. An answer punctuated in Chinese or Japanese, `Reactants： acetic acid；ethanol`, yields one species, "acetic acid；ethanol". It cannot resolve, which means a correction call and an unbuilt step.

**Verified by:** the regression test `scripts/test-route-label-fullwidth.mjs` (parse plus in-place annotation), which fails before and passes after.

**Patch** `04-fullwidth-semicolon.patch`. The fuzz without `；` gives 0 of 20,000 differences.

## 9. The evidence table segments steps differently from the parser (bug, drift)

**Where:** `shared/moleculeInspection.ts:585` (`findStepBlocks`, used by `collectStepEvidence` and `stepDeclares*`). The species, prose and conditions are read through `stepSections`.

**What goes wrong.** `findStepBlocks` matches any line starting "Step N", and the first match per number wins. A "**Route overview**" with plain lines "Step 1: oxidation…" therefore claims steps 1 and 2. The real `## Step 1` sections, with their citations, become "cited outside the steps", and the table reports:
- "| 1 | — | — | — · _model knowledge only_ |"
- "the answer cites textbooks … in 0"

That happens while `findStepProse` for the same answer quotes the step's own Clayden citation.

**Verified by:** the probe `logs/05-probe-overview.mjs` and the regression test `scripts/test-route-evidence-blocks.mjs`, which fails before and passes after. Well-formed routes in five heading styles (hash, bold, bold lead-in, plain line, numbered list), with or without trailing notes or report sections, give identical evidence before and after (`logs/05-well-formed-styles-unchanged.txt`).

**Patch** `05-evidence-blocks-drift.patch`: `findStepBlocks` uses `stepSections` when the answer has them, and falls back to its own reading otherwise.

## 10. The final report contradicts the verdict when the review blocks (bug)

**Where:** `electron/ai/moleculeInspection.ts:899` (final-report text) and `:1057` (report assembly).

**What goes wrong.** The drawing gate deliberately does not wait for the model review. When the review returns a `blocking` problem, the header becomes "**Route check failed** — a route review raised 1 problem(s)", fix chips are offered, and the same answer still prints "Every step of this route passed the check, so the route is drawn."

**Verified by:** the regression test `scripts/test-route-final-report-review.mjs`. It drives `appendRouteReportAndDrawings` through the mocked harness the repo already uses in `test-molecule-inspection-compatibility.mjs`, with a blocking review reply. It fails before (1 of 2; the guard case passes) and passes after.

**Patch** `08-final-report-contradicts-review.patch`: after the review arrives, the opening sentence is replaced with one that says the RDKit check passed but the review holds the route. The drawings and the gate are unchanged. The electron typecheck passes.

---

## Verified, low impact (no patch)

These are measured or traced but need unrealistic input or have little effect (`logs/redos-sweep-all-patches.txt`: every exported parser on 100 KB adversarial inputs, all patches applied).

- **`stepDeclares` line filter** (`shared:1524`): `^\s*(?:[-*]\s*)?(?:…)?\s*` is quadratic on one blank line. It takes about 9 s for a 100 KB line of spaces, but it runs on unmasked model text, so it needs 100 KB of blanks on one line. The fix is the same as finding 1: `(?:(?:`{1,2}|\*\*|__)\s*)?`.
- **`SENTENCE_TRAILING`** (`shared:309`, used by `findSmilesCandidates` and `findRequestedTarget`): `[…]+$` is quadratic. It takes about 170 s on a 100 KB token of `;` or `:` with no spaces, but runs on whitespace-split tokens of the user's question.
- **`PASSAGE_LINK` / `IDEA_LINK` / `WEB_LINK`** (`shared:644`): about 34 s on 100 KB of unclosed `[`.
- **`parseRouteReview` / `parseNameFeedback`** (`/\{[\s\S]*\}/`): about 7 s on 100 KB of unclosed `{`. A real reply has a few hundred braces at most.
- **`maskDrawnRegions` and `withoutDrawings`**: O(k·n) for k unclosed `<svg` tags. It takes 2.7 s at 20,000 tags, and is linear for realistic k.
- **`__Byproducts:__`** (underscore bold) is never read as a label, because `_` is a word character and `\b` fails. The byproduct is dropped silently. I found it while writing test 1 (pre-existing; it reads the same before and after). Models rarely write underscore bold.
- **Report intro wording:** "Every step was parsed with RDKit and every equation and intermediate link was checked" (`shared:2212`) is printed even when a step is UNBUILT ("nothing was checked").

## Suspected, not verified

- **Superseded routes in history.** Fix rounds replay every earlier route answer, cut down to prose, up to `MAX_HISTORY_MESSAGES = 12`. The prompt grows across rounds until that cap. Reports, chips and older correction rules are dropped, so I found no unbounded growth. Replaying only the latest route might shorten prefill. Not measured.
- **Renderer streaming.** Each delta re-renders the whole message (`ResearchAssistantModal.tsx:610` → `ChatMarkdown`), which is O(n²) over a stream. `splitChatVisuals` itself is negligible (0.3 ms per call at 76 KB with 400 fences, `logs/renderer-split-chat-visuals.*`). The Markdown re-render was not measured. It runs on the renderer, not on the main-process path the wall-time figures cover.
- **Remote resolvers.** It is unverified whether PubChem's or EBI OPSIN's own services normalise the typographic characters in finding 7 (not called, per the data rules).

## Checked and found sound

- **Correction prompts across rounds.** Each prompt is built from the current audit only. Earlier fix prompts lose their rules in history (`routeFixPromptForHistory`), and chips, drawings and reports are stripped (`chatProseForHistory`, `routeReportsForHistory`).
- **Main-process streaming.** `onDelta` only forwards; there is no per-chunk scan of the accumulated text.
- **`routeRules.ts`.** The first request and the corrections read the same `routeSpeciesRules()`. `SYNTHESIS_TEMPLATE_ADDENDUM` is evaluated at import, but the switch is read from the launch environment, so the two cannot diverge within a run.
- **Long names in the parser itself.** These are kept to 4000 characters (finding 3 is the feedback path only).

## Environment and how to reproduce

- **Install.** `npm ci` fails in this sandbox because `cdn.sheetjs.com` (the `xlsx` tarball) is blocked by the proxy. Instead, `xlsx` was pinned to the registry's 0.18.5 for the install only, with `--ignore-scripts`. `package.json` and `package-lock.json` were restored and are not part of any patch.
- **Typecheck.** `npm run typecheck` passes on the base and with all patches.
- **Skipped test.** `scripts/test-research-synthesis-context.mjs` fails identically on the base: `better-sqlite3`'s native binding was not built (because of `--ignore-scripts`). It was not used as evidence. No Electron re-runs were needed.
- **Plugin.** The marketplace repository was cloned to read the worker, resolver and route-audit code. Its Node test suite was not run (no findings there). RDKit 2026.03.6 from PyPI, in a scratch venv, was used only to import `reactions_worker.py` for the mirror probes.
- **Network.** No request was sent to PubChem's REST API or to EBI OPSIN. No dataset was downloaded; all inputs are synthetic.
- **Reproduce.** Probes and fuzzers are in `logs/` (`fuzz*.mjs` take `old.mjs new.mjs seed count`, built with esbuild from the base and patched `shared/moleculeInspection.ts`).
