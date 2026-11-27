import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { planUpload, parseTable, detectFormat } from '../src/manual.js';
import { makeZip } from '../src/zip.js';

const HEAD = ['order-id', 'order-item-id', 'purchase-date', 'buyer-name', 'sku', 'product-name', 'quantity-purchased', 'currency', 'item-price', 'item-tax', 'shipping-price', 'shipping-tax', 'item-promotion-discount', 'ship-promotion-discount', 'recipient-name', 'ship-address-1', 'ship-city', 'ship-postal-code', 'ship-country', 'sales-channel', 'buyer-company-name', 'buyer-tax-registration-type', 'buyer-tax-registration-country', 'buyer-tax-registration-id'];
const row = (o) => HEAD.map(h => o[h] ?? '').join('\t');
const base = { 'order-item-id': '1', 'purchase-date': '2026-11-20T10:00:00+00:00', 'buyer-name': 'Ann', sku: 'S1', 'product-name': 'Widget', 'quantity-purchased': '2', currency: 'EUR', 'item-price': '121.00', 'item-tax': '21.00', 'shipping-price': '0', 'shipping-tax': '0', 'recipient-name': 'Ann', 'ship-address-1': 'Calle 1', 'ship-city': 'Madrid', 'ship-postal-code': '28001', 'ship-country': 'ES', 'sales-channel': 'Amazon.es', 'buyer-company-name': 'Cliente SL', 'buyer-tax-registration-type': 'VAT', 'buyer-tax-registration-country': 'ES', 'buyer-tax-registration-id': 'B12345674' };
const file = (...rs) => [HEAD.join('\t'), ...rs.map(r => row({ ...base, ...r }))].join('\n');

test('detects formats and refuses the All Orders report', () => {
  assert.equal(detectFormat(parseTable(file({ 'order-id': 'A' })).head), 'order');
  const all = 'amazon-order-id\titem-price\titem-tax\nA\t1\t0';
  const p = planUpload(all); assert.equal(p.ok, false); assert.match(p.error, /All Orders/);
  assert.equal(planUpload('hello world').ok, false);
  assert.equal(planUpload('a,b,c\n1,2,3').ok, false, 'csv is refused with a plain reason');
});

test('order report: a preview only. Every order is held with a reason, nothing is ready, whatever option is passed', () => {
  const rs = [{ 'order-id': 'OK1' }, { 'order-id': 'CONS', 'buyer-company-name': '', 'buyer-tax-registration-id': '' }, { 'order-id': 'PROMO', 'item-promotion-discount': '5.00' }, { 'order-id': 'ODD', 'item-price': '100.00', 'item-tax': '13.37' }, { 'order-id': 'TXT', 'item-price': 'abc' }];
  for (const opts of [{}, { useDeliveryAddress: true }, { useDeliveryAddress: true, sellerDeclaration: { isBusiness: true, isAmazonInvoiced: false } }]) {
    const p = planUpload(file(...rs), opts); assert.equal(p.ok, true); assert.equal(p.shipments.length, 0); assert.equal(p.skipped.length, 0); assert.equal(p.held.length, 5);
    assert.ok(p.held.every(h => /VAT Invoice Data Report/.test(h.reason)));
  }
});

test('vidr preview: consumer and non-invoiceable rows are skipped up front, not promised as invoices', () => {
  const p = planUpload(readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'));
  assert.equal(p.ok, true);
  assert.equal(p.format, 'vidr');
  assert.equal(p.shipments.length, 4, 'only the 4 business shipments the engine will actually attempt');
  assert.equal(p.skipped.length, 2, 'the 2 rows with no buyer company are counted as skipped, matching issue-time behaviour');
  assert.ok(p.skipped.every(s => s.why && s.why.length > 10));
});

test('zip writer produces a valid archive', () => {
  const d = mkdtempSync(join(tmpdir(), 'z-')), f = join(d, 'a.zip');
  writeFileSync(f, makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/ü.csv', data: Buffer.alloc(5000, 7) }]));
  try { assert.match(execFileSync('unzip', ['-t', f]).toString(), /No errors detected/); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
});

test('manual journey: upload, hold, issue, pack, mark as uploaded; no sync', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 24, 10, 30, 0) }); // fixed clock 30 min after the last fixture shipment (due = shipment + 24 h): the issue-window check is deterministic
  const { server } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test', env: { ALLOW_MANUAL_UPLOAD: '1' } }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) }); const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0];
    return { status: r.status, body: (r.headers.get('content-type') || '').includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }; };
  await call('signup', { email: 'man@x.es', password: 'Long-Enough-Pw-42!' });
  await call('seller', { name: 'Tienda Demo S.L.', nif: 'b11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] });
  assert.equal((await call('amazon/connect', { manual: true })).body.mode, 'manual');
  assert.equal((await call('sync', {})).status >= 400, true);
  const orderText = file({ 'order-id': 'M1' });
  assert.equal((await call('manual/issue', { text: orderText, useDeliveryAddress: true, attest: true, sellerDeclaration: { isBusiness: true, isAmazonInvoiced: false } })).body.issued, 0, 'the Order Report is a preview: nothing is issued from it, declaration or not');
  const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
  assert.equal((await call('manual/preview', { text: 'nope' })).status, 400);
  assert.equal((await call('manual/issue', { text })).status, 400, 'needs the checks');
  const r = (await call('manual/issue', { text, attest: true })).body;
  assert.equal(r.issued, 3); assert.equal(r.heldNow, 1);
  assert.equal((await call('manual/issue', { text, attest: true })).body.issued, 0, 'no duplicate');
  const d = (await call('dashboard')).body; assert.equal(d.kpis.ready, 3); assert.equal(d.invoices.length, 3);
  const zip = await call('pack'); assert.equal(zip.body.subarray(0, 2).toString(), 'PK'); assert.match(zip.body.toString('latin1'), /manifest\.csv/);
  assert.equal((await call('invoices/mark', { numbers: [d.invoices[0].number] })).body.marked, 1);
  assert.equal((await call('invoices/mark', { all: true })).body.marked, 2); assert.equal((await call('invoices/mark', { all: true })).body.marked, 0);
  assert.equal((await call('pack')).status, 404);
  const d2 = (await call('dashboard')).body; assert.equal(d2.kpis.ready, 0); assert.equal(d2.kpis.uploaded, 3);
  const tr = (await call('invoices/' + d.invoices[0].number + '/trail')).body;
  assert.equal(tr.number, d.invoices[0].number); assert.ok(tr.issuedAt); assert.ok(tr.orderId);
  const types = tr.events.map(e => e.type);
  assert.ok(types.includes('detected'), 'trail starts at detection');
  assert.ok(types.includes('issued_manual')); assert.ok(types.includes('exported')); assert.ok(types.includes('uploaded'));
  assert.ok(tr.dueAt, 'a due date is recorded'); assert.ok(new Date(tr.issuedAt) <= new Date(tr.dueAt), 'issued inside the upload window'); assert.equal(tr.issuedAt.slice(0, 10), '2026-11-24', 'the injected clock is what issued it');
  assert.equal((await call('invoices/A-2026-999999/trail')).status, 404);
  server.close(); mock.timers.reset();
});

test('leaving demo mode removes the sample data and lands on the upload route', async () => {
  const { server } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test', env: { ALLOW_MANUAL_UPLOAD: '1' } }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) }); const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0]; return { status: r.status, body: await r.json().catch(() => null) }; };
  await call('signup', { email: 'dm@x.es', password: 'Long-Enough-Pw-42!' });
  await call('seller', { name: 'Tienda Demo S.L.', nif: 'b11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] });
  await call('amazon/connect', { demo: true }); await call('sync', {});
  assert.ok((await call('dashboard')).body.kpis.total > 0);
  assert.equal((await call('amazon/connect', { manual: true })).body.mode, 'manual');
  const d = (await call('dashboard')).body; assert.equal(d.kpis.total, 0); assert.equal(d.invoices.length, 0); assert.equal(d.conn.mode, 'manual');
  assert.equal((await call('audit/verify')).body.ok, true);
  server.close();
});
