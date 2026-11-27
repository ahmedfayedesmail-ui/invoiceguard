// Same rule as test/blank-flag-unknown.test.js, for is-business-order in the VIDR parser path and its consumers (src/vidr.js, src/manual.js, src/pipeline.js):
// TRUE or FALSE is read as written. Blank, unreadable or disagreeing rows are UNKNOWN. Unknown is HELD with a reason, never skipped as consumer, never issued.
// Also: the wording of every held reason says what would resolve it. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as F from '../tools/make-loop-fixtures.mjs';
import { parseVidr, needsInvoice } from '../src/vidr.js';
import { planUpload } from '../src/manual.js';
import { openDb } from '../src/db.js';
import { processReport } from '../src/pipeline.js';

const col = (name) => F.vidr([{ n: 1, status: 'InvoicePending' }]).split('\n')[0].split('\t').indexOf(name);
const setCol = (text, name, value) => { const i = col(name); return text.split('\n').map((l, k) => { if (k !== 1) return l; const c = l.split('\t'); c[i] = value; return c.join('\t'); }).join('\n'); };
const pending = () => F.vidr([{ n: 1, status: 'InvoicePending' }]);

test('vidr business flag: TRUE and FALSE are read as written, case and spaces ignored (characterization)', () => {
  assert.equal(parseVidr(setCol(pending(), 'is-business-order', ' true '))[0].isBusiness, true);
  assert.equal(parseVidr(setCol(pending(), 'is-business-order', 'FALSE'))[0].isBusiness, false);
});
test('vidr business flag: blank, unreadable and disagreeing rows are unknown (null), not false', () => {
  assert.equal(parseVidr(setCol(pending(), 'is-business-order', ''))[0].isBusiness, null);
  assert.equal(parseVidr(setCol(pending(), 'is-business-order', 'yes'))[0].isBusiness, null);
  const lines = pending().trimEnd().split('\n'), c = lines[1].split('\t'); c[2] = '1002'; c[col('is-business-order')] = 'FALSE';
  assert.equal(parseVidr([lines[0], lines[1], c.join('\t')].join('\n') + '\n')[0].isBusiness, null);
});
test('vidr business flag: needsInvoice is false for unknown, true only for an explicit TRUE (with an explicit FALSE amazon flag)', () => {
  assert.equal(needsInvoice(parseVidr(setCol(pending(), 'is-business-order', ''))[0]), false);
  assert.equal(needsInvoice(parseVidr(setCol(pending(), 'is-business-order', 'TRUE'))[0]), true);
  assert.equal(needsInvoice(parseVidr(setCol(pending(), 'is-business-order', 'FALSE'))[0]), false);
});
test('manual plan, VIDR: a blank or unreadable business flag is HELD, not skipped as consumer and not issued', () => {
  for (const v of ['', 'yes']) { const p = planUpload(setCol(pending(), 'is-business-order', v)); assert.equal(p.shipments.length, 0); assert.equal(p.skipped.length, 0, 'not skipped as consumer: ' + JSON.stringify(v)); assert.equal(p.held.length, 1); assert.match(p.held[0].reason, /is-business-order/); }
});
test('manual plan, VIDR: an explicit FALSE business flag is still a consumer skip, as written (characterization)', () => {
  const p = planUpload(setCol(pending(), 'is-business-order', 'FALSE')); assert.equal(p.skipped.length, 1); assert.match(p.skipped[0].why, /consumer|Not a business/i); assert.equal(p.held.length, 0);
});
test('manual plan, VIDR: both flags unknown gives ONE hold naming both columns', () => {
  const p = planUpload(setCol(setCol(pending(), 'is-business-order', ''), 'is-amazon-invoiced', '')); assert.equal(p.held.length, 1); assert.match(p.held[0].reason, /is-business-order/); assert.match(p.held[0].reason, /is-amazon-invoiced/);
});
test('pipeline: a blank business flag is held and issues nothing', async () => {
  const fx = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'), lines = fx.trim().split('\n'), head = lines[0].split('\t'), ix = head.indexOf('is-business-order');
  const blanked = [lines[0], ...lines.slice(1).map(r => { const c = r.split('\t'); if (c[head.indexOf('shipping-id')] === 'S1001') c[ix] = ''; return c.join('\t'); })].join('\n');
  const calls = []; const api = { uploadInvoice: async (a) => { calls.push(a); return 'feed-' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) };
  const db = openDb(); const out = await processReport(db, { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, 28001 Madrid, ES' }, blanked, { api, validate: async (v) => ({ status: 'valid', vat: v }), now: new Date('2026-11-24T12:00:00Z') });
  assert.ok(out.held.some(h => /is-business-order/.test(h.reason)), JSON.stringify(out.held)); assert.equal(out.detected, 3);
});

// ---- wording: a held reason says what would resolve it ----
const HEAD = ['order-id', 'order-item-id', 'purchase-date', 'buyer-name', 'sku', 'product-name', 'quantity-purchased', 'currency', 'item-price', 'item-tax', 'shipping-price', 'shipping-tax', 'recipient-name', 'ship-address-1', 'ship-city', 'ship-postal-code', 'ship-country', 'sales-channel', 'buyer-company-name', 'buyer-tax-registration-id', 'buyer-tax-registration-country', 'buyer-tax-registration-type'];
const row = { 'order-id': '111-1111111-1111111', 'order-item-id': '1', 'purchase-date': '2026-11-20T10:00:00+00:00', 'buyer-name': 'Ann', sku: 'S1', 'product-name': 'Widget', 'quantity-purchased': '2', currency: 'EUR', 'item-price': '121.00', 'item-tax': '21.00', 'shipping-price': '0', 'shipping-tax': '0', 'recipient-name': 'Ann', 'ship-address-1': 'Calle 1', 'ship-city': 'Madrid', 'ship-postal-code': '28001', 'ship-country': 'ES', 'sales-channel': 'Amazon.es', 'buyer-company-name': 'Acme SL', 'buyer-tax-registration-id': '12345674', 'buyer-tax-registration-country': 'ES', 'buyer-tax-registration-type': 'VAT' };
const orderReport = (extra = {}) => { const h = [...HEAD, ...Object.keys(extra)], v = { ...row, ...extra }; return [h.join('\t'), h.map(k => v[k] ?? '').join('\t')].join('\n'); };
const reasons = () => [
  ['order report, no columns', planUpload(orderReport()).held[0].reason],
  ['order report, blank columns', planUpload(orderReport({ 'is-business-order': '', 'is-amazon-invoiced': '' })).held[0].reason],
  ['order report, business known, amazon blank', planUpload(orderReport({ 'is-business-order': 'TRUE', 'is-amazon-invoiced': '' })).held[0].reason],
  ['vidr, business blank', planUpload(setCol(pending(), 'is-business-order', '')).held[0].reason],
  ['vidr, amazon blank', planUpload(setCol(pending(), 'is-amazon-invoiced', '')).held[0].reason],
];
test('wording: every held reason names the column, says it was not guessed and nothing was issued, and says what would resolve it', () => {
  for (const [name, r] of reasons()) {
    assert.match(r, /is-business-order|is-amazon-invoiced/, name);
    assert.match(r, /did not guess/i, name);
    assert.match(r, /nothing (was )?issued/i, name);
    assert.match(r, /TRUE or FALSE/, name + ': names the value the column must hold');
    assert.match(r, /VAT Invoice Data Report/, name + ': names the report that carries the column');
    assert.doesNotMatch(r, /undefined|null|NaN|\[object/, name);
  }
});
test('wording: the Order Report reason says the report type itself does not carry the columns and points to the report that does; it never says the order is a consumer order', () => {
  const r = planUpload(orderReport()).held[0].reason;
  assert.match(r, /Order Report does not (carry|have)/); assert.match(r, /load the VAT Invoice Data Report/i); assert.doesNotMatch(r, /consumer/i);
});
test('wording: the reason names only the column that is unknown (business known, amazon blank)', () => {
  const r = planUpload(orderReport({ 'is-business-order': 'TRUE', 'is-amazon-invoiced': '' })).held[0].reason;
  assert.match(r, /is-amazon-invoiced/); assert.doesNotMatch(r, /is-business-order/);
});
test('wording: company name and VAT number are said not to prove either flag, and invoice-status is said not to be used', () => {
  assert.match(planUpload(orderReport()).held[0].reason, /company name and VAT number/i);
  assert.match(planUpload(setCol(pending(), 'is-amazon-invoiced', '')).held[0].reason, /invoice-status/);
});
