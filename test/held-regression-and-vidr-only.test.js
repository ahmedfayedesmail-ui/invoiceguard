// Round 3 (Ahmed's review). Synthetic data only. Local.
// (1) REGRESSION in the first fix: a blank is-amazon-invoiced was held only when the invoice-status said "needs an invoice". With invoice-status InvoiceCreatedByAmazon (or InvoiceUploaded) it was SKIPPED. A blank flag is unknown in every status: it is held, never skipped, never read from invoice-status.
// (2) DECISION: issuing needs a VAT Invoice Data Report. The Order Report is a preview path only. No option (API or web) can turn an Order Report into a ready invoice, and the declaration pass-through is gone from the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as F from '../tools/make-loop-fixtures.mjs';
import { planUpload } from '../src/manual.js';
import { parseVidr, heldForUnknownFlags, needsInvoice } from '../src/vidr.js';
import { openDb } from '../src/db.js';
import { processReport } from '../src/pipeline.js';

const base = () => F.vidr([{ n: 1, status: 'InvoicePending' }]);
const col = (name) => base().split('\n')[0].split('\t').indexOf(name);
const setCols = (text, o) => text.split('\n').map((l, k) => { if (k !== 1) return l; const c = l.split('\t'); for (const [n, v] of Object.entries(o)) c[col(n)] = v; return c.join('\t'); }).join('\n');
const STATUSES = ['InvoiceCreatedByAmazon', 'InvoiceUploaded', 'InvoicePending', 'InvoiceRejected', 'NoTaxCalculated', ''];

for (const status of STATUSES) for (const biz of ['TRUE', '']) {
  test(`held: blank is-amazon-invoiced, is-business-order "${biz}", invoice-status "${status || '(blank)'}" is HELD with a reason, never skipped, never issued`, () => {
    const text = setCols(base(), { 'is-amazon-invoiced': '', 'is-business-order': biz, 'invoice-status': status });
    const s = parseVidr(text)[0];
    assert.equal(s.isAmazonInvoiced, null);
    assert.equal(heldForUnknownFlags(s), true, 'heldForUnknownFlags');
    const p = planUpload(text);
    assert.equal(p.shipments.length, 0); assert.equal(p.skipped.length, 0, 'not skipped: ' + JSON.stringify(p.skipped)); assert.equal(p.held.length, 1);
    assert.match(p.held[0].reason, /is-amazon-invoiced/); assert.match(p.held[0].reason, /load a VAT Invoice Data Report/i);
  });
}
test('held: guards that must keep working: explicit values are read as written, and a known non-business order is skipped, whatever the status', () => {
  for (const status of STATUSES) {
    const consumer = planUpload(setCols(base(), { 'is-business-order': 'FALSE', 'is-amazon-invoiced': '', 'invoice-status': status }));
    assert.equal(consumer.held.length, 0); assert.equal(consumer.skipped.length, 1); assert.match(consumer.skipped[0].why, /Not a business order/);
    const amazon = planUpload(setCols(base(), { 'is-business-order': 'TRUE', 'is-amazon-invoiced': 'TRUE', 'invoice-status': status }));
    assert.equal(amazon.held.length, 0); assert.equal(amazon.skipped.length, 1); assert.match(amazon.skipped[0].why, /Amazon creates/);
  }
  assert.equal(planUpload(setCols(base(), { 'is-business-order': 'TRUE', 'is-amazon-invoiced': 'FALSE', 'invoice-status': 'InvoicePending' })).shipments.length, 1);
  assert.equal(needsInvoice(parseVidr(setCols(base(), { 'is-business-order': 'TRUE', 'is-amazon-invoiced': 'FALSE', 'invoice-status': 'InvoiceUploaded' }))[0]), false, 'explicit FALSE and InvoiceUploaded: nothing to issue, and that is read from the explicit flag');
});
test('held: the pipeline (API accounts) also holds a blank is-amazon-invoiced with InvoiceCreatedByAmazon and InvoiceUploaded, and issues nothing for it', async () => {
  const fx = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'), lines = fx.trim().split('\n'), head = lines[0].split('\t');
  for (const status of ['InvoiceCreatedByAmazon', 'InvoiceUploaded']) {
    const mod = [lines[0], ...lines.slice(1).map(r => { const c = r.split('\t'); if (c[head.indexOf('shipping-id')] === 'S1001') { c[head.indexOf('is-amazon-invoiced')] = ''; c[head.indexOf('invoice-status')] = status; } return c.join('\t'); })].join('\n');
    const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, 28001 Madrid, ES' };
    const api = { uploadInvoice: async () => 'feed', feedStatus: async () => ({ status: 'DONE' }) }, db = openDb();
    const out = await processReport(db, seller, mod, { api, validate: async (v) => ({ status: 'valid', vat: v }), now: new Date('2026-11-24T12:00:00Z') });
    assert.ok(out.held.some(h => /S1001/.test(h.key + h.orderId) && /is-amazon-invoiced/.test(h.reason)), status + ' ' + JSON.stringify(out.held));
    assert.ok(!db.prepare("SELECT 1 FROM shipments WHERE key LIKE '%S1001%' AND status IN ('submitted','uploaded','ready','sending','processing')").get(), 'S1001 was not issued');
  }
});

// ---- Decision one: VIDR-only issuing ----
const HEAD = ['order-id', 'order-item-id', 'purchase-date', 'buyer-name', 'sku', 'product-name', 'quantity-purchased', 'currency', 'item-price', 'item-tax', 'shipping-price', 'shipping-tax', 'recipient-name', 'ship-address-1', 'ship-city', 'ship-postal-code', 'ship-country', 'sales-channel', 'buyer-company-name', 'buyer-tax-registration-id', 'buyer-tax-registration-country', 'buyer-tax-registration-type'];
const V = ['111-1111111-1111111', '1', '2026-11-20T10:00:00+00:00', 'Ann', 'S1', 'Widget', '2', 'EUR', '121.00', '21.00', '0', '0', 'Ann', 'Calle 1', 'Madrid', '28001', 'ES', 'Amazon.es', 'Acme SL', 'B12345674', 'ES', 'VAT'];
const order = (extraHead = [], extra = []) => [[...HEAD, ...extraHead].join('\t'), [...V, ...extra].join('\t')].join('\n');
const DECLS = [{ isBusiness: true, isAmazonInvoiced: false }, { isBusiness: true }, { isAmazonInvoiced: false }, {}, { isBusiness: false }, { isAmazonInvoiced: true }];
test('vidr-only: no seller declaration, however complete, turns an Order Report into a ready invoice (API)', () => {
  for (const d of DECLS) { const p = planUpload(order(), { useDeliveryAddress: true, sellerDeclaration: d });
    assert.equal(p.shipments.length, 0, 'ready from declaration ' + JSON.stringify(d));
    if (p.held.length) assert.match(p.held[0].reason, /load the VAT Invoice Data Report/i); }
});
test('vidr-only: an Order Report that itself carries explicit TRUE/FALSE columns is still not an issuing source', () => {
  const p = planUpload(order(['is-business-order', 'is-amazon-invoiced'], ['TRUE', 'FALSE']), { useDeliveryAddress: true });
  assert.equal(p.shipments.length, 0); assert.equal(p.held.length, 1); assert.match(p.held[0].reason, /VAT Invoice Data Report/);
});
test('vidr-only: the preview says in plain words that issuing needs a VAT Invoice Data Report, for every order of the file', () => {
  const p = planUpload(order(), { useDeliveryAddress: true });
  assert.equal(p.held.length, 1); assert.match(p.held[0].reason, /issu/i); assert.match(p.held[0].reason, /VAT Invoice Data Report/);
});
test('vidr-only: the declaration pass-through is removed from the code (web entry, route, parser); the concept stays in the docs', () => {
  for (const f of ['../web/engine-entry.js', '../src/app.js', '../src/manual.js']) assert.ok(!/sellerDeclaration/.test(readFileSync(new URL(f, import.meta.url), 'utf8')), f + ' still mentions sellerDeclaration');
});
