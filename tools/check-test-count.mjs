// Usage: node tools/check-test-count.mjs <test-output.log> <expected-count-file>
// Fails unless the suite log reports exactly the pinned number of tests, none cancelled. Re-pin ci/expected-test-count.txt on purpose when tests are added or removed.
import { readFileSync } from 'node:fs';
const [logPath, pinPath] = process.argv.slice(2); const fail = (m) => { console.error('TEST COUNT CHECK FAILED: ' + m); process.exit(1); };
if (!logPath || !pinPath) fail('usage: check-test-count.mjs <log> <pin-file>');
const pinText = readFileSync(pinPath, 'utf8').trim(); if (!/^\d+$/.test(pinText)) fail(`the pin file does not hold a whole number (${JSON.stringify(pinText.slice(0, 20))})`);
const expected = Number(pinText); const log = readFileSync(logPath, 'utf8'); const num = (k) => { const m = [...log.matchAll(new RegExp('^# ' + k + ' (\\d+)\\s*$', 'gm'))]; return m.length ? Number(m[m.length - 1][1]) : null; };
const tests = num('tests'); if (tests == null) fail('no "# tests" summary line in the log, so the suite did not finish');
const cancelled = num('cancelled') ?? 0; if (cancelled > 0) fail(`${cancelled} test(s) were cancelled`);
if (tests !== expected) fail(`the suite reported ${tests} tests but ${expected} are pinned (expected ${expected}). A smaller number can mean files were cut short; a larger one needs a deliberate re-pin in ci/expected-test-count.txt.`);
console.log(`test count OK: ${tests} tests, pinned ${expected}`);
