import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { reconcile, evidenceLog, stages, STATUS_MAP, KNOWN_STATUSES, correctionRole } from '../src/reconcile.js';

const DECL = JSON.parse(readFileSync('fixtures/recon/declared.json', 'utf8'));
const load = (name, over = {}) => { const text = readFileSync('fixtures/recon/' + name, 'utf8'); return { id: name.replace('.tsv', ''), fileName: name, text, sha256: createHash('sha256').update(text).digest('hex'), importedAt: '2026-11-20T10:00:00Z', declared: { ...DECL[name], ...over } }; };
const R1 = () => load('all-r1-pending.tsv'), R2 = () => load('all-r2-processing.tsv'), R3 = () => load('all-r3-uploaded.tsv'), PO = () => load('pending-only.tsv');
const doc = (out, ship, tx) => out.docs.find(d => d.parts['shipping-id'] === ship && (!tx || d.parts['transaction-id'] === tx));
const A = 'S9001';

test('literal status strings: exactly the 11 documented values, each mapped, none UNKNOWN; anything else is UNKNOWN_STATUS (never PENDING)', () => {
  assert.deepEqual(STATUS_MAP, { InvoicePending: 'PENDING', CreditNotePending: 'PENDING', InvoiceProcessing: 'PROCESSING', CreditNoteProcessing: 'PROCESSING', InvoiceUploaded: 'ACCEPTED', CreditNoteUploaded: 'ACCEPTED', InvoiceRejected: 'REJECTED', CreditNoteRejected: 'REJECTED', InvoiceCreatedByAmazon: 'CREATED_BY_AMAZON', CreditNoteCreatedByAmazon: 'CREATED_BY_AMAZON', NoTaxCalculated: 'SELLER_UPLOAD_REQUIRED' });
  assert.equal(KNOWN_STATUSES.length, 11);
  // every known status, in a one-row file, lands in its own state and never in UNKNOWN_STATUS
  for (const [raw, want] of Object.entries(STATUS_MAP)) {
    const credit = raw.startsWith('CreditNote'), row = readFileSync('fixtures/recon/all-r3-uploaded.tsv', 'utf8').split('\n').slice(0, 2);
    const h = row[0].split('\t'), c = row[1].split('\t'); c[h.indexOf('invoice-status')] = raw; c[h.indexOf('transaction-type')] = credit ? 'REFUND' : 'SHIPMENT'; c[h.indexOf('transaction-id')] = credit ? 'amzn1:crow:X1' : c[h.indexOf('shipping-id')];
    const out = reconcile([{ ...R3(), text: row[0] + '\n' + c.join('\t') + '\n' }]), st = out.docs[0].state;
    assert.notEqual(st, 'UNKNOWN_STATUS', raw); assert.equal(out.docs[0].rawStatus, raw); assert.ok(st === want || (want === 'ACCEPTED' && ['ACCEPTED', 'INCOMPLETE_SOURCE'].includes(st)), `${raw} -> ${st}`);
  }
  for (const bad of ['invoiceuploaded', 'Invoice Uploaded', 'InvoiceAccepted', 'Uploaded', '', 'Notaxcalculated']) {
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
  assert.equal(st.expected.state, 'EVIDENCE'); assert.equal(st.expected.columns['invoice-status'], 'InvoicePending'); assert.equal(st.expected.observedInReportDated, '2026-11-10T08:00:00.000Z');
  assert.equal(st.issued.state, 'NOT VISIBLE in these files');
  assert.equal(st.uploaded.value, 'InvoiceProcessing'); assert.equal(st.uploaded.documentId, 'A-2026-000123');
  assert.equal(st.accepted.value, 'InvoiceUploaded'); assert.equal(st.accepted.documentId, 'A-2026-000123'); assert.equal(st.accepted.transactionId, 'S9001'); assert.equal(st.accepted.declaredBySeller, true);
  const log = evidenceLog(d, [R1(), R2(), R3()], out.imports);
  assert.match(log.importedReport.sha256, /^[0-9a-f]{64}$/); assert.equal(log.finalStatusAmazonReported, 'InvoiceUploaded'); assert.equal(log.documentNumber, 'A-2026-000123');
  assert.equal(log.matchedRows[0]['transaction-id'], 'S9001'); assert.equal(log.declaredBySeller.options, 'ALL'); assert.equal(log.declaredBySeller.labelledAs, 'declared by the seller, not verified by InvoiceGuard');
  assert.deepEqual(log.notVerifiedAutomatically, ['all-status option', 'report created after the upload', 'how the file was obtained']);
  assert.ok(log.preconditions.every(p => p.ok)); assert.ok(log.preconditions.some(p => p.name === 'report created after the upload' && p.how === 'declared-by-seller'));
  assert.ok(log.preconditions.some(p => p.name === 'range no longer than 30 days' && p.how === 'from-declared-dates'));
  assert.match(d.explanation, /^Observed as InvoiceUploaded in the report dated 2026-11-14 \(date as declared by the seller\)/);
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
  assert.equal(doc(out, 'S9601').state, 'SELLER_UPLOAD_REQUIRED');
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
  assert.equal(h.accepted + h.processing + h.pending + h.rejected + h.sellerUploadRequired + h.createdByAmazon + h.cannotDetermineParts.incompleteSource + h.cannotDetermineParts.unmatched + h.cannotDetermineParts.unknownStatus + h.cannotDetermineParts.unknownTransactionIdFormat + out.docs.filter(d => d.state === 'PARTIALLY_ACCEPTED').length, h.documents);
  assert.equal(h.exceptions, h.rejected + h.sellerUploadRequired + h.correctionCyclesNotClosed + h.cannotDetermine);
  assert.match(h.sentence, /^Out of \d+ document\(s\) in the loaded files: \d+ exception\(s\)/); assert.match(h.sentence, /we cannot determine \(\d+ incomplete source, \d+ unmatched, \d+ unknown status, \d+ unknown correction id format, \d+ rows without a key\)/); assert.match(h.accountingComparison, /needs the seller invoice export/);
  const inc = reconcile([PO()]).headline; assert.equal(inc.anyCompleteImport, false);
  console.log('HEADLINE (R1+R2+R3 all-status):', reconcile([R1(), R2(), R3()]).headline.sentence);
  console.log('HEADLINE (pending-only only):', inc.sentence);
});

test('no legal-consequence wording anywhere in the engine output', () => {
  const out = reconcile([R1(), R2(), R3(), PO()]);
  const text = JSON.stringify([out.docs.map(d => d.explanation), out.imports.map(i => i.problems.concat(i.warnings)), out.headline]);
  assert.doesNotMatch(text, /compliant|filed|valid|issuance-ready|penalt|fine[sd]?\b|you are covered|legal|accepted on|date accepted|accepted at/i);
});

test('declared-versus-file contradiction is reported and the file is never upgraded', () => {
  const o = reconcile([{ ...PO(), declared: { ...DECL['pending-only.tsv'], options: 'ALL', rangeFrom: '2026-11-01', rangeTo: '2026-11-30' } }]);
  assert.match(o.warnings[0].warning, /looks like a pending-only report/); assert.equal(o.headline.accepted, 0);
});

const SR1 = () => load('special-r1.tsv'), SR2 = () => load('special-r2.tsv');
const byShip = (out, ship) => out.docs.filter(d => d.parts['shipping-id'] === ship);

test('Amazon-created documents are strictly apart from seller-uploaded ones: nothing due, no upload stage, own count', () => {
  const out = reconcile([SR1()]);
  for (const [ship, raw] of [['S9701', 'CreditNoteCreatedByAmazon'], ['S9801', 'InvoiceCreatedByAmazon']]) {
    const d = byShip(out, ship)[0]; assert.equal(d.state, 'CREATED_BY_AMAZON'); assert.equal(d.rawStatus, raw);
    const st = stages(d); assert.equal(st.expected.state, 'NOT DUE'); assert.equal(st.uploaded.state, 'NOT APPLICABLE'); assert.match(d.explanation, /seller has nothing to upload/);
  }
  assert.equal(out.headline.createdByAmazon, 2); assert.equal(out.headline.pending, 0); assert.equal(out.headline.exceptions - out.headline.cannotDetermine - out.headline.correctionCyclesNotClosed - out.headline.rejected, out.headline.sellerUploadRequired);
});

test('NoTaxCalculated creates an obligation: Expected is due, it is an exception while nothing is uploaded, and it clears only on a later report that shows an upload', () => {
  const o1 = reconcile([SR1()]), d = byShip(o1, 'S9802')[0];
  assert.equal(d.state, 'SELLER_UPLOAD_REQUIRED'); assert.equal(d.rawStatus, 'NoTaxCalculated'); assert.match(d.explanation, /seller must upload the invoice/); assert.match(d.explanation, /This is an exception/);
  const st = stages(d); assert.equal(st.expected.state, 'EVIDENCE'); assert.match(st.expected.obligation, /seller must upload the invoice/); assert.equal(st.uploaded.state, 'NOT VISIBLE');
  assert.equal(o1.headline.sellerUploadRequired, 2); assert.match(o1.headline.sentence, /2 where the seller must upload the invoice and nothing is uploaded \(NoTaxCalculated\)/);
  const o2 = reconcile([SR2(), SR1()]), d4 = byShip(o2, 'S9803')[0]; // S9803: NoTaxCalculated in r1, InvoiceUploaded in r2
  assert.equal(d4.state, 'ACCEPTED'); assert.deepEqual(d4.history.map(h => h.rawStatus), ['NoTaxCalculated', 'InvoiceUploaded']);
  assert.equal(byShip(o2, 'S9802')[0].state, 'SELLER_UPLOAD_REQUIRED', 'the one still without an upload stays an exception');
});

test('correction ids: allow-list. current and legacy shapes both close a cycle; near-misses are UNKNOWN_TRANSACTION_ID_FORMAT and never a correction', () => {
  assert.deepEqual(correctionRole('CorrectionReversal:X:1', 'REFUND'), 'REVERSAL'); assert.equal(correctionRole('Correction::X:2', 'SHIPMENT'), 'CORRECTED'); assert.equal(correctionRole('Correction:X:3', 'SHIPMENT'), 'CORRECTED');
  const out = reconcile([SR1()]);
  for (const [ship, fmt] of [['S9810', 'Correction::X:200000001'], ['S9820', 'Correction:X:200000002']]) {
    const sides = byShip(out, ship); assert.equal(sides.length, 2); assert.ok(sides.every(d => d.state === 'ACCEPTED'), ship);
    assert.ok(sides.some(d => d.parts['transaction-id'] === fmt && d.parts['transaction-type'] === 'SHIPMENT'), 'transaction id and type kept verbatim');
    assert.equal(out.cycles.find(c => c.key.endsWith(ship)).state, 'ACCEPTED');
  }
  for (const ship of ['S9830', 'S9831', 'S9832', 'S9833', 'S9834', 'S9835', 'S9836']) { const d = byShip(out, ship)[0]; assert.equal(d.state, 'UNKNOWN_TRANSACTION_ID_FORMAT', ship + ' ' + d.parts['transaction-id']); assert.equal(d.correction, null); assert.ok(!out.cycles.some(c => c.key.endsWith(ship))); assert.match(d.explanation, /did not treat it as a correction and did not treat it as an ordinary transaction/); }
  assert.equal(out.headline.cannotDetermineParts.unknownTransactionIdFormat, 7);
  assert.equal(byShip(out, 'S9837')[0].state, 'ACCEPTED', 'lower-case word is an ordinary id, not a correction'); assert.equal(byShip(out, 'S9837')[0].correction, null);
  // one side alone never closes the cycle
  const half = reconcile([{ ...SR1(), text: SR1().text.split('\n').filter(l => !l.includes('S9810') || l.includes('CorrectionReversal')).join('\n') }]);
  assert.equal(half.cycles.find(c => c.key.endsWith('S9810')).state, 'PARTIALLY_ACCEPTED'); assert.equal(byShip(half, 'S9810')[0].state, 'PARTIALLY_ACCEPTED');
});

test('timestamps: three separate times with their source, "observed as X in the report dated Y", never "accepted on"', () => {
  const imps = [R1(), R2(), R3()], out = reconcile(imps), d = doc(out, A), log = evidenceLog(d, imps, out.imports);
  assert.equal(d.firstObserved.rawStatus, 'InvoicePending'); assert.equal(d.acceptedObserved.rawStatus, 'InvoiceUploaded'); assert.equal(d.acceptedObserved.importId, 'all-r3-uploaded');
  const t = d.acceptedObserved.times;
  assert.deepEqual(t.reportCreated, { value: '2026-11-14T08:00:00Z', source: 'declared by the seller' }); assert.deepEqual(t.downloaded, { value: '2026-11-14T08:05:00Z', source: 'declared by the seller' }); assert.deepEqual(t.imported, { value: '2026-11-20T10:00:00Z', source: 'recorded by InvoiceGuard at import' });
  assert.match(d.acceptedObserved.meaning, /does not show when Amazon reached that state/);
  assert.equal(stages(d).accepted.observedAsInReportDated, '2026-11-14T08:00:00Z'); assert.match(stages(d).accepted.note, /not the date Amazon accepted it/);
  assert.deepEqual(log.acceptedObserved.times, t);
  // a report seen first as Uploaded weeks later says nothing about when it happened: only the report date is claimed
  const late = reconcile([R3()]); assert.equal(doc(late, A).firstObserved.rawStatus, 'InvoiceUploaded'); assert.match(doc(late, A).firstObserved.meaning, /not the moment it happened/);
  assert.doesNotMatch(JSON.stringify([out.docs.map(x => x.explanation), log]), /accepted on|date accepted|accepted at/i);
});
