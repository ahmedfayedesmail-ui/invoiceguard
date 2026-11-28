// Review P1-a: CI must run the WHOLE suite. --test-force-exit made node stop files early and report a smaller, varying count
// (integrity-gate alone printed 41 to 53 of its 69 tests), so a green run did not prove the full suite ran.
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { spawnSync } from 'node:child_process';
const dir = mkdtempSync(join(tmpdir(), 'ig-count-'));
const run = (log, expected) => { const l = join(dir, 'log.txt'), e = join(dir, 'exp.txt'); writeFileSync(l, log); writeFileSync(e, expected); return spawnSync(process.execPath, ['tools/check-test-count.mjs', l, e], { encoding: 'utf8' }); };
const tap = (n, extra = '') => `# tests ${n}\n# suites 0\n# pass ${n - 1}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 1\n${extra}`;
test('CC1 the count checker passes only when the log count equals the pinned count', () => {
  assert.equal(run(tap(100), '100\n').status, 0);
  const lo = run(tap(80), '100\n'); assert.equal(lo.status, 1); assert.match(lo.stderr, /80.*100|expected 100/i);
  assert.equal(run(tap(101), '100\n').status, 1, 'a larger count must also be re-pinned on purpose');
});
test('CC2 a log without a test summary, a cancelled test, or a bad pin fails', () => {
  assert.equal(run('nothing here\n', '100').status, 1);
  assert.equal(run(tap(100).replace('# cancelled 0', '# cancelled 2'), '100').status, 1);
  assert.equal(run(tap(100), 'abc').status, 1); assert.equal(run(tap(100), '').status, 1);
});
test('CC3 nothing in the repo runs the suite with --test-force-exit', () => {
  assert.doesNotMatch(JSON.parse(readFileSync('package.json', 'utf8')).scripts.test, /force-exit/);
  assert.doesNotMatch(readFileSync('.github/workflows/ci.yml', 'utf8').replace(/^\s*#.*$/gm, ''), /--test-force-exit/);
});
test('CC4 CI runs the checker against the pinned count file', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8'); assert.match(ci, /tools\/check-test-count\.mjs\s+test-output\.log\s+ci\/expected-test-count\.txt/);
  assert.match(readFileSync('ci/expected-test-count.txt', 'utf8').trim(), /^\d+$/);
});
