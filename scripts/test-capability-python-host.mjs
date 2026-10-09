// How the host runs a capability's interpreter: what it reports back when the process ends
// badly, how much of its output it keeps, and what it leaves running when a call is abandoned.
// The interpreter is a real one, in a virtual environment laid out the way the host builds it;
// nothing is installed into it, because what is under test is the host's side of the pipe.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nodus-python-host-'));
const profile = path.join(scratch, 'profile');
fs.mkdirSync(profile, { recursive: true });
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

const interpreter = ['python3', 'python'].find(candidate => {
  try { execFileSync(candidate, ['-c', 'print(1)'], { stdio: 'ignore' }); return true; }
  catch { return false; }
});

const bundle = path.join(scratch, 'runtime.cjs');
await build({
  stdin: { contents: `export * from './electron/capabilities/pythonRuntime';`, resolveDir: root, loader: 'ts' },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  plugins: [{
    name: 'test-environment',
    setup(api) {
      api.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }));
      api.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `export const app={getPath:()=>${JSON.stringify(profile)},getVersion:()=>"5.8.0"};`, loader: 'js' }));
      api.onResolve({ filter: /^@shared\// }, ({ path: value }) => ({ path: path.join(root, 'shared', `${value.slice(8)}.ts`) }));
    },
  }],
});
const lib = createRequire(import.meta.url)(bundle);

const runtime = {
  capabilityId: 'nodus:probe',
  plugin: { id: 'probe', version: '1.0.0', digest: 'a'.repeat(64) },
  manifest: { id: 'probe' },
  entryPath: path.join(scratch, 'worker.js'),
  permissions: { runtimes: [{ id: 'probe', kind: 'python', minVersion: '3.10' }] },
};

function installRuntime() {
  const digest = 'b'.repeat(64);
  const dir = path.join(profile, 'plugins', 'runtimes', 'shared', digest);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'venv'))) execFileSync(interpreter, ['-m', 'venv', '--without-pip', path.join(dir, 'venv')], { stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'READY'), digest);
  const pointers = path.join(profile, 'plugins', 'runtimes', 'probe');
  fs.mkdirSync(pointers, { recursive: true });
  fs.writeFileSync(path.join(pointers, 'probe.json'), JSON.stringify({ schemaVersion: 1, lockDigest: digest, python: '3.12.0' }));
}

let scripts = 0;
const script = code => {
  const file = path.join(scratch, `script-${scripts++}.py`);
  fs.writeFileSync(file, code);
  return file;
};
const run = (code, extra = {}, signal = new AbortController().signal) =>
  lib.runInPythonRuntime(runtime, { runtimeId: 'probe', args: ['-I', script(code)], timeoutMs: 30_000, ...extra }, signal);

test('an interpreter killed by a signal is a failure, not an empty success', async (t) => {
  if (!interpreter) { t.skip('no Python interpreter on this machine'); return; }
  if (process.platform === 'win32') { t.skip('POSIX signals'); return; }
  installRuntime();
  const result = await run('import os, sys\nsys.stdout.write(\'{"partial": [1, 2\')\nsys.stdout.flush()\nos.kill(os.getpid(), 9)\n');
  assert.notEqual(result.code, 0, 'a process the kernel killed must not read as exit code 0');
  assert.match(result.stderr, /SIGKILL/);
});

test('stderr is bounded in total and keeps the end, where the traceback is', async (t) => {
  if (!interpreter) { t.skip('no Python interpreter on this machine'); return; }
  installRuntime();
  const result = await run('import sys\nfor _ in range(400): sys.stderr.write("x" * 50000)\nsys.stderr.write("THE-END")\nsys.exit(2)\n');
  assert.equal(result.code, 2);
  assert.ok(result.stderr.length <= 64_000, `kept ${result.stderr.length} characters of stderr`);
  assert.ok(result.stderr.endsWith('THE-END'));
});

test('multi-byte characters split across pipe reads arrive intact', async (t) => {
  if (!interpreter) { t.skip('no Python interpreter on this machine'); return; }
  installRuntime();
  const result = await run('import sys\nsys.stdout.write("€" * 300000)\n');
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 300_000);
  assert.ok(!result.stdout.includes('�'), 'no replacement characters');
});

test('an interpreter that exits without reading its input is reported by its exit code, not as a main-process fault', async (t) => {
  if (!interpreter) { t.skip('no Python interpreter on this machine'); return; }
  installRuntime();
  const faults = [];
  const onFault = error => faults.push(error);
  process.on('uncaughtException', onFault);
  try {
    const result = await run('import sys\nsys.exit(3)\n', { stdin: 'x'.repeat(4 * 1024 * 1024) });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(result.code, 3);
    assert.deepEqual(faults.map(error => error.code ?? error.message), []);
  } finally { process.off('uncaughtException', onFault); }
});

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (check, ms = 5_000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25)); return check(); };

test('cancelling a call also stops what the interpreter started', async (t) => {
  if (!interpreter) { t.skip('no Python interpreter on this machine'); return; }
  if (process.platform === 'win32') { t.skip('process groups are POSIX'); return; }
  installRuntime();
  const pidFile = path.join(scratch, 'helper.pid');
  const controller = new AbortController();
  const pending = run(`import subprocess, time\nhelper = subprocess.Popen(["sleep", "60"])\nopen(${JSON.stringify(pidFile)}, "w").write(str(helper.pid))\ntime.sleep(60)\n`, {}, controller.signal);
  pending.catch(() => {});
  assert.ok(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0), 'the helper started');
  const helper = Number(fs.readFileSync(pidFile, 'utf8'));
  try {
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(await waitFor(() => !alive(helper)), `the helper ${helper} outlived the cancelled call`);
  } finally { try { process.kill(helper, 'SIGKILL'); } catch { /* gone */ } }
});
