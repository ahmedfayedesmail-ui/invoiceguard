// Failing-by-design specification tests for two live defects found in the audit. They are NOT in test/ so the suite stays as reported. Run: node --test audit/tests/live-defects.test.js
// Rule they encode (Ahmed): is-amazon-invoiced is read from the field, never inferred. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../../src/loop/sha256.js';
import { project } from '../../src/loop/project.js';
import * as F from '../../tools/make-loop-fixtures.mjs';
import { planUpload } from '../../src/manual.js';

const imp = (id, kind, text, declared, importedAt, profile) => ({ id, kind, text, declared, importedAt, fileName: id, sha256: sha256(text), profile });
const V = (text) => imp('v', 'vidr', text, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z');
const L = (text) => imp('l1', 'ledger', text, F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), '2026-11-21T11:01:00Z', F.PROFILE);
const books = F.ledger([['X-OTHER', 'Factura', '2026-11-18', '2026-11-17', 'EUR', '121,00', '100,00', '21,00', F.O(99), 'Amazon.es'].join(';')]);
const setFlag = (text, value) => text.split('\n').map((l, i) => { if (i !== 1) return l; const c = l.split('\t'); c[9] = value; return c.join('\t'); }).join('\n');
const run = (v) => project({ imports: [V(v), L(books)], events: [] });
const confident = (r) => r.issues.filter(i => i.state === 'ACTION_REQUIRED' && i.family !== 'UNMATCHED_DOCUMENT');

test('DEFECT 1a: a BLANK is-amazon-invoiced with status InvoiceUploaded must not become a confident seller finding (today it does: the status is read as if it were the field)', () => {
  const r = run(setFlag(F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'AMZ-1' }]), ''));
  assert.deepEqual(confident(r).map(i => i.family), []);
});
test('DEFECT 1b: a BLANK is-amazon-invoiced with status InvoiceCreatedByAmazon must be undetermined, not silently counted as Amazon-issued (today it is outside scope with no note)', () => {
  const r = run(setFlag(F.vidr([{ n: 1, status: 'InvoiceCreatedByAmazon', num: 'AMZ-1' }]), ''));
  assert.equal(r.stats.amazonFlagUndetermined, 1);
});
test('DEFECT 2: an Order Report has no is-amazon-invoiced column; the plan must say the value is unknown, not hardcode false (src/manual.js:76). Today every such row is planned as "needs a seller invoice" with isAmazonInvoiced=false and no unknown marker.', () => {
  const HEAD = ['order-id', 'order-item-id', 'purchase-date', 'buyer-name', 'sku', 'product-name', 'quantity-purchased', 'currency', 'item-price', 'item-tax', 'shipping-price', 'shipping-tax', 'recipient-name', 'ship-address-1', 'ship-city', 'ship-postal-code', 'ship-country', 'sales-channel', 'buyer-company-name', 'buyer-tax-registration-id', 'buyer-tax-registration-country', 'buyer-tax-registration-type'];
  const v = { 'order-id': '111-1111111-1111111', 'order-item-id': '1', 'purchase-date': '2026-11-20T10:00:00+00:00', 'buyer-name': 'Ann', sku: 'S1', 'product-name': 'Widget', 'quantity-purchased': '2', currency: 'EUR', 'item-price': '121.00', 'item-tax': '21.00', 'shipping-price': '0', 'shipping-tax': '0', 'recipient-name': 'Ann', 'ship-address-1': 'Calle 1', 'ship-city': 'Madrid', 'ship-postal-code': '28001', 'ship-country': 'ES', 'sales-channel': 'Amazon.es', 'buyer-company-name': 'Acme SL', 'buyer-tax-registration-id': '12345674', 'buyer-tax-registration-country': 'ES', 'buyer-tax-registration-type': 'VAT' };
  const p = planUpload([HEAD.join('\t'), HEAD.map(h => v[h] ?? '').join('\t')].join('\n'), { useDeliveryAddress: true });
  assert.equal(p.format, 'order'); assert.equal(p.shipments.length, 1);
  assert.notEqual(p.shipments[0].isAmazonInvoiced, false, 'unknown must not be represented as false');
});
