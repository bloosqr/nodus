// Every amino-acid SMILES the route contract SHOWS the model must be the L enantiomer.
//
// A prompt exemplar is a worked example, and a wrong one teaches. Measured 2026-10-13: two
// exemplars in shared/routeRules.ts were the D enantiomer labelled L — `Fmoc-Lys(Boc)-OH` and a
// resin-bound alanine. The file's own comment said "Every SMILES below was parsed and run before
// it was written here", which was TRUE and INSUFFICIENT: both parse, both execute, and only the
// configuration was wrong. On chainL-6 the model then wrote four Fmoc amino acids as their D forms
// while naming them "Fmoc-L-X" — the contract had shown it exactly that. The route still verified,
// because the application resolves the NAME and checks that structure, so the model's error was
// corrected silently and reported `OK`.
//
// `git log -S` dates it: the bad Lys exemplar entered in 2f1ab5be on 2026-10-08 (#1068) and was
// corrected on 10-13. FIVE DAYS, through a merged pull request, with no test watching. This file
// is that test. It would have failed on 2f1ab5be.
//
// Two layers, because Node has no cheminformatics toolkit here:
//
//   1. The golden literals below. Dependency-free, so it runs in the ordinary unit gate on every
//      commit. It cannot read chemistry — it asserts that nobody edited these strings without
//      being made to look at this file. That is exactly the failure that happened.
//   2. tools/check-prompt-stereo.py, which parses each exemplar with RDKit and assigns CIP labels.
//      That is what makes the goldens trustworthy rather than merely stable. It is run below when
//      the index venv is present, and skipped (not failed) when it is not, so CI keeps layer 1.
//
// If you are here because this test failed: do not "fix" it by pasting the new string in. Run
// layer 2 against your change first. L is (S) for every proteinogenic amino acid except cysteine,
// where sulfur outranks the carboxyl and L is (R).

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'shared/routeRules.ts'), 'utf8');

/** Validated by tools/check-prompt-stereo.py, which assigns the CIP label with RDKit.
 *
 *  Each is written here in the SAME atom order the contract uses. That matters more than it
 *  looks: `[C@@H]` is L in one ordering and D in another, so the tag alone says nothing and a
 *  reviewer comparing two strings by eye cannot tell. The reference table in the chemistry plugin
 *  writes L-Lys as `…NCCCC[C@@H](C(=O)O)…` — the opposite tag, the same molecule. That is the
 *  trap this test exists to hold still. */
const L_EXEMPLARS = [
  // Fmoc-Lys(Boc)-OH, (S). Canonicalises identically to the chemistry plugin's own
  // peptideBuildingBlocks.ts entry, which is how the corrected value was confirmed.
  'O=C(O)[C@H](CCCCNC(=O)OC(C)(C)C)NC(=O)OCC1c2ccccc2-c2ccccc21',
  // A resin-bound alanine, (S). `*` is the solid support at the attachment atom.
  '*OC(=O)[C@H](C)N',
];

/** The one shape where "L == (S)" is reliable: a tetrahedral carbon bearing both N and a
 *  carboxyl. Anything else in the contract is not an amino acid and is none of this test's
 *  business. Deliberately loose on the side chain — the point is to FIND candidates, and layer 2
 *  judges them. */
const ALPHA_AMINO = /\[C@@?H\]/;

function contractText() {
  // The SOURCE, not the exports. Walking the bundle's exports was the first attempt and it has a
  // blind spot that bit immediately: ROUTE_PROGRAM_RULES is a plain `const` reached only through
  // routeProgramRules(), so an exemplar added to the program arm is invisible to an export walk.
  // Caught 2026-10-14 when a stereocentre was added to that very array and all three assertions
  // stayed green. Reading the file sees every rule whatever its visibility, and also sees a
  // stereocentre in a comment — which is the right side to err on, since a comment is copied into
  // the next exemplar as often as not.
  return source;
}

test('every amino-acid exemplar in the contract is the L form, byte for byte', () => {
  const text = contractText();
  for (const expected of L_EXEMPLARS) {
    assert.ok(
      text.includes(expected),
      `The contract no longer shows this exemplar verbatim:\n  ${expected}\n`
      + 'If you changed it deliberately, run tools/check-prompt-stereo.py against the new value '
      + 'and update L_EXEMPLARS. Do NOT paste the new string in without that check — a D '
      + 'enantiomer parses, executes and reads identically to an L one.',
    );
  }
});

test('no amino-acid stereocentre in the contract is outside the validated set', () => {
  // Catches an exemplar ADDED later. The golden list above cannot: a new D-alanine beside the two
  // correct strings leaves the first assertion passing. So strip every validated exemplar from the
  // contract and assert no stereocentre tag survives — whatever is left is an exemplar nobody has
  // checked. Stripping rather than counting, because the Lys exemplar legitimately appears twice,
  // once per arm, and a count has to be kept in step with that by hand.
  let text = contractText();
  for (const expected of L_EXEMPLARS) text = text.split(expected).join('');
  const orphans = text.match(/\[C@@?H\][^\s`"']*/g) ?? [];
  assert.deepEqual(
    orphans, [],
    `The contract holds ${orphans.length} stereocentre(s) outside the validated set:\n`
    + orphans.map(s => `  ${s}`).join('\n')
    + '\nAn exemplar with a stereocentre was added. Run tools/check-prompt-stereo.py to confirm its '
    + 'configuration, then add the exact string to L_EXEMPLARS.',
  );
  assert.ok(ALPHA_AMINO.test(L_EXEMPLARS[0]), 'the golden list itself should hold stereocentres');
});

test('RDKit agrees, when the index venv is available', t => {
  // Layer 2. Skipped rather than failed without the venv: a unit gate that needs a local
  // cheminformatics install would be turned off, and then layer 1 goes with it.
  const venv = path.join(repoRoot, '..', 'ord-index', '.venv', 'bin', 'python');
  const checker = path.join(repoRoot, '..', 'tools', 'check-prompt-stereo.py');
  if (!existsSync(venv) || !existsSync(checker)) {
    t.skip('ord-index/.venv or tools/check-prompt-stereo.py not present; golden-literal check still ran');
    return;
  }
  const out = execFileSync(venv, ['-I', checker], { cwd: path.join(repoRoot, '..'), encoding: 'utf8' });
  assert.match(out, /every amino-acid exemplar is the L form/, `check-prompt-stereo.py did not pass:\n${out}`);
  assert.match(out, /checked [1-9]\d* amino-acid exemplar/, `the checker found nothing to check:\n${out}`);
});
