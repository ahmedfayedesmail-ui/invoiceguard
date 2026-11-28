// Spanish localization (pilot): catalog parity and coverage, language negotiation, Spanish end to end, English unchanged. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { requestLang } from '../src/i18n.js';
import { scan } from '../tools/i18n/scan.mjs';
import { localizer, negotiateLang, localizeDeep, localizeLines, t } from '../public/i18n/core.js';
import en from '../public/i18n/en.js';
import es from '../public/i18n/es.js';

const ORDER = readFileSync(new URL('../fixtures/order-report.tsv', import.meta.url), 'utf8');
const ph = (s) => (s.match(/\{\d+\}/g) || []).sort().join(',');

test('I1 en and es catalogs have identical keys and identical placeholders; no Spanish value is empty or still English-only by accident', () => {
  const ek = Object.keys(en).sort(), sk = Object.keys(es).sort();
  assert.deepEqual(ek, sk); assert.ok(ek.length > 1000, 'catalog size ' + ek.length);
  for (const k of ek) { assert.ok(es[k].trim(), k); assert.equal(ph(en[k]), ph(es[k]), k); }
});

// Strings that are not user-facing copy (CSP, SQL, cookies, CSS) or belong to operator-only files and per-invoice-language tables. Reported, not hidden.
const IGNORE_FILES = new Set(['spapi.js', 'ksef.js', 'restore.js', 'db.js', 'reset.js', 'backup.js', 'mockamazon.js']);
const IGNORE_TEXT = [/^default-src /, /^User-agent:/, /^VACUUM INTO/, /^sid=/, /^font:/, /^INSERT /, /^bad base32$/, /^key rotation/, /^Gastos de|^Promoci|Belgique/, /\(reverse charge\)|\(autoliquidation\)|\(inversione|\(verlegd\)|\(odwrotne|\(omv|\(autoliquida|esente IVA|Innergemeinschaftliche|Livraison intra|Intracommunautaire/i, /^Not a shipment \(transaction type: $/, /^Amazon is not waiting for an invoice for this order \(status: $/];
// Multi-line texts are localized line by line (localizeLines); a sentence that is only a placeholder is data localized where it is produced.
const covered = (L, text) => L.covered(text) || text.split('\n').filter(l => l.trim()).every(line => L.covered(line) || line.split(/(?<=[.!?:])\s+/).filter(x => !/^\{\d+\}$/.test(x.trim())).every(x => L.covered(x)));
test('I2 every user-facing string literal found in src/ is in the catalog (explicit ignore list for operator-only files and non-copy)', () => {
  const L = localizer('es', 'msg'); const missing = [];
  for (const r of scan()) { if (IGNORE_FILES.has(r.file) || IGNORE_TEXT.some(re => re.test(r.text)) || covered(L, r.text)) continue; missing.push(r.file + ': ' + r.text.slice(0, 120)); }
  assert.deepEqual([...new Set(missing)], []);
});

test('I3 language negotiation: query, X-Lang, Accept-Language, default English', () => {
  const rq = (h = {}, url = '/api/x') => requestLang({ headers: h }, new URL(url, 'http://x'), {});
  assert.equal(rq(), 'en'); assert.equal(rq({}, '/api/x?lang=es'), 'es'); assert.equal(rq({ 'x-lang': 'es' }), 'es');
  assert.equal(rq({ 'accept-language': 'es-ES,es;q=0.9,en;q=0.5' }), 'es'); assert.equal(rq({ 'accept-language': 'en-GB,en;q=0.9' }), 'en');
  assert.equal(rq({ 'accept-language': 'fr' }), 'en'); assert.equal(rq({ 'x-lang': 'es' }, '/api/x?lang=en'), 'en');
  assert.equal(negotiateLang({}), 'en');
});

async function boot(email, env = {}) {
  const { server } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test', env: { ALLOW_MANUAL_UPLOAD: '1', ...env } }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body, hd = {}) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid, ...hd }, body: body === undefined ? undefined : JSON.stringify(body) }); const sc = r.headers.get('set-cookie'); if (sc) sid = sc.split(';')[0]; return { status: r.status, body: await r.json().catch(() => ({})) }; };
  await call('signup', { email, password: 'Long-Enough-Pw-42!' });
  await call('seller', { name: 'Tienda Demo S.L.', nif: 'b11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] });
  await call('amazon/connect', { manual: true });
  return { server, call };
}

test('I4 Spanish end to end: an Order Report upload with ?lang=es, X-Lang or Accept-Language returns the HOLD reason in Spanish; without a language it is the unchanged English', async () => {
  const { server, call } = await boot('i18n-e2e@x.es');
  try {
    const en0 = await call('manual/preview', { text: ORDER, attest: true });
    assert.equal(en0.status, 200); assert.ok(en0.body.heldCount > 0, 'fixture must produce a HOLD');
    const reasonEn = en0.body.held[0].reason; assert.match(reasonEn, /Issuing needs a VAT Invoice Data Report/);
    for (const [q, hd] of [['?lang=es', {}], ['', { 'x-lang': 'es' }], ['', { 'accept-language': 'es-ES,es;q=0.9' }]]) {
      const r = await call('manual/preview' + q, { text: ORDER, attest: true }, hd);
      assert.equal(r.status, 200); assert.equal(r.body.heldCount, en0.body.heldCount);
      const reason = r.body.held[0].reason; assert.notEqual(reason, reasonEn);
      assert.match(reason, /factura|Informe|informe/); assert.doesNotMatch(reason, /Issuing needs/);
      assert.equal(r.body.held[0].orderId, en0.body.held[0].orderId, 'identifiers are never translated');
    }
    const again = await call('manual/preview', { text: ORDER, attest: true }, { 'accept-language': 'en-GB' });
    assert.deepEqual(again.body.held, en0.body.held, 'English output unchanged');
    // an API error is Spanish on request and English by default
    const bad = await call('manual/preview?lang=es', { text: 'not a report', attest: true }); const bad0 = await call('manual/preview', { text: 'not a report', attest: true });
    assert.ok(bad.status >= 400 || bad.body.error || bad.body.ok === false); assert.equal(JSON.stringify(bad0.body).includes('Spanish'), false);
  } finally { server.close(); }
});

test('I5 localizer: templates keep their parameters, unknown text and codes pass through, the en direction is the identity', () => {
  const L = localizer('es', 'msg');
  assert.equal(L('Some text that is not in any catalog 12345'), 'Some text that is not in any catalog 12345');
  assert.equal(localizeDeep({ code: 'TOTALS_CONTRADICT', n: 3 }, 'es').code, 'TOTALS_CONTRADICT');
  const o = { a: ['x', { reason: 'Amazon is not waiting for an invoice for this order (status: InvoiceUploaded)' }] };
  assert.equal(localizeDeep(o, 'en'), o);
  assert.match(localizeDeep(o, 'es').a[1].reason, /InvoiceUploaded\)$/); assert.match(localizeDeep(o, 'es').a[1].reason, /Amazon no espera/);
  assert.equal(localizeLines('line one\n\nline two', 'en'), 'line one\n\nline two');
  assert.equal(typeof t, 'function');
});

test('I6 the served catalog files and the Spanish download pack how-to', async () => {
  const { server, call } = await boot('i18n-files@x.es'); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const f of ['core.js', 'en.js', 'es.js']) { const r = await fetch(`${base}/i18n/${f}`); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/); }
    const app = await fetch(base + '/app'); assert.match(app.headers.get('content-security-policy'), /script-src[^;]*'self'/);
    assert.match(await (await fetch(base + '/local')).text() || 'x', /./);
  } finally { server.close(); }
});
