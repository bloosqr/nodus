import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'nodus-cut-off-retry-'));
const outfile = path.join(tmp, 'cutOffRetry.mjs');
await build({ entryPoints: [path.join(root, 'electron/ai/cutOffRetry.ts')], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const { retryOnceWhenCutOff } = await import(pathToFileURL(outfile).href);
const effortFile = path.join(tmp, 'researchReasoning.mjs');
await build({ entryPoints: [path.join(root, 'shared/researchReasoning.ts')], outfile: effortFile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const { reducedResearchEffort } = await import(pathToFileURL(effortFile).href);
test.after(() => rm(tmp, { recursive: true, force: true }));

class Cut extends Error { code = 'output_truncated'; }
const isCutOff = (error) => error instanceof Cut;
const calls = (...outcomes) => { let n = 0; const fn = async () => { const o = outcomes[n++]; if (o instanceof Error) throw o; return o; }; fn.count = () => n; return fn; };

test('a cut-off answer is retried once and the retry is returned', async () => {
  const write = calls(new Cut('cut'), 'answer');
  let resets = 0;
  assert.equal(await retryOnceWhenCutOff(write, { isCutOff, beforeRetry: () => resets++ }), 'answer');
  assert.equal(write.count(), 2);
  assert.equal(resets, 1, 'the provisional stream is cleared before the retry');
});

test('a second cut-off is thrown; other errors are never retried', async () => {
  await assert.rejects(retryOnceWhenCutOff(calls(new Cut('1'), new Cut('2')), { isCutOff }), /2/);
  const other = calls(new Error('network'), 'never');
  await assert.rejects(retryOnceWhenCutOff(other, { isCutOff }), /network/);
  assert.equal(other.count(), 1);
});

test('a cancelled turn is not retried', async () => {
  const controller = new AbortController(); controller.abort();
  const write = calls(new Cut('cut'), 'never');
  await assert.rejects(retryOnceWhenCutOff(write, { isCutOff, signal: controller.signal }), /cut/);
  assert.equal(write.count(), 1);
});

test('a first answer is returned without a retry', async () => {
  const write = calls('first');
  assert.equal(await retryOnceWhenCutOff(write, { isCutOff }), 'first');
  assert.equal(write.count(), 1);
});

test('the retry asks for less thinking than the attempt that was cut off', async () => {
  // The original retry repeated the request unchanged, and its docstring said so. Measured
  // 2026-10-12 on four hard synthesis targets at thinking high: each spent the whole
  // 149,422-token output ceiling on reasoning and wrote nothing, this retry fired on all four
  // (its log line appears four times in that suite's app.log), and all four were cut off a
  // second time. Repeating a thinking-budget failure reproduces it.
  const efforts = [];
  const cutOff = Object.assign(new Error('cut off'), { code: 'output_truncated' });
  const write = async (isRetry) => {
    efforts.push(isRetry);
    if (!isRetry) throw cutOff;
    return 'the answer';
  };
  const answer = await retryOnceWhenCutOff(write, { isCutOff: (e) => e?.code === 'output_truncated' });
  assert.equal(answer, 'the answer');
  assert.deepEqual(efforts, [false, true], 'the second call must be told it IS the retry');
});

test('one rung down, and never below the ladder', () => {
  // The caller's half of the contract: what "less thinking" means.
  assert.equal(reducedResearchEffort('high'), 'medium');
  assert.equal(reducedResearchEffort('xhigh'), 'high');
  assert.equal(reducedResearchEffort('medium'), 'low');
  assert.equal(reducedResearchEffort('low'), 'minimal');
  // Nothing below the floor, and the levels that are not sizes cannot be lowered at all.
  assert.equal(reducedResearchEffort('minimal'), null);
  for (const effort of ['standard', 'none', 'off', 'on', undefined]) {
    assert.equal(reducedResearchEffort(effort), null, `${effort} is not a budget that can be stepped down`);
  }
  // A step, not a jump to the floor: the answer needs room, not the smallest budget available.
  assert.notEqual(reducedResearchEffort('ultra'), 'minimal');
});
