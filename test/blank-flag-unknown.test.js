// Rule (Ahmed, 2026-11-27): a BLANK is-amazon-invoiced means UNKNOWN. It is never inferred from invoice-status, in any path that reads it. An explicit TRUE or FALSE is read as written.
// Paths covered: the problem loop (src/loop/project.js), the VAT Invoice Data Report parser and its consumers (src/vidr.js needsInvoice, src/manual.js plan, src/pipeline.js), and the Order Report (src/manual.js), which carries no such columns. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/loop/sha256.js';
import { project } from '../src/loop/project.js';
import * as F from '../tools/make-loop-fixtures.mjs';
import { parseVidr, needsInvoice } from '../src/vidr.js';
import { planUpload } from '../src/manual.js';

const imp = (id, kind, text, declared, importedAt, profile) => ({ id, kind, text, declared, importedAt, fileName: id, sha256: sha256(text), profile });
const V = (text) => imp('v', 'vidr', text, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z');
const L = (text) => imp('l1', 'ledger', text, F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), '2026-11-21T11:01:00Z', F.PROFILE);
const books = F.ledger([F.L.row('X-OTHER', '2026-11-18', '2026-11-17', F.O(99))]);
const setFlag = (text, value) => text.split('\n').map((l, i) => { if (i !== 1) return l; const c = l.split('\t'); c[9] = value; return c.join('\t'); }).join('\n');
const run = (v) => project({ imports: [V(v), L(books)], events: [] });
const one = (status) => F.vidr([{ n: 1, status, num: status === 'InvoicePending' ? undefined : 'AMZ-1' }]);
const confident = (r) => r.issues.filter(i => i.state === 'ACTION_REQUIRED' && i.family !== 'UNMATCHED_DOCUMENT');

// ---- the problem loop ----
for (const status of ['InvoiceUploaded', 'InvoicePending', 'InvoiceCreatedByAmazon']) {
  test(`loop: BLANK is-amazon-invoiced with ${status} is UNDETERMINED, no confident finding`, () => {
    const r = run(setFlag(one(status), ''));
    assert.deepEqual(confident(r).map(i => i.family), []);
    assert.equal(r.issues.filter(i => i.family === 'BOOKS_GAP').length, 0);
    assert.equal(r.stats.amazonFlagUndetermined, 1);
    assert.ok(r.coverageNotes.some(n => /invoice flag could not be read \(BLANK\)/.test(n.reason)), JSON.stringify(r.coverageNotes));
    assert.equal(r.coverage.undetermined.count, 1);
    assert.equal(r.coverage.scope.count, 0, 'not in scope');
  });
}
test('loop: BLANK with InvoiceCreatedByAmazon is NOT counted as an invoice Amazon created', () => {
  const r = run(setFlag(one('InvoiceCreatedByAmazon'), ''));
  assert.equal(r.stats.createdByAmazon, 0);
  assert.equal(r.coverage.outsideScope.byReason.AMAZON_INVOICED, 0);
});
test('loop: explicit values are read exactly as written (characterization, passes before and after)', () => {
  assert.equal(run(setFlag(one('InvoiceUploaded'), 'FALSE')).issues.filter(i => i.family === 'BOOKS_GAP' && i.state === 'ACTION_REQUIRED').length, 1, 'FALSE + Uploaded: ordinary seller invoice, confident gap');
  const t = run(setFlag(one('InvoiceCreatedByAmazon'), 'TRUE'));
  assert.equal(t.stats.createdByAmazon, 1); assert.equal(t.stats.amazonFlagUndetermined, 0);
});
test('loop: a conflict between the field and the status stays UNDETERMINED (characterization)', () => {
  assert.equal(run(setFlag(one('InvoiceUploaded'), 'TRUE')).stats.amazonFlagUndetermined, 1);
  assert.equal(run(setFlag(one('InvoiceCreatedByAmazon'), 'FALSE')).stats.amazonFlagUndetermined, 1);
});

// ---- the VAT Invoice Data Report parser and everything that decides from it ----
test('vidr: parseVidr keeps a blank flag as unknown (null), not false; TRUE and FALSE as written', () => {
  assert.equal(parseVidr(setFlag(one('InvoicePending'), ''))[0].isAmazonInvoiced, null);
  assert.equal(parseVidr(setFlag(one('InvoicePending'), 'banana'))[0].isAmazonInvoiced, null);
  assert.equal(parseVidr(setFlag(one('InvoicePending'), 'FALSE'))[0].isAmazonInvoiced, false);
  assert.equal(parseVidr(setFlag(one('InvoicePending'), ' true '))[0].isAmazonInvoiced, true);
});
test('vidr: needsInvoice is false for an unknown flag whatever the status says, true for an explicit FALSE', () => {
  for (const status of ['InvoicePending', 'InvoiceRejected', 'NoTaxCalculated']) {
    assert.equal(needsInvoice(parseVidr(setFlag(one(status), ''))[0]), false, status + ' with blank flag');
    assert.equal(needsInvoice(parseVidr(setFlag(one(status), 'FALSE'))[0]), true, status + ' with FALSE (characterization)');
  }
});
test('vidr: rows of one shipment that disagree about the flag are unknown, not decided by the first row', () => {
  const lines = one('InvoicePending').trimEnd().split('\n'), c = lines[1].split('\t'); c[2] = '1002'; c[9] = 'TRUE'; const t = [lines[0], lines[1], c.join('\t')].join('\n') + '\n';
  assert.equal(parseVidr(t)[0].isAmazonInvoiced, null);
});
test('manual plan, VAT Invoice Data Report: a blank flag is HELD with a reason that names the field; it is neither issued nor silently skipped', () => {
  const p = planUpload(setFlag(one('InvoicePending'), ''));
  assert.equal(p.format, 'vidr'); assert.equal(p.shipments.length, 0); assert.equal(p.skipped.length, 0); assert.equal(p.held.length, 1);
  assert.match(p.held[0].reason, /is-amazon-invoiced/); assert.match(p.held[0].reason, /not (be )?(guess|infer)|did not guess|not inferred/i);
  // Phase B: this loop fixture has no quantity and no VAT columns, so the integrity gate holds it. The flag aspect is what this test guards: an explicit FALSE is read as written (never held for the FLAG, never skipped).
  const q = planUpload(setFlag(one('InvoicePending'), 'FALSE')); assert.equal(q.skipped.length, 0); assert.equal(q.held.length, 1); assert.doesNotMatch(q.held[0].reason, /is-amazon-invoiced/); assert.match(q.held[0].reason, /^Not issued: /);
});

// ---- the Order Report carries no is-amazon-invoiced or is-business-order column: no evidence ----
const HEAD = ['order-id', 'order-item-id', 'purchase-date', 'buyer-name', 'sku', 'product-name', 'quantity-purchased', 'currency', 'item-price', 'item-tax', 'shipping-price', 'shipping-tax', 'recipient-name', 'ship-address-1', 'ship-city', 'ship-postal-code', 'ship-country', 'sales-channel', 'buyer-company-name', 'buyer-tax-registration-id', 'buyer-tax-registration-country', 'buyer-tax-registration-type'];
const base = { 'order-id': '111-1111111-1111111', 'order-item-id': '1', 'purchase-date': '2026-11-20T10:00:00+00:00', 'buyer-name': 'Ann', sku: 'S1', 'product-name': 'Widget', 'quantity-purchased': '2', currency: 'EUR', 'item-price': '121.00', 'item-tax': '21.00', 'shipping-price': '0', 'shipping-tax': '0', 'recipient-name': 'Ann', 'ship-address-1': 'Calle 1', 'ship-city': 'Madrid', 'ship-postal-code': '28001', 'ship-country': 'ES', 'sales-channel': 'Amazon.es', 'buyer-company-name': 'Acme SL', 'buyer-tax-registration-id': '12345674', 'buyer-tax-registration-country': 'ES', 'buyer-tax-registration-type': 'VAT' };
const order = (over = {}, extra = []) => { const h = [...HEAD, ...Object.keys(over).filter(k => !HEAD.includes(k))], v = { ...base, ...over }; return [h.join('\t'), h.map(k => v[k] ?? '').join('\t')].join('\n'); };
test('order report: no flag columns means HELD with the statement that the report does not carry the evidence; never ready, never skipped as consumer', () => {
  const p = planUpload(order(), { useDeliveryAddress: true });
  assert.equal(p.format, 'order'); assert.equal(p.shipments.length, 0, 'not an invoice ready to generate'); assert.equal(p.skipped.length, 0); assert.equal(p.held.length, 1);
  assert.match(p.held[0].reason, /does not carry/); assert.match(p.held[0].reason, /is-business-order/); assert.match(p.held[0].reason, /is-amazon-invoiced/);
});
test('order report: an order with no company name and no tax id is not excluded as consumer either: the business flag is unknown', () => {
  const p = planUpload(order({ 'buyer-company-name': '', 'buyer-tax-registration-id': '' }), { useDeliveryAddress: true });
  assert.equal(p.skipped.length, 0); assert.equal(p.held.length, 1); assert.match(p.held[0].reason, /does not carry/);
});
test('order report: company name and tax id are buyer data, not proof of the business flag or of who issues the invoice', () => {
  const p = planUpload(order({ 'buyer-company-name': 'Acme SL', 'buyer-tax-registration-id': '12345674' }), { useDeliveryAddress: true });
  assert.equal(p.shipments.length, 0);
});
test('order report: a seller declaration option, complete or partial, is ignored: it is not a route to an invoice (decision: issuing needs a VAT Invoice Data Report)', () => {
  for (const d of [{ isBusiness: true, isAmazonInvoiced: false }, { isBusiness: true }]) { const p = planUpload(order(), { useDeliveryAddress: true, sellerDeclaration: d });
    assert.equal(p.shipments.length, 0); assert.equal(p.held.length, 1); assert.match(p.held[0].reason, /VAT Invoice Data Report/); }
});
test('order report: flag columns, when the file does carry them, are read as written for skipping, but the Order Report never issues', () => {
  const ok = planUpload(order({ 'is-business-order': 'TRUE', 'is-amazon-invoiced': 'FALSE' }), { useDeliveryAddress: true });
  assert.equal(ok.shipments.length, 0); assert.equal(ok.held.length, 1); assert.match(ok.held[0].reason, /preview only/);
  assert.equal(planUpload(order({ 'is-business-order': 'TRUE', 'is-amazon-invoiced': 'TRUE' }), { useDeliveryAddress: true }).skipped.length, 1, 'TRUE: Amazon creates it (characterization)');
  assert.equal(planUpload(order({ 'is-business-order': 'TRUE', 'is-amazon-invoiced': '' }), { useDeliveryAddress: true }).held.length, 1, 'blank column: unknown, held');
  assert.equal(planUpload(order({ 'is-business-order': 'FALSE', 'is-amazon-invoiced': 'FALSE' }), { useDeliveryAddress: true }).skipped.length, 1, 'explicit FALSE business: consumer, as written');
});

// ---- the production pipeline (processReport): a blank flag is held, never issued ----
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { processReport } from '../src/pipeline.js';
test('pipeline: processReport holds a shipment whose is-amazon-invoiced is blank and issues nothing for it; the explicit FALSE rows of the same file are still issued', async () => {
  const fx = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'), lines = fx.trim().split('\n'), head = lines[0].split('\t'), ix = head.indexOf('is-amazon-invoiced');
  const blanked = [lines[0], ...lines.slice(1).map(r => { const c = r.split('\t'); if (c[head.indexOf('shipping-id')] === 'S1001') c[ix] = ''; return c.join('\t'); })].join('\n');
  const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, 28001 Madrid, ES' };
  const calls = []; const api = { uploadInvoice: async (a) => { calls.push(a); return 'feed-' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) };
  const db = openDb();
  const out = await processReport(db, seller, blanked, { api, validate: async (v) => ({ status: 'valid', vat: v }), now: new Date('2026-11-24T12:00:00Z') });
  assert.ok(out.held.some(h => /is-amazon-invoiced/.test(h.reason)), JSON.stringify(out.held));
  assert.ok(!db.prepare("SELECT 1 FROM shipments WHERE key LIKE '%S1001%' AND status IN ('submitted','uploaded','ready','sending','processing')").get(), 'S1001 was not issued');
  assert.equal(out.detected, 3, 'the file has 4 shipments that need an invoice; the blank one is not detected as one'); assert.equal(out.uploaded + out.held.length, 4, 'the other 3 are uploaded or held for their own reasons, plus the blank one held');
});
