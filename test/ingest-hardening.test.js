// swarm/ingest-hardening: regression tests for readiness-audit findings F2, F3, F4. Synthetic data only.
// F2: a report column the parser does not read must never be dropped silently - a row carrying data in it holds the shipment.
// F3: the optional-trailing-columns tolerance is derived from the file's own header order, not a fixed guess.
// F4: the manual-upload 413 names the real limit, and the upload UI states it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkTsv, parseVidr, READ_COLUMNS } from '../src/vidr.js';
import { planUpload } from '../src/manual.js';
import { createApp } from '../src/app.js';

// Amazon's documented VIDR attribute order: citation-es sits MID-header, buyer-nip/seller-nip close it.
const HEAD = ['order-id', 'order-item-id', 'shipping-id', 'transaction-id', 'transaction-type', 'marketplace-id', 'order-date', 'shipment-date', 'sku', 'product-name', 'quantity-purchased', 'currency', 'item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'item-vat-rate', 'bottle-deposit-vat-excl-amount', 'bottle-deposit-vat-amount', 'export-outside-eu', 'recommended-invoice-format', 'buyer-e-invoice-account-id', 'is-business-order', 'is-amazon-invoiced', 'invoice-status', 'seller-vat-number', 'buyer-vat-number', 'billing-name', 'bill-address-1', 'bill-city', 'bill-postal-code', 'bill-country', 'ship-country', 'ship-from-country', 'buyer-company-name', 'buyer-tax-registration-type', 'citation-es', 'buyer-nip', 'seller-nip'];
const BASE = { 'order-id': '111-2222222-3333333', 'order-item-id': '1', 'shipping-id': 'SHP1', 'transaction-id': 'TX1', 'transaction-type': 'SHIPMENT', 'marketplace-id': 'A1RKKUPIHCS9HS', 'order-date': '2026-11-01', 'shipment-date': '2026-11-02', 'sku': 'SKU1', 'product-name': 'Widget', 'quantity-purchased': '1', 'currency': 'EUR', 'item-vat-incl-amount': '121.00', 'item-vat-amount': '21.00', 'item-vat-excl-amount': '100.00', 'item-vat-rate': '21', 'is-business-order': 'TRUE', 'is-amazon-invoiced': 'FALSE', 'invoice-status': 'InvoicePending', 'seller-vat-number': 'ESB11111111', 'buyer-vat-number': 'ESB22222222', 'billing-name': 'Comprador S.L.', 'bill-address-1': 'Calle Falsa 1', 'bill-city': 'Madrid', 'bill-postal-code': '28001', 'bill-country': 'ES', 'ship-country': 'ES', 'ship-from-country': 'ES', 'buyer-company-name': 'Comprador S.L.', 'buyer-tax-registration-type': 'VAT' };
const row = (over = {}) => HEAD.map(h => (over[h] ?? BASE[h] ?? '')).join('\t');
const tsv = (rows, head = HEAD) => head.join('\t') + '\n' + rows.join('\n') + '\n';

test('F2: a row with bottle-deposit data is held, not issued, and the deposit is named', () => {
  const plan = planUpload(tsv([row({ 'bottle-deposit-vat-excl-amount': '0.50', 'bottle-deposit-vat-amount': '0.10' })]));
  assert.equal(plan.ok, true);
  assert.equal(plan.shipments.length, 0, 'nothing may be issued from a row whose bottle deposit would be dropped');
  assert.equal(plan.held.length, 1);
  assert.match(plan.held[0].reason, /bottle-deposit-vat-excl-amount/);
  assert.match(plan.held[0].reason, /not dropped silently/);
});

test('F2: empty unsupported columns stay fine (same file, deposit columns blank)', () => {
  const plan = planUpload(tsv([row()]));
  assert.equal(plan.ok, true);
  assert.equal(plan.held.length, 0, JSON.stringify(plan.held));
  assert.equal(plan.shipments.length, 1);
  assert.equal(plan.shipments[0].incl, 121);
});

test('F2: data in ANY column the parser does not read holds the shipment (unknown future column)', () => {
  const head = [...HEAD, 'brand-new-amazon-column'];
  const plan = planUpload(tsv([row() + '\tsurprise'], head));
  assert.equal(plan.shipments.length, 0);
  assert.equal(plan.held.length, 1);
  assert.match(plan.held[0].reason, /brand-new-amazon-column/);
});

test('F2: only the shipment whose rows carry unsupported data is held', () => {
  const other = row({ 'order-id': '111-2222222-4444444', 'shipping-id': 'SHP2', 'transaction-id': 'TX2' });
  const plan = planUpload(tsv([row({ 'buyer-nip': 'PL5261111000' }), other]));
  assert.equal(plan.shipments.length, 1);
  assert.equal(plan.shipments[0].orderId, '111-2222222-4444444');
  assert.equal(plan.held.length, 1);
  assert.equal(plan.held[0].orderId, '111-2222222-3333333');
  assert.match(plan.held[0].reason, /buyer-nip/);
});

test('F2: parseVidr exposes unsupportedColumns sorted, empty when all unsupported columns are blank', () => {
  const [s1] = parseVidr(tsv([row({ 'seller-nip': 'PL123', 'export-outside-eu': 'FALSE' })]));
  assert.deepEqual(s1.unsupportedColumns, ['export-outside-eu', 'seller-nip']);
  const [s2] = parseVidr(tsv([row()]));
  assert.deepEqual(s2.unsupportedColumns, []);
});

test('F3: a row missing trailing EMPTY buyer-nip/seller-nip cells is complete (real Amazon header order)', () => {
  const cells = row().split('\t');
  const short = cells.slice(0, HEAD.length - 2).join('\t'); // an editor dropped the two trailing empty tabs
  const r = checkTsv(tsv([short]));
  assert.equal(r.invalid.length, 0, JSON.stringify(r.invalid));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]['citation-es'], '');
});

test('F3: a row missing a trailing cell the parser READS is still quarantined', () => {
  const head = HEAD.filter(h => h !== 'buyer-nip' && h !== 'seller-nip' && h !== 'citation-es'); // last column is now buyer-tax-registration-type: read, not a citation
  const cells = head.map(h => BASE[h] ?? '');
  const short = cells.slice(0, head.length - 1).join('	');
  const r = checkTsv(tsv([short], head));
  assert.equal(r.rows.length, 0);
  assert.equal(r.invalid.length, 1);
  assert.match(r.invalid[0].reason, /cut off or split/);
});

test('F3: a missing trailing citation-es cell stays tolerated (backward compatible)', () => {
  const head = [...HEAD.filter(h => h !== 'citation-es'), 'citation-es'];
  const cells = head.map(h => BASE[h] ?? '');
  const r = checkTsv(tsv([cells.slice(0, head.length - 1).join('\t')], head));
  assert.equal(r.invalid.length, 0, JSON.stringify(r.invalid));
  assert.equal(r.rows.length, 1);
});

test('F3: READ_COLUMNS covers every column the parser reads (regression anchor)', () => {
  for (const c of ['order-id', 'shipping-id', 'transaction-id', 'is-business-order', 'is-amazon-invoiced', 'buyer-vat-number', 'citation-es', 'fulfilled-by', 'recipient-name', 'gift-wrap-vat-rate', 'shipping-promo-vat-incl-amount', 'invoice-status', 'invoice-number'])
    assert.ok(READ_COLUMNS.has(c), c);
  assert.ok(!READ_COLUMNS.has('buyer-nip'));
  assert.ok(!READ_COLUMNS.has('bottle-deposit-vat-amount'));
});

async function boot(email) {
  const { server } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test', env: { ALLOW_MANUAL_UPLOAD: '1' } });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body, raw) => { const r = await fetch(base + '/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: raw ?? JSON.stringify(body) }); const sc = r.headers.get('set-cookie'); if (sc) sid = sc.split(';')[0]; return { status: r.status, body: await r.json() }; };
  await call('signup', { email, password: 'Long-Enough-Pw-42!' });
  return { server, call };
}

test('F4: an oversized manual upload gets a 413 that names the real limit, not PDFs', async () => {
  const { server, call } = await boot('ingest-413@x.es');
  const r = await call('manual/preview', undefined, JSON.stringify({ text: 'x'.repeat(6.2e6) }));
  server.close();
  assert.equal(r.status, 413);
  assert.match(r.body.error, /6 MB/);
  assert.doesNotMatch(r.body.error, /PDF/);
});

test('F4: a non-manual oversized request keeps the generic message', async () => {
  const { server, call } = await boot('ingest-413b@x.es');
  const r = await call('signup', undefined, JSON.stringify({ email: 'y@x.es', password: 'x'.repeat(7e4) }));
  server.close();
  assert.equal(r.status, 413);
  assert.match(r.body.error, /PDFs can be up to 5 MB/);
});

test('F4: the upload UI states the size limit', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /up to 5 MB, at most 20,000 rows/);
  assert.match(html, /f\.size>5e6/);
});
