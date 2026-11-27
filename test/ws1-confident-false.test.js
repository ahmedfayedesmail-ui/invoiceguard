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

// ---- adversarial and boundary cases ----
const vrows = (rows) => F.vidr(rows);
const withCols = (text, edits) => { const hdr = text.split('\n')[0].split('\t'); return text.split('\n').map((l, i) => { if (i === 0 || !l) return l; const c = l.split('\t'); const e = edits[i - 1]; if (e) for (const [k, v] of Object.entries(e)) c[hdr.indexOf(k)] = v; return c.join('\t'); }).join('\n'); };
test('ws1 adversarial: a conflict on one shipment does not change the verdict on a clean shipment in the same file', () => {
  const text = withCols(vrows([{ n: 1, status: 'InvoiceUploaded', num: 'AMZ-1' }, { n: 2, status: 'InvoiceUploaded', num: 'AMZ-2' }]), [{ 'is-amazon-invoiced': 'TRUE' }, {}]);
  const r = run(text);
  const gaps = r.issues.filter(i => i.family === 'BOOKS_GAP' && i.state === 'ACTION_REQUIRED');
  assert.equal(gaps.length, 1, 'only the clean shipment is a confident gap');
  assert.match(gaps[0].subject.orderId, /0*2$|2000002/);
  assert.equal(r.stats.amazonFlagUndetermined, 1);
});
test('ws1 adversarial: a conflicting shipment is never closed or reported as a seller gap even when the books hold its number', () => {
  const b = F.ledger([lrow('AMZ-1', F.O(1))]);
  const r = project({ imports: [V(setFlag(base(), 'TRUE')), L(b)], events: [] });
  assert.deepEqual(confident(r).map(i => i.family), []);
});
test('ws1 adversarial: three rows of one shipment, one dissenting row, is a conflict', () => {
  const lines = base().trimEnd().split('\n'), mk = (id, f) => { const c = lines[1].split('\t'); c[2] = String(id); c[9] = f; return c.join('\t'); };
  for (const flags of [['FALSE', 'FALSE', 'TRUE'], ['TRUE', 'FALSE', 'FALSE'], ['TRUE', '', 'TRUE']]) {
    const text = [lines[0], ...flags.map((f, j) => mk(101 + j, f))].join('\n') + '\n';
    const r = run(text);
    assert.deepEqual(confident(r).map(i => i.family), [], flags.join());
    assert.equal(r.stats.amazonFlagUndetermined, 1, flags.join());
  }
});
test('ws1 adversarial: odd flag spellings are unreadable, never read as FALSE', () => {
  for (const v of ['1', '0', 'yes', 'no', 'T', 'F', 'TRUE;', 'N/A']) {
    const r = run(setFlag(base(), v));
    assert.deepEqual(confident(r).map(i => i.family), [], v);
    assert.equal(r.stats.amazonFlagUndetermined, 1, v);
  }
});
test('ws1 adversarial: pending and rejected statuses with a TRUE flag are conflicts, not seller obligations', () => {
  for (const st of ['InvoicePending', 'InvoiceRejected', 'InvoiceProcessing']) {
    const r = run(setFlag(F.vidr([{ n: 1, status: st, num: st === 'InvoicePending' ? '' : 'AMZ-1' }]), 'TRUE'));
    assert.deepEqual(confident(r).map(i => i.family), [], st);
    assert.equal(r.stats.amazonFlagUndetermined, 1, st);
  }
});
test('ws1 adversarial: the conflict is shown as a coverage note naming both values, and as no seller action', () => {
  const r = run(setFlag(base(), 'TRUE'));
  assert.equal(r.issues.some(x => x.family === 'INVOICE_AMAZON_STATE' && x.state === 'ACTION_REQUIRED'), false);
  assert.ok(r.coverageNotes.some(n => /is-amazon-invoiced column \(TRUE\) and invoice-status \(InvoiceUploaded\) disagree/.test(n.reason)), JSON.stringify(r.coverageNotes));
});
test('ws1 regression: a correct Amazon-issued shipment (TRUE + InvoiceCreatedByAmazon) is not counted as undetermined and is not a gap, with books holding anything', () => {
  const r = run(setFlag(amz(), 'TRUE'));
  assert.equal(r.stats.amazonFlagUndetermined, 0);
  assert.deepEqual(r.issues.filter(i => i.family !== 'UNMATCHED_DOCUMENT').map(i => i.family), []);
});
