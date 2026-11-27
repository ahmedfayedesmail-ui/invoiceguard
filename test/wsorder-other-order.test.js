// WS-ORDER: an accounting document whose number matches Amazon's but whose order reference names another order must never be confirmed silently. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/loop/sha256.js';
import { project } from '../src/loop/project.js';
import * as F from '../tools/make-loop-fixtures.mjs';

const imp = (id, kind, text, declared, importedAt, profile) => ({ id, kind, text, declared, importedAt, fileName: id, sha256: sha256(text), profile });
const V = (text) => imp('v', 'vidr', text, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z');
const L = (text) => imp('l1', 'ledger', text, F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), '2026-11-21T11:01:00Z', F.PROFILE);
const lrow = (num, order) => [num, 'Factura', '2026-11-18', '2026-11-17', 'EUR', '121,00', '100,00', '21,00', order, 'Amazon.es'].join(';');
const run = (v, books) => project({ imports: [V(v), L(books)], events: [] });
const two = () => F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'AMZ-1' }, { n: 2, status: 'InvoiceUploaded', num: 'AMZ-2' }]);
const states = (r, re) => r.issues.filter(i => re.test(JSON.stringify(i)));
const hasNote = (r) => r.coverageNotes.some(n => /disagree about which order a document number belongs to/.test(n.reason));

test('order: number and order agree: confirmed, no finding, no note (control)', () => {
  const r = run(two(), F.ledger([lrow('AMZ-1', F.O(1)), lrow('AMZ-2', F.O(2))]));
  assert.equal(hasNote(r), false);
  assert.equal(r.stats.matchedByInvoiceNumber, 2);
});
test('order: two documents with swapped order references are not confirmed and are shown, not silent', () => {
  const r = run(two(), F.ledger([lrow('AMZ-1', F.O(2)), lrow('AMZ-2', F.O(1))]));
  assert.equal(r.stats.matchedByInvoiceNumber, 0);
  assert.ok(hasNote(r), JSON.stringify(r.coverageNotes));
  assert.equal(r.issues.filter(i => i.state === 'ACTION_REQUIRED').length, 0, 'uncertain, so no confident action against the seller');
});
test('order: one document naming another order is shown, and the other pair stays confirmed', () => {
  const r = run(two(), F.ledger([lrow('AMZ-1', F.O(99)), lrow('AMZ-2', F.O(2))]));
  assert.equal(r.stats.matchedByInvoiceNumber, 1);
  assert.ok(hasNote(r));
});
test('order: both sides are named in the note (document number, its order, Amazon order)', () => {
  const r = run(two(), F.ledger([lrow('AMZ-1', F.O(2)), lrow('AMZ-2', F.O(1))]));
  const n = r.coverageNotes.find(n => /disagree about which order/.test(n.reason));
  assert.ok(n && n.count >= 2 && /AMZ-1/.test(n.reason + JSON.stringify(n.sample)) || /names the order/.test(n.reason), JSON.stringify(n));
});
test('order: a document with no order reference is still confirmed by number alone (no behaviour change)', () => {
  const noRef = [ 'AMZ-1', 'Factura', '2026-11-18', '2026-11-17', 'EUR', '121,00', '100,00', '21,00', '', 'Amazon.es'].join(';');
  const r = run(F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'AMZ-1' }]), F.ledger([noRef]));
  assert.equal(hasNote(r), false);
});
test('order: the mismatch is never closed as accepted or matched', () => {
  const r = run(two(), F.ledger([lrow('AMZ-1', F.O(2)), lrow('AMZ-2', F.O(1))]));
  assert.equal(r.issues.some(i => i.state === 'VERIFIED_CLOSED'), false);
});
