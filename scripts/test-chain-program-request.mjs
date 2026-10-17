// The contract that lets a program-mode answer ASK for a route instead of writing one.
//
// Why this file exists. The request is the only thing the model writes in this path, so everything
// downstream — the generator call, the executed program, the audit, the drawings — is decided by
// how one small JSON object is read. Two failures are possible and neither of them errors:
//
//  1. The reader accepts something the generator will reject, and the turn spends a worker call to
//     come back with a message the model cannot act on.
//  2. The contract DESCRIBES a shape the reader refuses. That is the failure this project has
//     already hit once, in the sibling program contract: a rule that cannot be followed looks
//     exactly like a model that will not follow it. So the JSON written in the rule is parsed here
//     by the same function the application uses, and the test fails if they ever disagree.
//
// It also pins the three-way answer — a request, a refusal with a reason, or nothing asked — since
// the caller branches on it and the middle case is the one that has somewhere to go.
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(path.join(os.tmpdir(), 'chain-program-request-'));
process.on('exit', () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // left for the OS to reap
  }
});

const bundle = async (entry, name) => {
  const outfile = path.join(dir, name);
  const built = await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', write: false });
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  fs.writeFileSync(outfile, built.outputFiles[0].contents);
  return import(pathToFileURL(outfile).href);
};

const { findChainProgramRequest, asksForChainProgram, uncheckedRouteNote, CHAIN_PROGRAM_MAX_RESIDUES, CHAIN_PROGRAM_MAX_CODE } =
  await bundle('shared/moleculeInspection.ts', 'moleculeInspection.mjs');
const { ROUTE_CHAIN_PROGRAM_RULE } = await bundle('shared/routeRules.ts', 'routeRules.mjs');

const fenced = (body) => `Here is the assembly.\n\n\`\`\`chain-program\n${body}\n\`\`\`\n\nThe check has not run yet.`;

test('a well-formed request gives the sequence, trimmed, in order', () => {
  const found = findChainProgramRequest(fenced('{"sequence": [" Gly ", "Ala", "Ser", "Val"]}'));
  assert.deepEqual(found, { sequence: ['Gly', 'Ala', 'Ser', 'Val'] });
});

test('the dipeptide flag is carried only when it is asked for', () => {
  assert.deepEqual(findChainProgramRequest(fenced('{"sequence": ["Gly"], "dipeptides": true}')), { sequence: ['Gly'], dipeptides: true });
  // Absent rather than `false`, so the input sent to the generator holds only what was asked.
  assert.deepEqual(findChainProgramRequest(fenced('{"sequence": ["Gly"], "dipeptides": false}')), { sequence: ['Gly'] });
});

test('an answer that asks for nothing is null, not an error', () => {
  assert.equal(findChainProgramRequest('A route program follows.\n\n```route-program\nM1 = start("glycine")\ntarget = M1\n```'), null);
  assert.equal(findChainProgramRequest(''), null);
  assert.equal(findChainProgramRequest(undefined), null);
});

test('prose that merely mentions the fence name does not count as a request', () => {
  assert.equal(findChainProgramRequest('I could ask for a chain-program block here, but this route is cyclic.'), null);
});

test('every malformed request names what is wrong with it', () => {
  const reason = (body) => {
    const found = findChainProgramRequest(fenced(body));
    assert.ok(found && 'error' in found, `expected a refusal for ${body}`);
    return found.error;
  };
  assert.match(reason(''), /empty/i);
  assert.match(reason('sequence: Gly, Ala'), /not valid JSON/i);
  assert.match(reason('["Gly", "Ala"]'), /not a JSON object/i);
  assert.match(reason('{"residues": ["Gly"]}'), /names no sequence/i);
  assert.match(reason('{"sequence": []}'), /names no sequence/i);
  assert.match(reason('{"sequence": ["Gly", 7]}'), /non-empty string/i);
  assert.match(reason('{"sequence": ["Gly", "  "]}'), /non-empty string/i);
  assert.match(reason('{"sequence": ["Gly"], "dipeptides": "yes"}'), /true or false/i);
});

test('a sequence past the declared ceiling is refused here, with the number it asked for', () => {
  const asked = CHAIN_PROGRAM_MAX_RESIDUES + 1;
  const found = findChainProgramRequest(fenced(JSON.stringify({ sequence: Array.from({ length: asked }, () => 'Gly') })));
  assert.ok(found && 'error' in found);
  assert.match(found.error, new RegExp(`${CHAIN_PROGRAM_MAX_RESIDUES} residues`));
  assert.match(found.error, new RegExp(`names ${asked}`));
});

test('the ceiling itself is accepted', () => {
  const found = findChainProgramRequest(fenced(JSON.stringify({ sequence: Array.from({ length: CHAIN_PROGRAM_MAX_RESIDUES }, () => 'Gly') })));
  assert.ok(found && !('error' in found));
  assert.equal(found.sequence.length, CHAIN_PROGRAM_MAX_RESIDUES);
});

test('only the first fence counts: one route per answer', () => {
  const two = `${fenced('{"sequence": ["Gly", "Ala"]}')}\n\n${fenced('{"sequence": ["Lys"]}')}`;
  assert.deepEqual(findChainProgramRequest(two), { sequence: ['Gly', 'Ala'] });
});

// The load-bearing one. A rule that describes a shape its own reader refuses is unfollowable, and
// a model that obeys it looks like a model that ignored it.
test('every JSON object written in the contract is one the reader accepts', () => {
  const objects = ROUTE_CHAIN_PROGRAM_RULE.match(/\{[^{}]*\}/g) ?? [];
  assert.ok(objects.length >= 1, 'the contract shows no example request');
  for (const object of objects) {
    const found = findChainProgramRequest(fenced(object));
    assert.ok(found, `the contract's example was not read as a request at all: ${object}`);
    assert.ok(!('error' in found), `the contract shows a request its own reader refuses: ${object} — ${found.error ?? ''}`);
  }
});

test('the contract names the fence it is asking for, and the generator behind it', () => {
  assert.match(ROUTE_CHAIN_PROGRAM_RULE, /`chain-program`/);
  assert.match(ROUTE_CHAIN_PROGRAM_RULE, /"sequence"/);
  // The refusal path has to be reachable from the contract, or a refused request has nowhere to go.
  assert.match(ROUTE_CHAIN_PROGRAM_RULE, /refused/i);
});

// uncheckedRouteNote is what a program-mode turn says when it found no route. A request IS the
// route here, so saying "this reply carried no route program" over one contradicts the report
// directly above it — which is the exact failure recorded for the misfenced-program case.
test('a turn that asked for a chain is not also told it carried no route', async (t) => {
  const previous = process.env.NODUS_ROUTE_PROGRAM;
  process.env.NODUS_ROUTE_PROGRAM = 'on';
  t.after(() => { if (previous === undefined) delete process.env.NODUS_ROUTE_PROGRAM; else process.env.NODUS_ROUTE_PROGRAM = previous; });

  assert.equal(uncheckedRouteNote(fenced('{"sequence": ["Gly", "Ala"]}'), { correction: false }), '');
  // A request that could not be read is still a request: it was answered in the report with the
  // reason, so this note stays silent rather than adding a second, different complaint.
  assert.equal(uncheckedRouteNote(fenced('{"sequence": []}'), { correction: false }), '');
  assert.equal(asksForChainProgram(fenced('{"sequence": []}')), true);
  // And an answer with neither a program nor a request still gets told, as it always did.
  assert.match(uncheckedRouteNote('I would protect the side chain first.', { correction: false }), /Nothing in this reply was checked/);
});

test('a residue code longer than the package accepts is refused here, not at the worker', () => {
  // /code-review on 4b55444a: the reader mirrored the package schema's minItems/maxItems but not
  // its `items.maxLength: 8`, so `{"sequence": ["Fmoc-Lys(Boc)"]}` passed, spent the worker
  // round-trip the residue ceiling exists to avoid, and came back as a python SystemExit string.
  const refused = findChainProgramRequest('```chain-program\n{"sequence": ["Gly", "Fmoc-Lys(Boc)"]}\n```');
  assert.ok(refused && 'error' in refused, JSON.stringify(refused));
  assert.match(refused.error, /Fmoc-Lys\(Boc\)/, `the offending code is quoted: ${refused.error}`);
  assert.match(refused.error, new RegExp(String(CHAIN_PROGRAM_MAX_CODE)), `the limit is given: ${refused.error}`);
  assert.match(refused.error, /\bLys\b/, `the form that works is shown: ${refused.error}`);

  // A real three-letter code, and the longest the limit allows, both still pass.
  for (const code of ['Gly', 'A'.repeat(CHAIN_PROGRAM_MAX_CODE)]) {
    const ok = findChainProgramRequest(`\`\`\`chain-program\n{"sequence": ["${code}"]}\n\`\`\``);
    assert.deepEqual(ok, { sequence: [code] }, `\`${code}\` is accepted`);
  }
});

test('both residue limits match the installed package manifest', async (t) => {
  // The doc comments claim to mirror the schema. Nothing checked it, so the two could drift and
  // the reader would start refusing what the generator accepts, or the reverse.
  const marketplace = [
    process.env.NODUS_MARKETPLACE_DIR,
    path.resolve(process.cwd(), '../marketplace'),
    path.resolve(process.cwd(), '../../../../marketplace'),
  ].filter(Boolean).find((candidate) => fs.existsSync(path.join(candidate, 'plugins/chemistry-studio/capabilities/chemistry/capability.json')));
  if (!marketplace) { t.skip('no marketplace checkout beside this one; set NODUS_MARKETPLACE_DIR'); return; }

  const capability = JSON.parse(fs.readFileSync(path.join(marketplace, 'plugins/chemistry-studio/capabilities/chemistry/capability.json'), 'utf8'));
  const tool = capability.tools.find((entry) => entry.id === 'generate-chain-program');
  assert.ok(tool, 'the package still declares generate-chain-program');
  const sequence = tool.inputSchema.properties.sequence;
  assert.equal(sequence.maxItems, CHAIN_PROGRAM_MAX_RESIDUES,
    `CHAIN_PROGRAM_MAX_RESIDUES is ${CHAIN_PROGRAM_MAX_RESIDUES} and the manifest says ${sequence.maxItems}`);
  assert.equal(sequence.items.maxLength, CHAIN_PROGRAM_MAX_CODE,
    `CHAIN_PROGRAM_MAX_CODE is ${CHAIN_PROGRAM_MAX_CODE} and the manifest says ${sequence.items.maxLength}`);
});
