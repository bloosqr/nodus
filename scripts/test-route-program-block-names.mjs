// A building block's alpha-configuration line must name the block in program mode too.
//
// Found by /code-review on 4b55444a and confirmed in production output the same day.
// `routeProgramReportInputs` labels every species with `name: line.names?.[smiles] ?? ''`, so a
// species the package did not name gets an EMPTY STRING rather than no name. `alphaConfigurationLine`
// then falls back with `??`, which does not treat '' as absent, so both the label fallback and the
// formula fallback are skipped and the line names nothing at all.
//
// Measured, harness-runs/spps-08-ladder2-program-mode-thinking-none, turn 3:
//
//   Building blocks, alpha configuration as measured (1 (S)) — … the right one:  (S)
//
// against the names-first arm of the same length and turn, which reads:
//
//   … the right one: (2S,3S)-2-{[(9H-fluoren-9-ylmethoxy)carbonyl]amino}-3-met…
//
// This line is the ONLY reader of a D-for-L building-block error — one of the three faults the
// generated-program path exists to prevent — so in program mode it was reporting a configuration
// with no way to tell which block carried it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(path.join(os.tmpdir(), 'route-program-block-names-'));
await build({ entryPoints: ['shared/moleculeInspection.ts'], outfile: path.join(dir, 'inspection.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { formatRouteAudit, routeProgramReportInputs } = await import(pathToFileURL(path.join(dir, 'inspection.mjs')));
test.after(() => rm(dir, { recursive: true, force: true }));

/** A coupling whose incoming block carries a measured alpha configuration, as the package reports
 *  it: the chain under Reactants and the Fmoc amino acid as the second reactant. */
const FMOC_ALA = 'C[C@H](NC(=O)OCC1c2ccccc2-c2ccccc21)C(=O)O';
const step = (labelName) => ({
  index: 0, reaction: 'a.b>>c.d', ok: true, balanced: true, chargeBalanced: true,
  differences: [], unspecifiedStereocentres: 0, agents: [], products: [],
  reactants: [
    { canonicalSmiles: '*OC(=O)CN', formula: 'C3H5NO2', coefficient: 1 },
    { canonicalSmiles: FMOC_ALA, formula: 'C19H19NO4', coefficient: 1, alphaConfiguration: '(S)' },
  ],
  ...(labelName === undefined ? {} : {}),
});

const audit = (labels) => formatRouteAudit(
  { ok: true, steps: [step()], links: [], blocked: [], review: [] }, labels);

test('the block is named when the package named it', () => {
  const report = audit([[
    { role: 'reactant', byproduct: false, name: 'the resin-bound glycine', smiles: '*OC(=O)CN' },
    { role: 'reactant', byproduct: false, name: 'Fmoc-L-alanine', smiles: FMOC_ALA },
  ]]);
  const line = report.split('\n').find((entry) => entry.includes('alpha configuration'));
  assert.ok(line, `the line is printed: ${report}`);
  assert.match(line, /Fmoc-L-alanine \(S\)/, `the block is named: ${line}`);
});

test('an unnamed block falls back to its formula, never to nothing', () => {
  // The measured case. An empty-string name is what the program-mode labeller produced, and `??`
  // let it through as if it were a name.
  const report = audit([[
    { role: 'reactant', byproduct: false, name: '', smiles: '*OC(=O)CN' },
    { role: 'reactant', byproduct: false, name: '', smiles: FMOC_ALA },
  ]]);
  const line = report.split('\n').find((entry) => entry.includes('alpha configuration'));
  assert.ok(line, `the line is printed: ${report}`);
  assert.doesNotMatch(line, /right one:\s{2,}\(/, `the block is not left unnamed: ${line}`);
  assert.match(line, /C19H19NO4 \(S\)/, `it falls back to the formula: ${line}`);
});

test('no labels at all still falls back to the formula', () => {
  // The pre-existing names-first behaviour, which must not change.
  const line = audit([]).split('\n').find((entry) => entry.includes('alpha configuration'));
  assert.match(line, /C19H19NO4 \(S\)/, `unchanged: ${line}`);
});

test('the program-mode labeller omits a name it does not have, rather than sending an empty one', () => {
  // The other half of the fix, at the producer. A label carrying `name: ''` is indistinguishable
  // from a named species to every `??` in the formatter, so the field is left off instead.
  // The shape the function actually takes: a flat list of trace lines, a step being one whose
  // `from` is not null, and `executed` with an `equation` being one that ran.
  const { labels } = routeProgramReportInputs([{
    ref: 'M2', from: 'M1', executed: true, operation: 'apply(M1, named="n-peptide-coupling")',
    equation: '*OC(=O)CN.' + FMOC_ALA + '>>*OC(=O)CNC(C)=O',
    reactants: ['*OC(=O)CN', FMOC_ALA], reagents: [], products: ['*OC(=O)CNC(C)=O'],
    names: { '*OC(=O)CN': 'the resin-bound glycine' },
  }]);
  const flat = labels.flat();
  assert.ok(flat.length, `labels were produced: ${JSON.stringify(labels)}`);
  const named = flat.find((entry) => entry.smiles === '*OC(=O)CN');
  assert.equal(named.name, 'the resin-bound glycine', 'a name the package gave is kept');
  for (const entry of flat.filter((e) => e.smiles !== '*OC(=O)CN')) {
    assert.notEqual(entry.name, '', `an unnamed species carries no name field: ${JSON.stringify(entry)}`);
  }
});
