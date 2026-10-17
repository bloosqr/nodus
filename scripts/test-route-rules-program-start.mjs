// SPPS-FIXES-2026-10-17 fix 2, the rule half.
//
// The program-mode domain rule shows `M1 = start(smiles="*OC(=O)[C@H](C)N")` as an example but never
// said that this is the ONLY way a route can begin on a support. Measured: the model instead wrote
// `M1 = start(smiles="*O")` and tried to load the first monomer with `ester-formation`, which
// refuses because its SMARTS wants the CARRIED molecule to be the acid. Seen at
// harness-runs/spps-02-ladder2-program-mode-thinking-none (turns 1-3, terminal — the message came
// back byte-identical), spps-04-ladder2-program-mode-thinking-high turn 0, and
// spps-10-ladder2-program-mode-thinking-high turn 0. There is no transform in the shipped set that
// loads a bare support, so the rule has to say the start is the loaded monomer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(path.join(os.tmpdir(), 'route-rules-program-start-'));
await build({ entryPoints: ['shared/routeRules.ts'], outfile: path.join(dir, 'rules.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { ROUTE_PROGRAM_DOMAIN_RULES } = await import(pathToFileURL(path.join(dir, 'rules.mjs')));
test.after(() => rm(dir, { recursive: true, force: true }));

test('the support rule says the route starts from the loaded monomer, not from the bare support', () => {
  const support = ROUTE_PROGRAM_DOMAIN_RULES.find((rule) => rule.includes('solid support'));
  assert.ok(support, 'the program-mode domain rules still carry a solid-support rule');

  // It already shows the right start. What it has to add is that nothing else is a start, because
  // a model reading the prompt's "list them as purchased starting materials" takes the bare
  // support for one of them.
  assert.ok(support.includes('start(smiles="*OC(=O)'), 'the loaded-monomer example is still shown');
  assert.match(support, /only|never start|no transformation/i,
    'the rule rules out the other start rather than merely illustrating the right one');
  // The bare support specifically, since that is the string the model actually wrote.
  assert.match(support, /\*O"|bare support|free support/,
    'the rule names the bare support as what a route does not start from');
});

test('the rule does not tell the model to load the support with a transformation', () => {
  // The failure mode is the model inventing a loading operation. If the rule ever acquires a
  // loading example, this guard fails and the sentence above becomes a lie.
  const support = ROUTE_PROGRAM_DOMAIN_RULES.find((rule) => rule.includes('solid support'));
  assert.doesNotMatch(support, /named="ester-formation"/,
    'no example couples a monomer onto a bare support: the shipped SMARTS cannot run in that direction');
});
