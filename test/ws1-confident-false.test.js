// Workstream 1: no confident wrong answers. is-amazon-invoiced is read from the field itself, never inferred from invoice-status. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/loop/sha256.js';
import { project } from '../src/loop/project.js';
import * as F from '../tools/make-loop-fixtures.mjs';

const imp = (id, kind, text, declared, importedAt, profile) => ({ id, kind, text, declared, importedAt, fileName: id, sha256: sha256(text), profile });
const V = (text) => imp('v', 'vidr', text, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z');
const L = (text) => imp('l1', 'ledger', text, F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), '2026-11-21T11:01:00Z', F.PROFILE);
const lrow = (num, order) => [num, 'Factura', '2026-11-18', '2026-11-17', 'EUR', '121,00', '100,00', '21,00', order, 'Amazon.es'].join(';');
const books = F.ledger([lrow('X-OTHER', F.O(99))]);
const setFlag = (text, value, lineNo = 1) => text.split('\n').map((l, i) => { if (i !== lineNo) return l; const c = l.split('\t'); c[9] = value; return c.join('\t'); }).join('\n');
const run = (v) => project({ imports: [V(v), L(books)], events: [] });
const confident = (r) => r.issues.filter(i => i.state === 'ACTION_REQUIRED' && i.family !== 'UNMATCHED_DOCUMENT'); // UNMATCHED_DOCUMENT is the unrelated filler document in the books
const base = () => F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'AMZ-1' }]);

test('ws1: an ordinary uploaded invoice that is missing from the books is still a confident BOOKS_GAP (control)', () => {
  const r = run(base());
  assert.equal(r.issues.filter(i => i.family === 'BOOKS_GAP' && i.state === 'ACTION_REQUIRED').length, 1);
});
const amz = () => F.vidr([{ n: 1, status: 'InvoiceCreatedByAmazon', num: 'AMZ-1' }]);
test('ws1: TRUE with InvoiceCreatedByAmazon (both agree) raises nothing against the seller', () => {
  const r = run(setFlag(amz(), 'TRUE'));
  assert.deepEqual(confident(r).map(i => i.family), []);
  assert.equal(r.stats.createdByAmazon, 1);
  assert.equal(r.stats.amazonFlagUndetermined, 0);
});
test('ws1: CONFLICT: field TRUE but status InvoiceUploaded is undetermined, never confident', () => {
  const r = run(setFlag(base(), 'TRUE'));
  assert.deepEqual(confident(r).map(i => i.family), []);
  assert.equal(r.stats.amazonFlagUndetermined, 1);
  assert.ok(r.coverageNotes.some(n => /invoice flag could not be read \(CONFLICT\)/.test(n.reason)));
});
test('ws1: CONFLICT: field FALSE but status InvoiceCreatedByAmazon is undetermined, never confident', () => {
  const r = run(setFlag(amz(), 'FALSE'));
  assert.deepEqual(confident(r).map(i => i.family), []);
  assert.equal(r.stats.amazonFlagUndetermined, 1);
});
test('ws1: a blank flag falls back to the status (no behaviour change for files without the field filled)', () => {
  assert.equal(run(setFlag(base(), '')).issues.filter(i => i.family === 'BOOKS_GAP' && i.state === 'ACTION_REQUIRED').length, 1);
  assert.deepEqual(confident(run(setFlag(amz(), ''))).map(i => i.family), []);
});
test('ws1: the flag is read case-insensitively and with spaces', () => {
  for (const v of ['true', ' TRUE ', 'True']) assert.equal(run(setFlag(amz(), v)).stats.amazonFlagUndetermined, 0, v);
});
test('ws1: rows of one shipment that disagree about is-amazon-invoiced are never a confident finding', () => {
  const lines = base().trimEnd().split('\n');
  const second = lines[1].split('\t'); second[2] = '999'; second[9] = 'TRUE';
  const text = [lines[0], lines[1], second.join('\t')].join('\n') + '\n';
  const r = run(text);
  assert.deepEqual(confident(r).map(i => i.family), []);
  assert.ok(r.coverageNotes.some(n => /invoice flag could not be read \(CONFLICT\)/.test(n.reason)), 'the disagreement must be shown, not hidden');
  assert.equal(r.stats.amazonFlagUndetermined, 1);
});
test('ws1: an unreadable flag value (not TRUE or FALSE) is not treated as FALSE: no confident finding', () => {
  const r = run(setFlag(base(), 'maybe'));
  assert.deepEqual(confident(r).map(i => i.family), []);
  assert.ok(r.coverageNotes.some(n => /invoice flag could not be read \(UNREADABLE\)/.test(n.reason)));
});
