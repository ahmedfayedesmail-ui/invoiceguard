import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { reconcile, evidenceLog, stages, STATUS_MAP, NOT_DUE, correctionRole } from '../src/reconcile.js';

const DECL = JSON.parse(readFileSync('fixtures/recon/declared.json', 'utf8'));
const load = (name, over = {}) => { const text = readFileSync('fixtures/recon/' + name, 'utf8'); return { id: name.replace('.tsv', ''), fileName: name, text, sha256: createHash('sha256').update(text).digest('hex'), importedAt: '2026-11-20T10:00:00Z', declared: { ...DECL[name], ...over } }; };
const R1 = () => load('all-r1-pending.tsv'), R2 = () => load('all-r2-processing.tsv'), R3 = () => load('all-r3-uploaded.tsv'), PO = () => load('pending-only.tsv');
const doc = (out, ship, tx) => out.docs.find(d => d.parts['shipping-id'] === ship && (!tx || d.parts['transaction-id'] === tx));
const A = 'S9001';

test('literal status strings: exactly the 8 documented values map, NoTaxCalculated / InvoiceCreatedByAmazon are not-due, anything else is UNKNOWN_STATUS (never PENDING)', () => {
  assert.deepEqual(STATUS_MAP, { InvoicePending: 'PENDING', CreditNotePending: 'PENDING', InvoiceProcessing: 'PROCESSING', CreditNoteProcessing: 'PROCESSING', InvoiceUploaded: 'ACCEPTED', CreditNoteUploaded: 'ACCEPTED', InvoiceRejected: 'REJECTED', CreditNoteRejected: 'REJECTED' });
  assert.deepEqual([...NOT_DUE], ['NoTaxCalculated', 'InvoiceCreatedByAmazon']);
  for (const bad of ['invoiceuploaded', 'Invoice Uploaded', 'InvoiceAccepted', 'Uploaded', '']) {
    const t = readFileSync('fixtures/recon/all-r3-uploaded.tsv', 'utf8').split('\n').slice(0, 2).join('\n').replace('InvoiceUploaded', bad) + '\n';
    const out = reconcile([{ id: 'x', text: t, sha256: 'a'.repeat(64), declared: DECL['all-r3-uploaded.tsv'] }]);
    assert.equal(out.docs[0].state, 'UNKNOWN_STATUS', JSON.stringify(bad)); assert.equal(out.docs[0].rawStatus, bad);
    assert.equal(out.headline.cannotDetermineParts.unknownStatus, 1);
  }
});

test('WORKED EXAMPLE (a): one synthetic order Expected -> Uploaded -> Accepted, every evidence field filled', () => {
  const out = reconcile([R1(), R2(), R3()]), d = doc(out, A), st = stages(d);
  assert.equal(d.state, 'ACCEPTED');
  assert.deepEqual(d.history.map(h => [h.importId, h.rawStatus, h.mapped, h.current]), [['all-r1-pending', 'InvoicePending', 'PENDING', false], ['all-r2-processing', 'InvoiceProcessing', 'PROCESSING', false], ['all-r3-uploaded', 'InvoiceUploaded', 'ACCEPTED', true]]);
  assert.equal(st.expected.state, 'EVIDENCE'); assert.equal(st.expected.columns['invoice-status'], 'InvoicePending'); assert.equal(st.expected.seenAt, '2026-11-10T08:00:00.000Z');
  assert.equal(st.issued.state, 'NOT VISIBLE in these files');
  assert.equal(st.uploaded.value, 'InvoiceProcessing'); assert.equal(st.uploaded.documentId, 'A-2026-000123');
  assert.equal(st.accepted.value, 'InvoiceUploaded'); assert.equal(st.accepted.documentId, 'A-2026-000123'); assert.equal(st.accepted.transactionId, 'S9001'); assert.equal(st.accepted.declaredBySeller, true);
  const log = evidenceLog(d, [R1(), R2(), R3()], out.imports);
  assert.match(log.importedReport.sha256, /^[0-9a-f]{64}$/); assert.equal(log.finalStatusAmazonReported, 'InvoiceUploaded'); assert.equal(log.documentNumber, 'A-2026-000123');
  assert.equal(log.matchedRows[0]['transaction-id'], 'S9001'); assert.equal(log.declaredBySeller.options, 'ALL'); assert.equal(log.declaredBySeller.labelledAs, 'declared by the seller, not verified by InvoiceGuard');
  assert.deepEqual(log.notVerifiedAutomatically, ['all-status option', 'report created after the upload', 'how the file was obtained']);
  assert.ok(log.preconditions.every(p => p.ok)); assert.ok(log.preconditions.some(p => p.name === 'report created after the upload' && p.how === 'declared-by-seller'));
  assert.ok(log.preconditions.some(p => p.name === 'range no longer than 30 days' && p.how === 'from-declared-dates'));
  assert.match(d.explanation, /In the file loaded on 2026-11-14/);
  console.log('EXAMPLE (a) evidence log:', JSON.stringify({ doc: log.document, report: log.importedReport.id, sha256: log.importedReport.sha256.slice(0, 16) + '...', status: log.finalStatusAmazonReported, number: log.documentNumber, tx: log.transactionId, effective: log.effectiveTime, basis: log.timeBasis, history: log.history.map(h => h.rawStatus) }));
});

test('WORKED EXAMPLE (b): a pending-only import cannot reach ACCEPTED; it classifies INCOMPLETE_SOURCE and says why', () => {
  const out = reconcile([PO()]);
  assert.equal(out.imports[0].scope, 'INCOMPLETE_SOURCE'); assert.match(out.imports[0].problems.join(' '), /pending-only report: it leaves out invoices Amazon already accepted/);
  assert.equal(out.headline.accepted, 0); assert.equal(doc(out, 'S9102').state, 'REJECTED'); assert.equal(doc(out, 'S9701').state, 'PENDING');
  assert.equal(doc(out, A), undefined, 'the accepted order is absent from a pending-only file and that proves nothing');
  assert.equal(out.headline.anyCompleteImport, false);
  // Even a row that says Uploaded inside a pending-only import is not shown as accepted.
  const t = readFileSync('fixtures/recon/pending-only.tsv', 'utf8').replace('InvoicePending', 'InvoiceUploaded').replace('\t\tInvoiceUploaded', '\tA-2026-000999\tInvoiceUploaded');
  const o2 = reconcile([{ ...PO(), text: t }]);
  assert.equal(doc(o2, 'S9701').state, 'INCOMPLETE_SOURCE'); assert.equal(o2.headline.accepted, 0); assert.match(doc(o2, 'S9701').explanation, /cannot support showing it as accepted/);
  assert.match(doc(o2, 'S9701').evidence.preconditions.find(p => p.name === 'all-status report').detail, /PENDING_ONLY/);
  console.log('EXAMPLE (b) import:', out.imports[0].scope, '|', out.imports[0].problems.join(' '), '| accepted =', out.headline.accepted);
});

test('TEST G: Processing earlier, Uploaded later. State advances on evidence, an OLDER report never rolls it back, nothing accepted early', () => {
  const only2 = reconcile([R2()]);   assert.equal(doc(only2, A).state, 'PROCESSING', 'not accepted early');
  const perms = [[R2(), R3()], [R3(), R2()], [R1(), R2(), R3()], [R3(), R1(), R2()], [R2(), R3(), R1()], [R3(), R2(), R1()]];
  const keyed = perms.map(p => JSON.stringify(reconcile(p).docs.map(d => [d.key, d.state, d.current.importId])));
  assert.equal(new Set(keyed).size, 1, 'result does not depend on the order of import');
  assert.equal(doc(reconcile([R3(), R2()]), A).state, 'ACCEPTED');
  const late = reconcile([R3(), { ...R1(), importedAt: '2026-12-30T00:00:00Z' }]); // an old report imported much later
  assert.equal(doc(late, A).state, 'ACCEPTED'); assert.equal(doc(late, A).current.importId, 'all-r3-uploaded');
  assert.equal(doc(late, A).history.find(h => h.importId === 'all-r1-pending').current, false, 'older report goes to history only');
  // a later report that says Processing after Uploaded: the later evidence decides and the step back is flagged
  const back = reconcile([R3(), { ...R2(), declared: { ...DECL['all-r2-processing.tsv'], createdAt: '2026-11-20T08:00:00Z' } }]);
  assert.equal(doc(back, A).state, 'PROCESSING'); assert.match(doc(back, A).anomalies[0], /A later report shows InvoiceProcessing \(processing\); we kept the earlier InvoiceUploaded in history/); assert.doesNotMatch(doc(back, A).anomalies[0], /reject/i);
  console.log('TEST G: R2 alone ->', doc(only2, A).state, '| R3+R2 / R2+R3 / all 6 orders ->', doc(reconcile([R3(), R2()]), A).state, '| old R1 imported last ->', doc(late, A).state, '(current import', doc(late, A).current.importId + ')');
});

test('each ACCEPTED precondition blocks acceptance on its own (INCOMPLETE_SOURCE, with the unmet one named)', () => {
  const cases = {
    'all-status report': { options: 'UNKNOWN' }, 'report type stored': { reportType: undefined },
    'range no longer than 30 days': { rangeFrom: '2026-10-01', rangeTo: '2026-11-30' }, 'range covers the order date': { rangeFrom: '2026-11-10', rangeTo: '2026-11-30' },
    'marketplace matches': { marketplace: 'OTHER' }, 'report created after the upload': { createdAfterUploadConfirmed: false }, 'download time stored': { downloadedAt: undefined },
    'how the file was obtained stored': { obtainedHow: '' },
  };
  for (const [name, over] of Object.entries(cases)) {
    const out = reconcile([R3(), ...[]].map(i => ({ ...i, declared: { ...i.declared, ...over } })));
    const d = doc(out, A); assert.notEqual(d.state, 'ACCEPTED', name); assert.equal(d.state, 'INCOMPLETE_SOURCE', name);
    assert.ok(d.evidence.preconditions.some(p => p.name === name && !p.ok), name);
  }
  const noHash = reconcile([{ ...R3(), sha256: null }]); assert.equal(doc(noHash, A).state, 'INCOMPLETE_SOURCE');
  const noNum = reconcile([{ ...R3(), text: R3().text.replace('A-2026-000123', '') }]); assert.equal(doc(noNum, A).state, 'INCOMPLETE_SOURCE');
  assert.equal(reconcile([R3()]).imports[0].scope, 'COMPLETE_SCOPE');
});

test('H: multi-shipment order, duplicate rows, return, not-due, overlap are all handled without guessing', () => {
  const out = reconcile([R1(), R2(), R3()]);
  assert.equal(doc(out, 'S9101').state, 'ACCEPTED'); assert.deepEqual(doc(out, 'S9101').itemIds.sort(), ['211', '212']);
  assert.equal(doc(out, 'S9102').state, 'REJECTED', 'same order, second shipment is its own document');
  assert.equal(doc(out, 'S9101').history[0].mapped, 'PENDING'); assert.equal(doc(out, 'S9101').evidence.duplicateRowsIgnored, 0);
  assert.equal(reconcile([R1()]).docs.find(d => d.key.includes('S9101')).evidence.duplicateRowsIgnored, 1, 'identical duplicate row counted once');
  assert.equal(doc(out, 'S9301').parts['transaction-type'], 'REFUND'); assert.equal(doc(out, 'S9301').state, 'ACCEPTED'); assert.equal(doc(out, 'S9301').rawStatus, 'CreditNoteUploaded');
  assert.equal(doc(out, 'S9601').state, 'NOT_APPLICABLE');
  // order-id alone never joins: same order id with another shipping id / transaction type stays separate documents
  assert.equal(out.docs.filter(d => d.parts['order-id'] === '405-2222222-0000002').length, 2);
});

test('H: conflicting rows inside one document block ACCEPTED (UNMATCHED, reason AMBIGUOUS)', () => {
  const t = R3().text.split('\n'); const i = t.findIndex(l => l.includes('\t212\t')); t[i] = t[i].replace('InvoiceUploaded', 'InvoiceProcessing');
  const out = reconcile([{ ...R3(), text: t.join('\n') }]); const d = doc(out, 'S9101');
  assert.equal(d.state, 'UNMATCHED'); assert.equal(d.unmatchedReason, 'AMBIGUOUS'); assert.match(d.explanation, /disagree on invoice-status/);
  assert.equal(out.headline.accepted, out.docs.filter(x => x.state === 'ACCEPTED').length);
  const t2 = R3().text.replace(/^(.*\tS9001\tS9001\tSHIPMENT\t)A-2026-000123/m, '$1A-2026-000999').split('\n'); // different invoice number on the SAME doc: add a second row
  const rows = R3().text.split('\n'); const row = rows.find(l => l.includes('\tS9001\t')); rows.push(row.replace('\t111\t', '\t112\t').replace('A-2026-000123', 'A-2026-000999'));
  assert.equal(doc(reconcile([{ ...R3(), text: rows.join('\n') }]), 'S9001').state, 'UNMATCHED');
  // two reports with the SAME time but different statuses for one document
  const clash = reconcile([R2(), { ...R3(), declared: { ...DECL['all-r3-uploaded.tsv'], createdAt: '2026-11-12T08:00:00Z' } }]);
  assert.equal(doc(clash, A).state, 'UNMATCHED');
  // row with a blank key field cannot be tied to a document
  const blank = R3().text.split('\n'); blank[1] = blank[1].replace('\tS9001\tS9001\t', '\t\tS9001\t');
  const ob = reconcile([{ ...R3(), text: blank.join('\n') }]); assert.equal(ob.unkeyed.length, 1); assert.ok(ob.headline.cannotDetermineParts.rowsWithoutKey >= 1);
});

test('E: a correction cycle closes only when BOTH sides are independently accepted', () => {
  const both = reconcile([R3()]); const rev = doc(both, 'S9401', 'CorrectionReversal:X:100000001'), cor = doc(both, 'S9401', 'Correction:X:100000001');
  assert.equal(rev.state, 'ACCEPTED'); assert.equal(cor.state, 'ACCEPTED'); assert.equal(both.cycles.find(c => c.key.includes('S9401')).state, 'ACCEPTED');
  const half = reconcile([R2()]); // reversal Uploaded, corrected still Processing
  assert.equal(doc(half, 'S9401', 'CorrectionReversal:X:100000001').state, 'PARTIALLY_ACCEPTED'); assert.equal(doc(half, 'S9401', 'Correction:X:100000001').state, 'PROCESSING');
  assert.equal(half.cycles.find(c => c.key.includes('S9401')).state, 'PARTIALLY_ACCEPTED');
  // missing side: S9501 has only the reversal in every file
  const one = reconcile([R3()]); const c2 = one.cycles.find(c => c.key.includes('S9501'));
  assert.equal(c2.state, 'PARTIALLY_ACCEPTED'); assert.deepEqual(c2.missing, ['corrected invoice side']); assert.equal(doc(one, 'S9501').state, 'PARTIALLY_ACCEPTED'); assert.match(doc(one, 'S9501').explanation, /corrected invoice side/);
  assert.equal(one.headline.correctionCyclesNotClosed, 1);
  assert.equal(correctionRole('CorrectionReversal:X:1', 'REFUND'), 'REVERSAL'); assert.equal(correctionRole('Correction:X:1', 'SHIPMENT'), 'CORRECTED'); assert.equal(correctionRole('S1', 'SHIPMENT'), null);
});

test('I: headline counts come from the evidence; cannot-determine is its own count; no accounting claim is made', () => {
  const out = reconcile([R1(), R2(), R3(), PO()]); const h = out.headline;
  assert.equal(h.documents, out.docs.length);
  assert.equal(h.accepted + h.processing + h.pending + h.rejected + h.notApplicable + h.cannotDetermineParts.incompleteSource + h.cannotDetermineParts.unmatched + h.cannotDetermineParts.unknownStatus + out.docs.filter(d => d.state === 'PARTIALLY_ACCEPTED').length, h.documents);
  assert.equal(h.exceptions, h.rejected + h.correctionCyclesNotClosed + h.cannotDetermine);
  assert.match(h.sentence, /^Out of \d+ document\(s\) in the loaded files: \d+ exception\(s\)/); assert.match(h.sentence, /we cannot determine \(\d+ incomplete source, \d+ unmatched, \d+ unknown status, \d+ rows without a key\)/); assert.match(h.accountingComparison, /needs the seller invoice export/);
  const inc = reconcile([PO()]).headline; assert.equal(inc.anyCompleteImport, false);
  console.log('HEADLINE (R1+R2+R3 all-status):', reconcile([R1(), R2(), R3()]).headline.sentence);
  console.log('HEADLINE (pending-only only):', inc.sentence);
});

test('no legal-consequence wording anywhere in the engine output', () => {
  const out = reconcile([R1(), R2(), R3(), PO()]);
  const text = JSON.stringify([out.docs.map(d => d.explanation), out.imports.map(i => i.problems.concat(i.warnings)), out.headline]);
  assert.doesNotMatch(text, /compliant|filed|valid|issuance-ready|penalt|fine[sd]?\b|you are covered|legal/i);
});

test('declared-versus-file contradiction is reported and the file is never upgraded', () => {
  const o = reconcile([{ ...PO(), declared: { ...DECL['pending-only.tsv'], options: 'ALL', rangeFrom: '2026-11-01', rangeTo: '2026-11-30' } }]);
  assert.match(o.warnings[0].warning, /looks like a pending-only report/); assert.equal(o.headline.accepted, 0);
});
