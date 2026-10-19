// A program answer's report is built from the EXECUTED TRACE, not from anything the model wrote.
//
// Why this file exists. The labels and the drawings are matched to audited steps BY INDEX, and the
// index is decided twice: once in the package, by `routeProgramToAuditInput`, which built the audit
// being reported, and once here, by `routeProgramReportInputs`, which builds the report around it.
// The two must agree on which lines are steps and which slots stay empty. If they disagree by one,
// nothing errors — every label and every picture simply describes the wrong step, which is the
// hardest kind of wrong to notice in a long route.
//
// So the rules both sides follow are asserted here on a trace that contains each case at once: a
// start line that is not a step, a line that ran, a line that failed, and a line that never ran.
// The package's own copy is held to the same rules by its test/route-program-*.test.mjs; this one
// deliberately takes no dependency on ../marketplace, so it runs everywhere CI does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(path.join(os.tmpdir(), 'route-program-report-'));
process.on('exit', () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // left for the OS to reap
  }
});

const outfile = path.join(dir, 'moleculeInspection.mjs');
const built = await build({
  entryPoints: ['shared/moleculeInspection.ts'],
  outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', write: false,
});
fs.mkdirSync(path.dirname(outfile), { recursive: true });
fs.writeFileSync(outfile, built.outputFiles[0].contents);
const { normalizeRouteProgramTrace, routeProgramReportInputs, routeLabelNames, formatChainProgramPreflight } =
  await import(pathToFileURL(outfile).href);

/** A support-bound dipeptide assembly, with one failure and one line left unexecuted after it.
 *  `from: null` marks the start line; the package sets it the same way. */
const TRACE = {
  lines: [
    { ref: 'M1', from: null, reactants: [], reagents: [], products: ['*OC(=O)[C@@H](N)C(C)C'], equation: null, executed: true, failure: null },
    {
      ref: 'M2', from: 'M1',
      reactants: ['*OC(=O)[C@@H](N)C(C)C', 'CC(=O)O'],
      reagents: ['CCN(C(C)C)C(C)C'],
      products: ['*OC(=O)[C@@H](NC(C)=O)C(C)C', 'O'],
      equation: '*OC(=O)[C@@H](N)C(C)C.CC(=O)O>CCN(C(C)C)C(C)C>*OC(=O)[C@@H](NC(C)=O)C(C)C.O',
      executed: true, failure: null,
      provenance: { kind: 'named', id: 'n-peptide-coupling' },
      names: { 'CC(=O)O': 'acetic acid' },
    },
    {
      ref: 'M3', from: 'M2', reactants: ['*OC(=O)[C@@H](NC(C)=O)C(C)C'], reagents: [], products: [],
      equation: null, executed: true, failure: { error: 'no-match', message: 'does not apply' },
      provenance: { kind: 'named', id: 'fmoc-removal' },
    },
    { ref: 'M4', from: 'M3', reactants: [], reagents: [], products: [], equation: null, executed: false, failure: null },
  ],
};

test('a start line is not a step, so it takes no slot', () => {
  const { steps } = routeProgramReportInputs(normalizeRouteProgramTrace({ programTrace: TRACE }));
  // Three apply lines, not four: M1 assigns the starting material and transforms nothing.
  assert.equal(steps.length, 3);
  assert.ok(steps[0].includes('>'), `expected the first apply line's equation, got ${JSON.stringify(steps[0])}`);
});

test('a line that did not run keeps its slot, empty', () => {
  const { steps, labels } = routeProgramReportInputs(normalizeRouteProgramTrace({ programTrace: TRACE }));
  // The failed line and the unexecuted one each hold their place. This is the assertion that
  // stops every later label and drawing sliding onto the wrong step.
  assert.deepEqual(steps.slice(1), ['', '']);
  assert.deepEqual(labels[1], []);
  assert.deepEqual(labels[2], []);
  assert.equal(labels.length, steps.length);
});

test('labels run reactants, then agents, then products', () => {
  const { labels } = routeProgramReportInputs(normalizeRouteProgramTrace({ programTrace: TRACE }));
  assert.deepEqual(labels[0].map((entry) => entry.role), ['reactant', 'reactant', 'agent', 'product', 'product']);
});

test('every product after the first is a byproduct', () => {
  const { labels } = routeProgramReportInputs(normalizeRouteProgramTrace({ programTrace: TRACE }));
  const products = labels[0].filter((entry) => entry.role === 'product');
  assert.equal(products[0].byproduct, false);
  // The water released by the coupling. Unflagged, the audit's stereo logic reads an organic
  // co-product as a second main product.
  assert.equal(products[1].byproduct, true);
});

test('a supplied name travels with its structure; a computed one has none', () => {
  const { labels } = routeProgramReportInputs(normalizeRouteProgramTrace({ programTrace: TRACE }));
  const acid = labels[0].find((entry) => entry.smiles === 'CC(=O)O');
  assert.equal(acid.name, 'acetic acid');
  const carried = labels[0].find((entry) => entry.smiles === '*OC(=O)[C@@H](NC(C)=O)C(C)C');
  // The application derived this structure, so nobody named it. ABSENT rather than invented: a
  // name here would be checked against the structure and refused.
  //
  // This used to be an empty string, which is the same intent said in a way the formatter does not
  // honour: its fallbacks are written with `??`, which treats '' as a name and prints it. Found by
  // /code-review on 4b55444a and confirmed in production — the building-block alpha-configuration
  // line, the only reader of a D-for-L block error, printed "... the right one:  (S)" and named no
  // block at all. The assertion below always wanted blanks excluded from the lookup; the field now
  // agrees with it. See scripts/test-route-program-block-names.mjs.
  assert.equal(carried.name, undefined);
  assert.equal(routeLabelNames(labels).get('*OC(=O)[C@@H](NC(C)=O)C(C)C'), undefined);
  assert.equal(routeLabelNames(labels).get('CC(=O)O'), 'acetic acid');
});

test('the structure check sees the route, not its conditions', () => {
  const { species } = routeProgramReportInputs(normalizeRouteProgramTrace({ programTrace: TRACE }));
  assert.ok(species.includes('*OC(=O)[C@@H](N)C(C)C'));
  assert.ok(species.includes('*OC(=O)[C@@H](NC(C)=O)C(C)C'));
  // The base is an agent: it takes no part in the balance and is not what the route is made of.
  assert.ok(!species.includes('CCN(C(C)C)C(C)C'));
  assert.equal(new Set(species).size, species.length, 'species must be distinct');
});

test('the arrow carries the transformation the line named', () => {
  const { conditions, steps } = routeProgramReportInputs(normalizeRouteProgramTrace({ programTrace: TRACE }));
  assert.equal(conditions.length, steps.length, 'one arrow per step, or the text lands on the wrong picture');
  assert.equal(conditions[0], 'n-peptide-coupling');
  // A line that never ran is never drawn, so its arrow text is empty rather than misleading.
  assert.deepEqual(conditions.slice(1), ['', '']);
});

test('a note the model wrote wins over the transformation id', () => {
  const noted = {
    lines: [
      { ref: 'M1', from: null, reactants: [], reagents: [], products: ['CCO'], equation: null, executed: true, failure: null },
      {
        ref: 'M2', from: 'M1', reactants: ['CCO'], reagents: [], products: ['CC=O'],
        equation: 'CCO>>CC=O', executed: true, failure: null,
        provenance: { kind: 'named', id: 'alcohol-oxidation' }, note: 'Swern, −78 °C',
      },
    ],
  };
  const { conditions } = routeProgramReportInputs(normalizeRouteProgramTrace({ programTrace: noted }));
  assert.equal(conditions[0], 'Swern, −78 °C');
});

test('a smarts line has no id to quote and says so', () => {
  const raw = {
    lines: [
      { ref: 'M1', from: null, reactants: [], reagents: [], products: ['CCO'], equation: null, executed: true, failure: null },
      {
        ref: 'M2', from: 'M1', reactants: ['CCO'], reagents: [], products: ['CC=O'],
        equation: 'CCO>>CC=O', executed: true, failure: null,
        provenance: { kind: 'smarts', smarts: '[C:1][OH]>>[C:1]=O' },
      },
    ],
  };
  const { conditions } = routeProgramReportInputs(normalizeRouteProgramTrace({ programTrace: raw }));
  assert.equal(conditions[0], 'smarts');
});

test('an older package returns no trace, and that is not a failure', () => {
  assert.equal(normalizeRouteProgramTrace({ steps: [], blocked: [] }), null);
  assert.equal(normalizeRouteProgramTrace(null), null);
  assert.equal(normalizeRouteProgramTrace({ programTrace: {} }), null);
});

test('a trace line that is not an object is refused outright', () => {
  // Rather than silently contributing an empty step, which would misalign the rest.
  assert.equal(normalizeRouteProgramTrace({ programTrace: { lines: ['nope'] } }), null);
});

test('the sequence-level preflight renders as its own section, never as a step finding', () => {
  const text = formatChainProgramPreflight({
    findings: [
      { id: 'dkp-c-terminal-pro', label: 'C-terminal proline (diketopiperazine)', severity: 'medium',
        why: 'the free amine can close onto the ester', choice: '2-CTC trityl ester', answeredBy: null },
      { id: 'aspartimide', label: 'aspartimide motif Asp-Gly', severity: 'medium',
        why: 'the side-chain carbonyl can close', choice: 'Dmb dipeptide block',
        answeredBy: 'Fmoc-Asp(OtBu)-(Dmb)Gly-OH' },
    ],
    choices: { linker: 'Wang/2-CTC ester', deprotection: '20% piperidine in DMF',
      cleavage: 'TFA/TIS/H2O 95:2.5:2.5, 2 h' },
    assumptions: ['no synthesizer guarantee'],
    blocking: false,
  });
  assert.match(text, /### Preflight \(sequence-level\)/);
  assert.match(text, /C-terminal proline/);
  assert.match(text, /Answered by Fmoc-Asp\(OtBu\)-/);
  assert.match(text, /\*\*Linker:\*\*/);
  assert.match(text, /\*\*Cleavage:\*\*/);
  assert.doesNotMatch(text, /Step \d/);
});

test('an absent preflight renders as nothing, so an older package is unchanged', () => {
  assert.equal(formatChainProgramPreflight(null), '');
  assert.equal(formatChainProgramPreflight({}), '');
});
