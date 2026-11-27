// Combined Regression Suite: the three engine fixes interacting (WS1 Amazon evidence conflicts, WS-B2B is-business-order, wrong-order same number with another order). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/loop/sha256.js';
import { project } from '../src/loop/project.js';
import * as F from '../tools/make-loop-fixtures.mjs';

const imp = (id, kind, text, declared, importedAt, profile) => ({ id, kind, text, declared, importedAt, fileName: id === 'l1' ? 'books.csv' : id, sha256: sha256(text), profile });
const V = (text) => imp('v', 'vidr', text, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z');
const L = (text, over = {}) => imp('l1', 'ledger', text, F.LDECL({ exportedAt: '2026-11-20T11:00:00Z', ...over }), '2026-11-21T11:01:00Z', F.PROFILE);
const lrow = (num, order, gross = '121,00') => [num, 'Factura', '2026-11-18', '2026-11-17', 'EUR', gross, '100,00', '21,00', order, 'Amazon.es'].join(';');
const run = (v, books, over) => project({ imports: [V(v), L(books, over)], events: [] });
const col = (text, c, value, lineNo = 1) => text.split('\n').map((l, i) => { if (i !== lineNo) return l; const x = l.split('\t'); x[c] = value; return x.join('\t'); }).join('\n');
const AMZ = 9, BIZ = 12;
const one = (status = 'InvoiceUploaded') => F.vidr([{ n: 1, status, num: 'AMZ-1' }]);
const two = () => F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'AMZ-1' }, { n: 2, status: 'InvoiceUploaded', num: 'AMZ-2' }]);
const filler = lrow('X-OTHER', F.O(99));
const actions = (r) => r.issues.filter(i => i.state === 'ACTION_REQUIRED' && i.family !== 'UNMATCHED_DOCUMENT');
const notes = (r, re) => r.coverageNotes.some(n => re.test(n.reason));

test('combined 1: Amazon-flag conflict on a non-business order: nothing is concluded, no action', () => {
  const r = run(col(col(one(), AMZ, 'TRUE'), BIZ, 'FALSE'), F.ledger([filler]));
  assert.deepEqual(actions(r), []);
});
test('combined 2: Amazon-flag conflict on a business order stays undetermined with its note (the B2B fix does not hide it)', () => {
  const r = run(col(one(), AMZ, 'TRUE'), F.ledger([filler]));
  assert.deepEqual(actions(r), []);
  assert.ok(notes(r, /Amazon invoice flag could not be read \(CONFLICT\)/));
});
test('combined 3: EXACT_REPEAT in the books on a NON-business order is Ledger Data Quality, information only, never ACTION_REQUIRED', () => {
  const r = run(col(one(), BIZ, 'FALSE'), F.ledger([filler, lrow('AMZ-1', F.O(1)), lrow('AMZ-1', F.O(1))]));
  const d = r.issues.filter(i => i.family === 'DUPLICATE_DOCUMENT');
  assert.equal(d.length, 1);
  assert.equal(d[0].subtype, 'EXACT_REPEAT');
  assert.equal(d[0].section, 'LEDGER_DATA_QUALITY');
  assert.equal(d[0].label, 'Repeated accounting record candidate');
  assert.notEqual(d[0].state, 'ACTION_REQUIRED');
  assert.equal(r.buckets.ledgerDataQuality, 1);
  assert.equal(r.buckets.needsActionNow, r.issues.filter(i => i.state === 'ACTION_REQUIRED').length, 'the information item is not counted as needing action');
  assert.equal(r.buckets.needsHumanReading, r.issues.filter(i => i.state === 'OPEN' && i.section !== 'LEDGER_DATA_QUALITY').length);
});
test('combined 4: SAME_NUMBER_DIFFERENT_CONTENT on a non-business order carries the higher-priority label, rows, file and differing fields', () => {
  const r = run(col(one(), BIZ, 'FALSE'), F.ledger([filler, lrow('AMZ-1', F.O(1)), lrow('AMZ-1', F.O(1), '150,00')]));
  const d = r.issues.find(i => i.family === 'DUPLICATE_DOCUMENT');
  assert.equal(d.subtype, 'SAME_NUMBER_DIFFERENT_CONTENT');
  assert.equal(d.label, 'Conflicting records sharing the same document number (higher review priority)');
  assert.notEqual(d.state, 'ACTION_REQUIRED');
  const e = d.finding.evidence;
  assert.equal(e.sources[0].fileName, 'books.csv');
  assert.equal(e.documentLevel, 'DOCUMENT');
  assert.equal(e.rowNumbers.length, 2);
  assert.ok(e.sources[0].rows.every(x => x.cells && Object.keys(x.cells).length > 3));
  assert.ok(Array.isArray(e.disagreeingFields));
  assert.equal(e.orderTie.amazonShipments[0].orderId, F.O(1));
  assert.equal(e.orderTie.amazonShipments[0].isBusinessOrder, 'FALSE');
});
test('combined 5: the same duplicate on a BUSINESS order is also Ledger Data Quality, information only, rows kept', () => {
  const r = run(one(), F.ledger([filler, lrow('AMZ-1', F.O(1)), lrow('AMZ-1', F.O(1))]));
  const d = r.issues.find(i => i.family === 'DUPLICATE_DOCUMENT');
  assert.notEqual(d.state, 'ACTION_REQUIRED');
  assert.equal(d.section, 'LEDGER_DATA_QUALITY');
  const e = d.finding.evidence;
  assert.ok(e.rowNumbers.length >= 2 && e.sources[0].fileName === 'books.csv' && e.documentLevel);
  assert.equal(e.orderTie.amazonShipments[0].isBusinessOrder, 'TRUE');
  assert.equal(r.issues.filter(i => i.state === 'ACTION_REQUIRED' && i.family === 'DUPLICATE_DOCUMENT').length, 0);
  assert.ok(!/not subject|not judged/i.test(JSON.stringify(d.note)), 'no wording that a business order is not checked');
});
test('combined 14: a business duplicate is information only while the other checks on that order and on its neighbour are unaffected', () => {
  const r = run(two(), F.ledger([filler, lrow('AMZ-1', F.O(1)), lrow('AMZ-1', F.O(1))]));
  const d = r.issues.find(i => i.family === 'DUPLICATE_DOCUMENT');
  assert.equal(d.section, 'LEDGER_DATA_QUALITY'); assert.notEqual(d.state, 'ACTION_REQUIRED');
  const gap = r.issues.filter(i => i.family === 'BOOKS_GAP' && i.state === 'ACTION_REQUIRED');
  assert.ok(gap.length >= 1, 'the invoice missing from the books is still raised on its own');
  assert.equal(r.issues.some(i => i.family === 'DUPLICATE_DOCUMENT' && i.state === 'ACTION_REQUIRED'), false);
});
test('combined 6: wrong-order link on a non-business order: no mismatch accusation, no action', () => {
  const r = run(col(one(), BIZ, 'FALSE'), F.ledger([filler, lrow('AMZ-1', F.O(2))]));
  assert.deepEqual(actions(r), []);
  assert.equal(r.issues.some(i => i.state === 'ACTION_REQUIRED' && JSON.stringify(i).includes('AMZ-1')), false);
});
test('combined 7: wrong-order link on a business order is shown (note) and never confirmed or accused', () => {
  const r = run(one(), F.ledger([filler, lrow('AMZ-1', F.O(2))]));
  assert.deepEqual(actions(r), []);
  assert.ok(notes(r, /disagree about which order a document number belongs to/));
  assert.equal(r.stats.matchedByInvoiceNumber, 0);
});
test('combined 8: a correct business shipment next to a non-business one: only the business one is judged', () => {
  const r = run(col(two(), BIZ, 'FALSE', 2), F.ledger([filler]));
  const gaps = r.issues.filter(i => i.family === 'BOOKS_GAP' && i.state === 'ACTION_REQUIRED');
  assert.equal(gaps.length, 1);
  assert.ok(JSON.stringify(gaps[0]).includes(F.O(1)) && !JSON.stringify(gaps[0]).includes(F.O(2)));
});
test('combined 9: a correct, matched business shipment is not disturbed by a non-business neighbour with a wrong-order document', () => {
  const r = run(col(two(), BIZ, 'FALSE', 2), F.ledger([filler, lrow('AMZ-1', F.O(1)), lrow('AMZ-2', F.O(1))]));
  assert.deepEqual(actions(r), []);
  assert.equal(r.stats.matchedByInvoiceNumber, 1);
});
test('combined 10: multi-line books (documentLevel LINE) repeating a number on a non-business order is expected, not a quality finding', () => {
  const r = run(col(one(), BIZ, 'FALSE'), F.ledger([filler, lrow('AMZ-1', F.O(1)), lrow('AMZ-1', F.O(1))]), { documentLevel: 'LINE' });
  assert.equal(r.issues.filter(i => i.family === 'DUPLICATE_DOCUMENT' && i.state !== 'VERIFIED_CLOSED').length, 0);
});
test('combined 11: blank business flag + Amazon-issued status: nothing concluded, nothing accused', () => {
  const r = run(col(F.vidr([{ n: 1, status: 'InvoiceCreatedByAmazon', num: 'AMZ-1' }]), BIZ, ''), F.ledger([filler]));
  assert.deepEqual(actions(r), []);
});
test('combined 12: business flag conflict (rows disagree) and a duplicate in the books: the duplicate is information only', () => {
  const lines = one().trimEnd().split('\n'); const b = lines[1].split('\t'); b[2] = '999'; b[BIZ] = 'FALSE';
  const r = run([lines[0], lines[1], b.join('\t')].join('\n') + '\n', F.ledger([filler, lrow('AMZ-1', F.O(1)), lrow('AMZ-1', F.O(1))]));
  assert.deepEqual(actions(r), []);
  const d = r.issues.find(i => i.family === 'DUPLICATE_DOCUMENT');
  assert.equal(d.section, 'LEDGER_DATA_QUALITY');
  assert.ok(notes(r, /is-business-order could not be read \(CONFLICT\)/));
});
test('combined 13: no ACTION_REQUIRED anywhere is raised on the basis of a non-business order (all three fixes together)', () => {
  const v = col(col(two(), BIZ, 'FALSE', 1), BIZ, 'FALSE', 2);
  const r = run(v, F.ledger([filler, lrow('AMZ-1', F.O(2)), lrow('AMZ-2', F.O(1)), lrow('AMZ-2', F.O(1))]));
  assert.deepEqual(r.issues.filter(i => i.state === 'ACTION_REQUIRED' && i.family !== 'UNMATCHED_DOCUMENT'), []);
});
