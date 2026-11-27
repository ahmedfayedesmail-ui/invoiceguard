// The invoice-status is evidence of the state Amazon's report shows. It is NOT, on its own, evidence of who issued the invoice.
// A document is CREATED_BY_AMAZON only with an explicit is-amazon-invoiced TRUE on EVERY row that agrees with the matching CreatedByAmazon status for the transaction type.
// FALSE with CreatedByAmazon, blank, unreadable, rows that disagree, any flag/status conflict: ISSUER_UNDETERMINED. The raw status stays exactly as the file gave it; the report state stays independent of the issuer decision.
// Synthetic data only. Local.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { reconcile, stages } from '../src/reconcile.js';

const DECL = JSON.parse(readFileSync('fixtures/recon/declared.json', 'utf8'));
const NAME = 'special-r1.tsv';
// rowsFor: ship id -> list of per-row edits (the first row of the ship is edited by edits[0]; extra edits append a copy of the row with order-item-id 2, 3...)
const build = (ship, edits) => { const raw = readFileSync('fixtures/recon/' + NAME, 'utf8'), lines = raw.trim().split('\n'), h = lines[0].split('\t'), out = [lines[0]];
  for (const r of lines.slice(1)) { const c = r.split('\t'); if (c[h.indexOf('shipping-id')] !== ship) continue; // the file holds ONLY the document under test, so the headline counts are about it alone
   
    edits.forEach((e, i) => { const d = [...c]; d[h.indexOf('order-item-id')] = String(i + 1); for (const [k, v] of Object.entries(e)) d[h.indexOf(k)] = v; out.push(d.join('\t')); }); }
  const text = out.join('\n') + '\n'; return { id: 'r1', fileName: NAME, text, sha256: createHash('sha256').update(text).digest('hex'), importedAt: '2026-11-20T10:00:00Z', declared: DECL[NAME] }; };
const docOf = (ship, edits) => { const o = reconcile([build(ship, edits)]); const d = o.docs.find(x => x.parts['shipping-id'] === ship); assert.ok(d, ship); return { o, d }; };
const INV = 'S9801', CN = 'S9701';
const FORBIDDEN = /Amazon made this|made this document itself|nothing to upload|Amazon-issued|created by Amazon \(nothing/i;

test('issuer: InvoiceCreatedByAmazon with an explicit TRUE on every row is CREATED_BY_AMAZON (characterization)', () => {
  const { o, d } = docOf(INV, [{ 'is-amazon-invoiced': 'TRUE' }, { 'is-amazon-invoiced': 'TRUE' }]);
  assert.equal(d.state, 'CREATED_BY_AMAZON'); assert.match(d.explanation, /Amazon made this document/); assert.equal(o.headline.createdByAmazon, 1); assert.equal(o.headline.issuerUndetermined, 0);
});
test('issuer: CreditNoteCreatedByAmazon with explicit TRUE is CREATED_BY_AMAZON', () => {
  const { o, d } = docOf(CN, [{ 'is-amazon-invoiced': 'TRUE' }]); assert.equal(d.state, 'CREATED_BY_AMAZON'); assert.equal(o.headline.createdByAmazon, 1);
});
const CASES = [['FALSE', 'FALSE'], ['BLANK', ''], ['UNREADABLE (yes)', 'yes'], ['UNREADABLE (1)', '1']];
for (const [ship, status] of [[INV, 'InvoiceCreatedByAmazon'], [CN, 'CreditNoteCreatedByAmazon']]) for (const [label, v] of CASES) {
  test(`issuer: ${status} with is-amazon-invoiced ${label} is ISSUER_UNDETERMINED: raw status kept, report state kept, never described as Amazon-issued, counted once and not as created by Amazon`, () => {
    const { o, d } = docOf(ship, [{ 'is-amazon-invoiced': v }]);
    assert.equal(d.state, 'ISSUER_UNDETERMINED'); assert.equal(d.rawStatus, status, 'the status is kept exactly as the file gave it'); assert.equal(d.reportedState, 'CREATED_BY_AMAZON', 'what the status maps to is kept apart from the issuer decision');
    assert.equal(d.history[0].mapped, 'CREATED_BY_AMAZON'); assert.equal(d.evidence.rawStatusVerbatim, status);
    assert.match(d.explanation, new RegExp(status)); assert.match(d.explanation, /does not show who issued/i); assert.match(d.explanation, /is-amazon-invoiced/); assert.doesNotMatch(d.explanation, FORBIDDEN);
    assert.equal(o.headline.createdByAmazon, 0); assert.equal(o.headline.issuerUndetermined, 1);
    assert.ok(o.headline.cannotDetermine >= 1, 'folded into cannotDetermine'); assert.equal(o.headline.cannotDetermineParts.issuerUndetermined, 1); assert.ok(o.headline.exceptions >= 1, 'an exception, so the document does not disappear');
    assert.doesNotMatch(o.headline.sentence, /\b[1-9]\d* created by Amazon/); assert.match(o.headline.sentence, /issuer/i);
    assert.equal(stages(d).expected.state, 'UNDETERMINED');
  });
}
test('issuer: rows of one document that disagree on is-amazon-invoiced are ISSUER_UNDETERMINED, the first row alone is not enough', () => {
  for (const edits of [[{ 'is-amazon-invoiced': 'TRUE' }, { 'is-amazon-invoiced': 'FALSE' }], [{ 'is-amazon-invoiced': 'TRUE' }, { 'is-amazon-invoiced': '' }], [{ 'is-amazon-invoiced': 'FALSE' }, { 'is-amazon-invoiced': 'TRUE' }]]) {
    const { o, d } = docOf(INV, edits); assert.equal(d.state, 'ISSUER_UNDETERMINED', JSON.stringify(edits)); assert.doesNotMatch(d.explanation, FORBIDDEN); assert.equal(o.headline.createdByAmazon, 0);
  }
});
test('issuer: a flag that conflicts with a seller-side status is untouched here (it is not a CreatedByAmazon document); the status stays what the report says', () => {
  const { d } = docOf('S9802', [{ 'is-amazon-invoiced': 'TRUE' }]); assert.equal(d.state, 'SELLER_UPLOAD_REQUIRED'); assert.equal(d.rawStatus, 'NoTaxCalculated');
});
test('issuer: no explanation and no headline sentence ever describes an ISSUER_UNDETERMINED document as Amazon-issued, across every case', () => {
  for (const ship of [INV, CN]) for (const [, v] of CASES) { const { o, d } = docOf(ship, [{ 'is-amazon-invoiced': v }]); assert.doesNotMatch(d.explanation + ' ' + o.headline.sentence.replace(/0 created by Amazon[^.]*/, ''), FORBIDDEN); }
});
test('issuer: the total is kept: every document is in the state counts, and the undetermined ones also in cannotDetermine and exceptions', () => {
  const { o } = docOf(INV, [{ 'is-amazon-invoiced': '' }]); const h = o.headline;
  const states = ['accepted', 'partiallyAccepted', 'processing', 'pending', 'rejected', 'sellerUploadRequired', 'createdByAmazon', 'issuerUndetermined'];
  assert.ok(h.documents >= states.reduce((n, k) => n + h[k], 0)); assert.equal(h.issuerUndetermined, o.docs.filter(d => d.state === 'ISSUER_UNDETERMINED').length);
});
