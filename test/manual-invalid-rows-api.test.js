// Requested by Main (relay of 20:56, Nov 27): the seller must SEE quarantined rows on both manual routes. Synthetic data only. Local.
// manual/preview and manual/issue return invalidRowsCount, invalidRows (line number, reason, cells found and expected, NEVER cell content) and a plain warning. A clean file returns 0, [] and no warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';

const FX = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const H = FX.split('\n')[0].split('\t'); const col = (k) => H.indexOf(k);
const splitRow = (text, line, colName, value) => text.split('\n').map((l, i) => { if (i !== line) return l; const c = l.split('\t'); while (c.length < H.length) c.push(''); c[col(colName)] = value; return c.join('\t'); }).join('\n');
const SECRET_TEXT = 'ZZSECRETNAME\nQQSECRETTAIL';
async function boot(email) {
  const { server } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test', env: { ALLOW_MANUAL_UPLOAD: '1' } }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) }); const sc = r.headers.get('set-cookie'); if (sc) sid = sc.split(';')[0]; return { status: r.status, body: await r.json() }; };
  await call('signup', { email, password: 'Long-Enough-Pw-42!' });
  await call('seller', { name: 'Tienda Demo S.L.', nif: 'b11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] });
  assert.equal((await call('amazon/connect', { manual: true })).body.mode, 'manual');
  return { server, call };
}
const broken = splitRow(FX.replace(/\n+$/, '\n'), 1, 'billing-name', SECRET_TEXT);

for (const route of ['manual/preview', 'manual/issue']) {
  test(`${route}: a split row is reported to the seller (count, line numbers, reasons, a warning) and shows no cell content`, async () => {
    const { server, call } = await boot(`inv-${route.replace('/', '-')}@x.es`);
    const r = await call(route, { text: broken, attest: true });
    server.close();
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.invalidRowsCount, 2, JSON.stringify(r.body.invalidRows));
    assert.equal(r.body.invalidRows.length, 2);
    for (const x of r.body.invalidRows) { assert.equal(typeof x.line, 'number'); assert.equal(typeof x.reason, 'string'); assert.ok(x.reason.length > 10); assert.deepEqual(Object.keys(x).sort(), ['cells', 'expected', 'line', 'reason']); }
    assert.equal(typeof r.body.warning, 'string'); assert.match(r.body.warning, /2 lines? .*not (used|read)|could not be read/i);
    const s = JSON.stringify(r.body); assert.ok(!s.includes('ZZSECRET') && !s.includes('QQSECRET'), 'no cell content in the response');
    if (route === 'manual/issue') assert.ok(r.body.issued >= 0 && r.body.errors === 0);
  });
  test(`${route}: a clean file reports 0, an empty list and no warning`, async () => {
    const { server, call } = await boot(`ok-${route.replace('/', '-')}@x.es`);
    const r = await call(route, { text: FX, attest: true });
    server.close();
    assert.equal(r.status, 200);
    assert.equal(r.body.invalidRowsCount, 0); assert.deepEqual(r.body.invalidRows, []); assert.equal(r.body.warning ?? null, null);
  });
}
test('both routes agree on the numbers for the same file, and the split row is not among the invoices', async () => {
  const a = await boot('agree1@x.es'); const p = await a.call('manual/preview', { text: broken }); const i = await a.call('manual/issue', { text: broken, attest: true }); a.server.close();
  assert.equal(p.body.invalidRowsCount, i.body.invalidRowsCount); assert.deepEqual(p.body.invalidRows, i.body.invalidRows);
  const clean = await boot('agree2@x.es'); const c = await clean.call('manual/issue', { text: FX, attest: true }); clean.server.close();
  assert.equal(i.body.issued + i.body.heldNow + i.body.skippedAlready <= c.body.issued + c.body.heldNow + c.body.skippedAlready, true);
});
