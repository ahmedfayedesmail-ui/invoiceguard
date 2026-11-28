// Squad swarm-amazon-schemas: do our synthetic corpora match the reports Amazon actually publishes?
// Sources read on 2026-11-28 (public Amazon documentation):
//  - Flat-file VAT Invoice Data Report (VIDR) attribute list: https://developer-docs.amazon/sp-api/docs/report-type-values-invoice-data
//  - VIDR column table, invoice-status table and the two sample files linked there: https://developer-docs.amazon/sp-api/docs/create-and-upload-invoices
//  - Order Report attribute lists: https://developer-docs.amazon/sp-api/docs/report-type-values-order
// What these tests pin, deliberately:
//  1. the VIDR fixture carries EVERY column Amazon documents today, in Amazon's order, so a trimmed fixture cannot silently hide a column gap;
//  2. a multi-item shipment and a RETURN transaction are read the way a real file presents them;
//  3. Amazon's documented DD/MM/YYYY dates are HELD by the issuing gate (DATE_UNREADABLE). That is a known, tracked gap, not a passing behaviour:
//     the gate accepts ISO dates only, and no Amazon artifact we could read shows an ISO date in this report. The test fails loudly if the gate
//     starts issuing from a date format it cannot prove, and it names the gap for whoever fixes it;
//  4. a bottle-deposit row is held by exactly the deposit amounts, because this version reads no bottle-deposit column.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVidr } from '../src/vidr.js';
import { assessShipment } from '../src/integrity-core.js';
import { planUpload, parseTable, detectFormat } from '../src/manual.js';

const VIDR = readFileSync(new URL('../fixtures/vidr-amazon-format.tsv', import.meta.url), 'utf8');
const ORDER = readFileSync(new URL('../fixtures/order-report-documented.tsv', import.meta.url), 'utf8');

// The attribute list exactly as Amazon publishes it for GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT (102 names, 2026-11-28).
const AMAZON_VIDR_COLUMNS = ['marketplace-id', 'order-id', 'order-item-id', 'shipping-id', 'transaction-id', 'transaction-type',
  'invoice-number', 'invoice-status', 'invoice-status-description', 'is-amazon-invoiced', 'order-date', 'shipment-date',
  'buyer-vat-number', 'seller-vat-number', 'asin', 'sku', 'product-name', 'quantity-purchased', 'currency',
  'item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'item-vat-rate', 'item-promo-vat-incl-amount',
  'item-promo-vat-excl-amount', 'item-promo-vat-amount', 'item-promo-vat-rate', 'item-promotion-id', 'gift-wrap-vat-incl-amount',
  'gift-wrap-vat-amount', 'gift-wrap-vat-excl-amount', 'gift-wrap-vat-rate', 'gift-promo-vat-incl-amount', 'gift-promo-vat-excl-amount',
  'gift-promo-vat-amount', 'gift-promo-vat-rate', 'gift-promotion-id', 'shipping-vat-incl-amount', 'shipping-vat-amount',
  'shipping-vat-excl-amount', 'shipping-vat-rate', 'shipping-promo-vat-incl-amount', 'shipping-promo-vat-excl-amount',
  'shipping-promo-vat-amount', 'shipping-promo-vat-rate', 'ship-promotion-id', 'is-business-order', 'price-designation',
  'purchase-order-number', 'recipient-name', 'ship-service-level', 'fulfilled-by', 'ship-address-1', 'ship-address-2',
  'ship-address-3', 'ship-city', 'ship-state', 'ship-postal-code', 'ship-country', 'ship-phone-number', 'ship-from-country',
  'ship-from-state', 'ship-from-city', 'ship-from-postal-code', 'billing-name', 'bill-address-1', 'bill-address-2', 'bill-address-3',
  'bill-city', 'bill-state', 'bill-postal-code', 'bill-country', 'billing-phone-number', 'bottle-deposit-vat-excl-amount',
  'bottle-deposit-vat-amount', 'buyer-name', 'buyer-company-name', 'legacy-customer-order-item-id', 'recommended-invoice-format',
  'buyer-tax-registration-type', 'buyer-e-invoice-account-id', 'is-buyer-physically-present', 'is-seller-physically-present',
  'citation-es', 'citation-it', 'citation-fr', 'citation-de', 'citation-en', 'export-outside-eu', 'is-invoice-corrected',
  'original-vat-invoice-number', 'invoice-correction-details', 'buyer-peppol-id', 'seller-peppol-id', 'buyer-nip', 'seller-nip',
  'seller-siren', 'buyer-siren', 'seller-siret', 'buyer-siret', 'seller-routing-code', 'buyer-routing-code'];

test('VIDR fixture: every column Amazon documents today, in Amazon\'s own order', () => {
  const head = parseTable(VIDR).head;
  assert.deepEqual(head, AMAZON_VIDR_COLUMNS);
});

test('VIDR fixture: one shipment per shipping-id, items kept apart, RETURN is its own transaction', () => {
  const parsed = parseVidr(VIDR);
  assert.equal(parsed.invalidRows.length, 0);
  assert.equal(parsed.length, 3);
  const ship = parsed.find(s => s.key === 'SHIPMENT:S1001');
  assert.ok(ship, 'the two item rows of S1001 are one shipment');
  assert.equal(ship.items.length, 2);
  assert.deepEqual(ship.items.map(i => i.sku), ['SKU-A', 'SKU-B']);
  assert.equal(ship.incl, 181.5); assert.equal(ship.vat, 31.5);
  assert.equal(ship.isBusiness, true); assert.equal(ship.isAmazonInvoiced, false);
  const ret = parsed.find(s => s.transactionType === 'RETURN');
  assert.ok(ret, 'a RETURN row keeps the transaction-id Amazon writes for it, not the shipping-id');
  assert.equal(ret.transactionId, 'amzn1:crow:A0f6kWaFSV6ymAlMHe4VJw');
  assert.equal(ret.shippingId, 'S1001');
  assert.equal(ret.incl, -60.5);
});

test('VIDR fixture: the documented DD/MM/YYYY dates are held by the issuing gate (known gap, not a pass)', () => {
  const parsed = parseVidr(VIDR);
  const a = assessShipment(parsed.find(s => s.key === 'SHIPMENT:S1001'));
  assert.equal(a.verdict, 'HOLD');
  const date = a.findings.filter(f => f.code === 'DATE_UNREADABLE');
  assert.equal(date.length, 1);
  assert.match(date[0].explanation, /ISO/);
  // Every shipment in the fixture carries a date in Amazon's documented form, so none of them can be issued today.
  const plan = planUpload(VIDR);
  assert.equal(plan.ok, true);
  assert.equal(plan.shipments.length, 0, 'nothing is ready while the date format is unreadable');
  assert.equal(plan.held.length, 2);
});

test('VIDR fixture: a bottle-deposit row is held by exactly the deposit amounts, never silently under-invoiced', () => {
  const parsed = parseVidr(VIDR);
  const dep = parsed.find(s => s.key === 'SHIPMENT:S2002');
  // Amazon documents that item-vat-incl-amount and item-vat-amount INCLUDE the bottle deposit; the excl column does not say.
  // This version reads no bottle-deposit column, so both internal checks fire by exactly the deposit amounts: 1.68 excl, 0.32 vat.
  const a = assessShipment(dep);
  assert.equal(a.verdict, 'HOLD');
  assert.ok(a.findings.some(f => f.code === 'AMOUNT_INCONSISTENT'), 'gross minus (net + VAT) is the deposit net, 1.68');
  assert.ok(a.findings.some(f => f.code === 'AMOUNT_RATE_MISMATCH'), 'VAT minus (net x rate) is the deposit VAT, 0.32');
  assert.equal(a.findings.find(f => f.code === 'AMOUNT_INCONSISTENT').evidence.values.incl, '101.96');
  assert.equal(a.findings.find(f => f.code === 'AMOUNT_INCONSISTENT').evidence.values.excl, '84.00');
});

test('Order Report fixture: the flags Amazon documents are read when the columns are present', () => {
  const t = parseTable(ORDER);
  assert.equal(detectFormat(t.head), 'order');
  const p = planUpload(ORDER);
  assert.equal(p.ok, true);
  assert.equal(p.shipments.length, 0, 'the Order Report is still a preview: it never issues');
  assert.equal(p.held.length, 1);
  const held = p.held[0];
  assert.equal(held.orderId, '405-2000001-0000001', 'a business order with is-business-order TRUE is not skipped as a consumer order');
  assert.match(held.reason, /preview only/);
  assert.doesNotMatch(held.reason, /does not carry/, 'the flags were present, so the absent-column reason must not be used');
  assert.deepEqual(p.skipped.map(s => s.orderId).sort(), ['405-2000002-0000002', '405-2000003-0000003']);
  assert.match(p.skipped.find(s => s.orderId === '405-2000002-0000002').why, /is-business-order FALSE/);
  assert.match(p.skipped.find(s => s.orderId === '405-2000003-0000003').why, /Amazon creates this invoice/);
});
