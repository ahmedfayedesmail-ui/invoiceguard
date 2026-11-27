// WS-B2B: is-business-order is read in the loop engine. TRUE = eligible, FALSE = no judgment and no action against the seller, BLANK / UNREADABLE / rows that disagree = no confident judgment, evidence missing is stated. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/loop/sha256.js';
import { project } from '../src/loop/project.js';
import * as F from '../tools/make-loop-fixtures.mjs';

const imp = (id, kind, text, declared, importedAt, profile) => ({ id, kind, text, declared, importedAt, fileName: id, sha256: sha256(text), profile });
const V = (text) => imp('v', 'vidr', text, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z');
const L = (text) => imp('l1', 'ledger', text, F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), '2026-11-21T11:01:00Z', F.PROFILE);
const lrow = (num, order) => [num, 'Factura', '2026-11-18', '2026-11-17', 'EUR', '121,00', '100,00', '21,00', order, 'Amazon.es'].join(';');
const COL = 12; // is-business-order
const setB = (text, value, lineNo = 1) => text.split('\n').map((l, i) => { if (i !== lineNo) return l; const c = l.split('\t'); c[COL] = value; return c.join('\t'); }).join('\n');
const run = (v, books = F.ledger([lrow('X-OTHER', F.O(99))])) => project({ imports: [V(v), L(books)], events: [] });
const confident = (r) => r.issues.filter(i => i.state === 'ACTION_REQUIRED' && i.family !== 'UNMATCHED_DOCUMENT'); // UNMATCHED_DOCUMENT is the unrelated filler document in the books
const against = (r) => r.issues.filter(i => i.state === 'ACTION_REQUIRED' && ['BOOKS_GAP', 'INVOICE_AMAZON_STATE', 'NUMBER_MISMATCH', 'DOCUMENT_ORDER_MISMATCH'].includes(i.family));
const base = (status = 'InvoiceUploaded') => F.vidr([{ n: 1, status, num: 'AMZ-1' }]);
const noteFor = (r, re) => r.coverageNotes.some(n => re.test(n.reason));

test('b2b: a business order (TRUE) missing from the books is still a confident BOOKS_GAP (control)', () => {
  assert.equal(run(base()).issues.filter(i => i.family === 'BOOKS_GAP' && i.state === 'ACTION_REQUIRED').length, 1);
});
test('b2b: FALSE (not a business order) raises no finding and no action against the seller', () => {
  const r = run(setB(base(), 'FALSE'));
  assert.deepEqual(confident(r).map(i => i.family), []);
  assert.equal(r.stats.nonBusinessOrders, 1);
});
test('b2b: FALSE with a pending status asks nothing of the seller', () => {
  for (const s of ['InvoicePending', 'InvoiceRejected', 'NoTaxCalculated']) assert.deepEqual(confident(run(setB(base(s), 'FALSE'))).map(i => i.family), [], s);
});
test('b2b: BLANK is not read as TRUE or FALSE: no confident finding, evidence gap stated', () => {
  const r = run(setB(base(), ''));
  assert.deepEqual(confident(r).map(i => i.family), []);
  assert.equal(r.stats.businessFlagUndetermined, 1);
  assert.ok(noteFor(r, /is-business-order could not be read \(BLANK\)/), JSON.stringify(r.coverageNotes));
});
test('b2b: an unreadable value is no confident finding, evidence gap stated', () => {
  for (const v of ['maybe', 'YES', '1', 'N/A']) { const r = run(setB(base(), v)); assert.deepEqual(confident(r).map(i => i.family), [], v); assert.ok(noteFor(r, /\(UNREADABLE\)/), v); }
});
test('b2b: rows of one shipment that disagree (TRUE and FALSE) are a conflict, never confident', () => {
  const lines = base().trimEnd().split('\n'); const second = lines[1].split('\t'); second[2] = '999'; second[COL] = 'FALSE';
  const r = run([lines[0], lines[1], second.join('\t')].join('\n') + '\n');
  assert.deepEqual(confident(r).map(i => i.family), []);
  assert.ok(noteFor(r, /is-business-order could not be read \(CONFLICT\)/));
});
test('b2b: a blank row next to a TRUE row of the same shipment is a conflict, not eligible', () => {
  const lines = base().trimEnd().split('\n'); const second = lines[1].split('\t'); second[2] = '999'; second[COL] = '';
  const r = run([lines[0], lines[1], second.join('\t')].join('\n') + '\n');
  assert.deepEqual(confident(r).map(i => i.family), []);
  assert.ok(noteFor(r, /\(CONFLICT\)/));
});
test('b2b: lower case and spaces are read (true, false)', () => {
  assert.equal(run(setB(base(), ' true ')).issues.filter(i => i.family === 'BOOKS_GAP' && i.state === 'ACTION_REQUIRED').length, 1);
  assert.equal(run(setB(base(), ' false ')).stats.nonBusinessOrders, 1);
});
test('b2b: a non-business shipment never changes the verdict on a business shipment in the same file', () => {
  const two = F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'AMZ-1' }, { n: 2, status: 'InvoiceUploaded', num: 'AMZ-2' }]);
  const r = run(setB(two, 'FALSE', 1));
  assert.deepEqual(against(r).map(i => i.subject.orderId ?? i.subject.amazonId).length, 1);
  assert.ok(JSON.stringify(against(r)).includes(F.O(2)) && !JSON.stringify(against(r)).includes(F.O(1)));
});
test('b2b: FALSE with the number present in the books or absent: no finding either way', () => {
  const held = F.ledger([lrow('AMZ-1', F.O(1))]);
  assert.deepEqual(confident(run(setB(base(), 'FALSE'), held)).map(i => i.family), []);
});
test('b2b: FALSE with a different number in the books for the same order: the shipment is not judged at all', () => {
  const diff = F.ledger([lrow('OTHER-77', F.O(1))]);
  const about = (r) => r.issues.filter(i => i.family !== 'UNMATCHED_DOCUMENT' && JSON.stringify(i).includes(F.O(1)));
  assert.equal(about(run(setB(base(), 'FALSE'), diff)).length, 0);
});
test('b2b: a non-business shipment is not counted as an invoice the seller owes (stats)', () => {
  const r = run(setB(base(), 'FALSE'));
  assert.equal(r.stats.amazonInvoices, 0);
});
test('b2b: Amazon-issued invoices are unaffected by the business flag (no change for CREATED_BY_AMAZON)', () => {
  for (const v of ['TRUE', 'FALSE']) assert.deepEqual(confident(run(setB(F.vidr([{ n: 1, status: 'InvoiceCreatedByAmazon', num: 'AMZ-1' }]), v))).map(i => i.family), [], v);
});
test('b2b: the BLANK / conflict state is shown as a note naming the column, not as a seller action', () => {
  const r = run(setB(base(), 'maybe'));
  assert.equal(r.issues.some(x => x.family === 'INVOICE_AMAZON_STATE' && x.state === 'ACTION_REQUIRED'), false);
  assert.ok(noteFor(r, /is-business-order/));
});
