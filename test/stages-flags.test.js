// reconcile.js stages().expected: who issues the invoice and whether the order is a business order are read from the FIELDS, never from invoice-status.
// Only an explicit TRUE or FALSE is accepted, read across EVERY row of the document. Blank, unreadable or disagreeing rows are UNKNOWN, and Expected is then UNDETERMINED:
// never NOT DUE and never "the seller must upload". invoice-status is shown as an independent fact and is never turned into proof of the issuer. Synthetic data only.
// (Moved from audit/tests/live-defects.test.js, where 2 of these failed by design; extended to both flags and every value shape.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { reconcile, stages } from '../src/reconcile.js';

const DECL = JSON.parse(readFileSync('fixtures/recon/declared.json', 'utf8'));
// perRow: array of edits, one per row of the document S9101 (3 rows); a shorter list leaves the rest alone. S9101 is the multi-row document of all-r1-pending.tsv.
const build = (ship, edits) => { const name = 'all-r1-pending.tsv', raw = readFileSync('fixtures/recon/' + name, 'utf8'), lines = raw.trim().split('\n'), h = lines[0].split('\t'); let k = 0;
  const text = [lines[0], ...lines.slice(1).map(r => { const c = r.split('\t'); if (c[h.indexOf('shipping-id')] === ship) { for (const [col, v] of Object.entries(edits[k] ?? edits[0] ?? {})) c[h.indexOf(col)] = v; if (edits.length > 1) k++; } return c.join('\t'); })].join('\n');
  return { id: 'r1', fileName: name, text, sha256: createHash('sha256').update(text).digest('hex'), importedAt: '2026-11-20T10:00:00Z', declared: DECL[name] }; };
const expectedOf = (ship, edits) => { const o = reconcile([build(ship, edits)]); const d = o.docs.find(x => x.evidence.transactionId === ship); assert.ok(d, 'doc ' + ship); return stages(d).expected; };
const ONE = 'S9001', MANY = 'S9101';
const PEND = { 'invoice-status': 'InvoicePending' }, AMZ = { 'invoice-status': 'InvoiceCreatedByAmazon' };
const U = (e) => { assert.equal(e.state, 'UNDETERMINED', JSON.stringify(e).slice(0, 300)); assert.ok(e.why && e.why.length > 30); assert.match(e.why, /resolve|load/i); };

test('stages: explicit values are read as written (characterization)', () => {
  assert.equal(expectedOf(ONE, [{ ...PEND, 'is-amazon-invoiced': 'FALSE', 'is-business-order': 'TRUE' }]).state, 'EVIDENCE');
  assert.equal(expectedOf(ONE, [{ ...AMZ, 'is-amazon-invoiced': 'TRUE', 'is-business-order': 'TRUE' }]).state, 'NOT DUE');
  assert.equal(expectedOf(ONE, [{ ...PEND, 'is-amazon-invoiced': ' false ', 'is-business-order': ' true ' }]).state, 'EVIDENCE');
});
for (const bad of ['', 'yes', 'maybe', '1']) {
  test(`stages: is-amazon-invoiced "${bad}" is unknown: UNDETERMINED with Pending, with InvoiceCreatedByAmazon, and with InvoiceUploaded; never NOT DUE, never seller-must-upload`, () => {
    for (const st of [PEND, AMZ, { 'invoice-status': 'InvoiceUploaded' }, { 'invoice-status': 'NoTaxCalculated' }]) { const e = expectedOf(ONE, [{ ...st, 'is-amazon-invoiced': bad, 'is-business-order': 'TRUE' }]); if (st['invoice-status'] === 'InvoiceUploaded') assert.notEqual(e.state, 'NOT DUE'); else { U(e); assert.match(e.why, /is-amazon-invoiced/); } }
  });
  test(`stages: is-business-order "${bad}" is unknown: a Pending document whose Amazon flag is FALSE is UNDETERMINED, not "the seller must upload"`, () => {
    const e = expectedOf(ONE, [{ ...PEND, 'is-amazon-invoiced': 'FALSE', 'is-business-order': bad }]); U(e); assert.match(e.why, /is-business-order/);
  });
}
test('stages: rows of one document that disagree on a flag are unknown; the first row is not enough', () => {
  const rows = (st, a, b) => a.map((x, i) => ({ ...st, 'is-amazon-invoiced': x, 'is-business-order': b[i] }));
  const e1 = expectedOf(MANY, rows(PEND, ['FALSE', 'TRUE', 'FALSE'], ['TRUE', 'TRUE', 'TRUE'])); U(e1); assert.match(e1.why, /is-amazon-invoiced/);
  const e2 = expectedOf(MANY, rows(PEND, ['FALSE', 'FALSE', 'FALSE'], ['TRUE', 'FALSE', 'TRUE'])); U(e2); assert.match(e2.why, /is-business-order/);
  const e3 = expectedOf(MANY, rows(PEND, ['FALSE', '', 'FALSE'], ['TRUE', 'TRUE', 'TRUE'])); U(e3);
  const e4 = expectedOf(MANY, rows(AMZ, ['TRUE', 'FALSE', 'TRUE'], ['TRUE', 'TRUE', 'TRUE'])); U(e4);
  const e5 = expectedOf(MANY, rows(PEND, ['FALSE', 'FALSE', 'FALSE'], ['TRUE', 'TRUE', ''])); U(e5);
});
test('stages: rows that all agree are read once: TRUE on every row is TRUE', () => {
  assert.equal(expectedOf(MANY, [{ ...PEND, 'is-amazon-invoiced': 'FALSE', 'is-business-order': 'TRUE' }]).state, 'EVIDENCE');
});
test('stages: a flag that conflicts with the invoice-status is UNDETERMINED (status never decides the issuer)', () => {
  U(expectedOf(ONE, [{ ...PEND, 'is-amazon-invoiced': 'TRUE', 'is-business-order': 'TRUE' }]));
  U(expectedOf(ONE, [{ ...AMZ, 'is-amazon-invoiced': 'FALSE', 'is-business-order': 'TRUE' }]));
});
test('stages: an explicit business FALSE with a Pending document: no seller invoice is owed, as the report says, and not "must upload"', () => {
  const e = expectedOf(ONE, [{ ...PEND, 'is-amazon-invoiced': 'FALSE', 'is-business-order': 'FALSE' }]); assert.equal(e.state, 'NOT DUE'); assert.match(e.why, /is-business-order/);
});
test('stages: invoice-status is shown as an independent fact in every result, and is not offered as proof of the issuer', () => {
  for (const [ed, st] of [[{ ...PEND, 'is-amazon-invoiced': 'FALSE', 'is-business-order': 'TRUE' }, 'InvoicePending'], [{ ...AMZ, 'is-amazon-invoiced': '' }, 'InvoiceCreatedByAmazon'], [{ ...AMZ, 'is-amazon-invoiced': 'TRUE' }, 'InvoiceCreatedByAmazon']]) {
    const e = expectedOf(ONE, [ed]); assert.equal(e.invoiceStatusAsReported, st); assert.match(e.invoiceStatusNote, /not proof of who issues/i);
  }
});
