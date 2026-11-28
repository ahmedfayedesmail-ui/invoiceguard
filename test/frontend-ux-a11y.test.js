// swarm-frontend regression tests: UX copy accuracy, label association, keyboard access, locale labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { pct } from '../src/pdf.js';
import { LABELS } from '../src/lang.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('status pills never misdescribe a hold and the unknown outcome is labelled, not a raw token', () => {
  assert.ok(!html.includes('Held: check VAT'), 'holds are not only about VAT: missing fields and unverified rule packs also hold');
  assert.match(html, /unknown:'Outcome unknown'/, 'shipment/upload status "unknown" gets a plain-language pill');
});

test('upload size message matches the real client threshold (5.5e6 bytes, under the 6 MB server limit)', () => {
  assert.match(html, /f\.size>5\.5e6/);
  assert.match(html, /too large \(over 5\.5 MB\)/, 'message must name the same number the code enforces');
});

test('every h() label with a for attribute points at an existing input id, and the main forms are associated', () => {
  const fors = [...html.matchAll(/h\('label',\{for:'([a-z-]+)'\}/g)].map(m => m[1]);
  assert.ok(fors.length >= 20, 'expected the audited forms to be associated, got ' + fors.length);
  assert.equal(new Set(fors).size, fors.length, 'no duplicate for targets: ' + fors.join(','));
  for (const f of fors) assert.ok(html.includes(`id:'${f}'`) || html.includes(`id:'${f}'`.replace("id:'", "id:'")), 'input id missing for label target ' + f);
  for (const id of ['auth-em', 'auth-pw', 'rec-em', 'rec-pw', 'su-name', 'su-nif', 'su-addr', 'su-cty', 'sec-old', 'sec-new', 'rect-reason', 'rect-mode', 'exp-from', 'exp-to', 'exp-pdf', 'exp-fd'])
    assert.ok(html.includes(`id:'${id}'`), 'missing input id ' + id);
});

test('label-free icon inputs carry an aria-label instead', () => {
  for (const a of ['VAT number to check', 'VAT number to watch', '6-digit code from your authenticator app']) assert.ok(html.includes(`'aria-label':'${a}'`), 'missing aria-label ' + a);
});

test('dialog openers surface API failures instead of dying silently', () => {
  for (const fn of ['buyerDlg', 'trailDlg', 'checksDlg']) {
    const body = html.slice(html.indexOf('async function ' + fn));
    assert.match(body.slice(0, 400), /catch\(x\)\{toast\(x\.message\);return\}/, fn + ' must toast the API error and return');
  }
  assert.match(html, /api\('invoices\/'\+inv\.number\+'\/json'\)\}catch\(x\)\{toast\(x\.message\);return\}/, 'rectDlg load failure must be told to the user');
});

test('local checker page: the drop zone is keyboard-operable and still makes no network calls', () => {
  const page = readFileSync(new URL('../public/local/page.js', import.meta.url), 'utf8');
  assert.match(page, /\('#drop'\)\.addEventListener\('keydown'/, 'role=button drop zone needs a key handler');
  assert.match(page, /e\.target !== e\.currentTarget/, 'inner button keypresses must not double-open the picker');
  assert.ok(!/fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|indexedDB/.test(page), 'the local page stays offline');
});

test('loop page: field() associates label and input; dead settings code is gone', () => {
  const loop = readFileSync(new URL('../public/local/loop.js', import.meta.url), 'utf8');
  assert.match(loop, /el\('label', node\.id \? \{ for: node\.id \}/);
  assert.ok(!loop.includes('setSettings.length'), 'awaiting a function arity was dead code');
});

test('PDF VAT rate prints the real rate, never a rounded integer', () => {
  assert.equal(pct(0.21), '21%');
  assert.equal(pct(0.055), '5.5%');
  assert.equal(pct(0.075), '7.5%');
  assert.equal(pct(0.1), '10%');
  assert.equal(pct(0), '0%');
});

test('invoice labels: German rectifies-block title is grammatical; Spanish core terms unchanged', () => {
  assert.equal(LABELS.de['RECTIFICA A'], 'BERICHTIGT');
  assert.equal(LABELS.es['FACTURA RECTIFICATIVA'], 'FACTURA RECTIFICATIVA');
  assert.equal(LABELS.es['Base imponible'], 'Base imponible');
  assert.equal(LABELS.es['Cuota'], 'Cuota');
});

test('oversize request gets a clear 413 that does not misname the upload kind', async () => {
  const { server } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test' });
  await new Promise(r => server.listen(0, r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const big = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.es', password: 'x'.repeat(100000) }) });
    assert.equal(big.status, 413);
    const err = (await big.json()).error;
    assert.match(err, /too large/);
    assert.ok(!/PDF/.test(err), 'a login request is not a PDF: ' + err);
  } finally { server.close(); }
});
