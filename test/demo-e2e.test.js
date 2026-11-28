// The local demo must keep working and keep telling the truth: it is the product's showable end-to-end path (synthetic data only).
import test from 'node:test'; import assert from 'node:assert/strict'; import { spawnSync } from 'node:child_process';
test('DEMO the end-to-end demo runs, shows the hold before the decision, the replacement only after the proven acceptance, the contradiction hold and the terminal-state refusal', () => {
  const r = spawnSync('node', ['--no-warnings', new URL('../tools/demo-e2e.mjs', import.meta.url).pathname], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); const o = r.stdout;
  assert.match(o, /status: submitted; replacements issued: 0/); assert.match(o, /HOLD CREDIT_NOTE_IDENTITY_UNPROVEN \(OPEN\)/); assert.match(o, /credit note status: uploaded\n\n5\. [^\n]*\n   replacements issued: 1/); assert.match(o, /HOLD CREDIT_NOTE_VERDICT_CONTRADICTION \(OPEN\)/); assert.match(o, /refused: state machine/); assert.match(o, /no real Amazon report was used/); assert.doesNotMatch(o, /undefined/);
});
