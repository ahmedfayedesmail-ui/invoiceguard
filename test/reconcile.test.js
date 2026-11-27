import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CONTRACT_VERSION, CONTRACT_LABEL, reconcile, evidenceLog, stages, STATUS_MAP, KNOWN_STATUSES, correctionRole, statusTypeCompatibility } from '../src/reconcile.js';

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
  assert.equal(doc(o2, 'S9701').state, 'INCOMPLETE_SOURCE'); assert.equal(o2.headline.accepted, 0); assert.match(doc(o2, 'S9701').explanation, /it is not shown as accepted/);
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
    'range no longer than 30 days': { rangeFrom: '2026-10-01', rangeTo: '2026-11-30' }, 'range covers the order date': { rangeFrom: '2026-11-18', rangeTo: '2026-11-30' },
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
  const ob = reconcile([{ ...R3(), text: blank.join('\n') }]); assert.equal(ob.unkeyed.length, 1); assert.ok(ob.headline.rowsWithoutKey >= 1);
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
  assert.equal(h.accepted + h.partiallyAccepted + h.processing + h.pending + h.rejected + h.sellerUploadRequired + h.createdByAmazon + h.cannotDetermine, h.documents);
  assert.ok(h.exceptions <= h.documents); assert.equal(h.cannotDetermine, Object.values(h.cannotDetermineParts).reduce((a, b) => a + b, 0));
  assert.match(h.sentence, /^Out of \d+ document\(s\) in the loaded files: \d+ document\(s\) with an exception/); assert.match(h.sentence, /we cannot determine \(\d+ from a partly read file, \d+ from a file with missing columns, \d+ from another incomplete import, \d+ with an unmet check, \d+ with a missing or unreadable order date, \d+ with dates in a format we do not recognise, that look month-first or that contradict each other, \d+ waiting for the seller to confirm the date format, \d+ with an invoice number blank on some rows, \d+ unmatched, \d+ unknown status, \d+ unknown correction id format, \d+ status that does not fit the transaction type\)/); assert.match(h.sentence, /Separately, \d+ row\(s\) have a blank key field and are not counted as documents/); assert.match(h.accountingComparison, /needs the seller invoice export/);
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
  assert.equal(out.headline.createdByAmazon, 2); assert.equal(out.headline.pending, 0); assert.equal(out.headline.createdByAmazon, 2);
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
  assert.equal(out.headline.cannotDetermineParts.unknownTransactionIdFormat, 7); assert.ok(out.headline.exceptions <= out.headline.documents);
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

// ---------------------------------------------------------------- round 3: the gate, truncation, family/type matrix, arithmetic, snapshots
const HEADER = () => readFileSync('fixtures/recon/all-r3-uploaded.tsv', 'utf8').split('\n')[0];
const cellsOf = (line) => line.split('\t');
const col = (h, name) => h.split('\t').indexOf(name);
const invariant = (out, label) => { // the contract's own conditions: any ACCEPTED document comes from a complete, fully read import
  for (const d of out.docs.filter(x => x.state === 'ACCEPTED')) { const c = out.imports.find(i => i.id === d.current.importId); assert.ok(c.scope === 'COMPLETE_SCOPE' && !c.truncated && !c.problems.length, `${label}: ${d.key} ACCEPTED from an incomplete import`); }
  assert.ok(out.headline.exceptions <= out.headline.documents, `${label}: exceptions exceed documents`);
};

test('P1-a: one row outside the declared period makes the WHOLE import incomplete; an InvoiceUploaded document inside the period is not accepted', () => {
  const h = HEADER(), lines = R3().text.split('\n').filter(Boolean), out0 = lines[1].split('\t');
  const extra = [...out0]; extra[col(h, 'order-date')] = '15/12/2026'; extra[col(h, 'shipping-id')] = 'S9999'; extra[col(h, 'transaction-id')] = 'S9999'; extra[col(h, 'order-id')] = '405-0000000-0000009';
  const text = [...lines, extra.join('\t')].join('\n') + '\n';
  const out = reconcile([{ ...R3(), text }]);
  assert.equal(out.imports[0].scope, 'INCOMPLETE_SOURCE'); assert.ok(out.imports[0].problemCodes.includes('ROWS_OUTSIDE_RANGE'));
  assert.equal(out.headline.accepted, 0); assert.ok(out.docs.every(d => d.state !== 'ACCEPTED'));
  assert.equal(doc(out, 'S9001').state, 'INCOMPLETE_SOURCE'); assert.equal(doc(out, 'S9001').reasonCode, 'IMPORT_NOT_COMPLETE'); assert.match(doc(out, 'S9001').explanation, /order date outside the declared range/);
  invariant(out, 'P1-a(1)');
  console.log('P1-a outside-period import ->', out.imports[0].scope, out.imports[0].problemCodes.join(','), '| accepted =', out.headline.accepted, '| S9001 (InvoiceUploaded inside the period):', doc(out, 'S9001').state, doc(out, 'S9001').reasonCode);
});

test('P1-a: a report missing a required column (order-item-id) with an InvoiceUploaded document yields no ACCEPTED', () => {
  for (const missing of ['order-item-id', 'order-date', 'invoice-number', 'marketplace-id']) {
    const lines = R3().text.split('\n').filter(Boolean), h = lines[0].split('\t'), i = h.indexOf(missing);
    const text = lines.map(l => { const c = l.split('\t'); c.splice(i, 1); return c.join('\t'); }).join('\n') + '\n';
    const out = reconcile([{ ...R3(), text }]);
    assert.ok(out.imports[0].problemCodes.includes('MISSING_COLUMNS'), missing); assert.equal(out.headline.accepted, 0, missing); invariant(out, missing);
    if (missing !== 'marketplace-id') assert.ok(out.docs.some(d => d.state === 'INCOMPLETE_SOURCE' && d.reasonCode === 'MISSING_COLUMNS'), missing);
  }
});

test('P1-b: a truncated file (over 20,000 rows) never reaches ACCEPTED, says only part was read, and has its own reason in the breakdown', () => {
  const lines = R3().text.split('\n').filter(Boolean), h = lines[0], row = lines[1].split('\t'), body = [lines[1]];
  for (let i = 0; i < 20005; i++) { const c = [...row]; c[col(h, 'order-id')] = `405-7${String(i).padStart(6, '0')}-0000001`; c[col(h, 'shipping-id')] = `T${i}`; c[col(h, 'transaction-id')] = `T${i}`; c[col(h, 'invoice-number')] = `A-2026-T${i}`; body.push(c.join('\t')); }
  const text = [h, ...body].join('\n') + '\n';
  const out = reconcile([{ ...R3(), text }]);
  assert.equal(out.imports[0].truncated, true); assert.ok(out.imports[0].problemCodes.includes('TRUNCATED_FILE')); assert.match(out.imports[0].problems.join(' '), /Only part of the file was read/);
  assert.equal(out.headline.accepted, 0, 'the readable part contains InvoiceUploaded and none of it is accepted'); assert.ok(out.docs.length >= 20000);
  assert.ok(out.docs.every(d => d.state === 'INCOMPLETE_SOURCE' && d.reasonCode === 'TRUNCATED_FILE'));
  assert.equal(out.headline.cannotDetermineParts.truncatedFile, out.docs.length); assert.equal(out.headline.cannotDetermineParts.missingColumns, 0);
  assert.match(out.headline.sentence, /\d+ from a partly read file/); assert.ok(out.warnings.some(w => /Only part of this file was read/.test(w.warning)));
  assert.match(out.docs[0].explanation, /Only part of the file was read/); invariant(out, 'P1-b');
  console.log('P1-b truncated import ->', out.imports[0].scope, out.imports[0].problemCodes.join(','), `| rows read ${out.imports[0].rows} | accepted = ${out.headline.accepted} | first doc:`, out.docs[0].state, out.docs[0].reasonCode, '|', out.docs[0].explanation.slice(0, 160));
  // the same through the structured entry point
  const viaRows = reconcile([{ ...R3(), text: undefined, rows: R3().text.split('\n').filter(Boolean).slice(1).map(l => Object.fromEntries(cellsOf(HEADER()).map((k, i) => [k, l.split('\t')[i]]))), truncated: true }]);
  assert.equal(viaRows.headline.accepted, 0); invariant(viaRows, 'P1-b rows');
});

test('P1-c MATRIX: every one of the 11 statuses against every transaction type, each cell asserted', () => {
  const OK = { // hand-written: which statuses belong with which type (Invoice* with SHIPMENT, CreditNote* with REFUND/RETURN, NoTaxCalculated not restricted by Amazon's table)
    SHIPMENT: ['InvoicePending', 'InvoiceProcessing', 'InvoiceUploaded', 'InvoiceRejected', 'InvoiceCreatedByAmazon', 'NoTaxCalculated'],
    REFUND: ['CreditNotePending', 'CreditNoteProcessing', 'CreditNoteUploaded', 'CreditNoteRejected', 'CreditNoteCreatedByAmazon', 'NoTaxCalculated'],
    RETURN: ['CreditNotePending', 'CreditNoteProcessing', 'CreditNoteUploaded', 'CreditNoteRejected', 'CreditNoteCreatedByAmazon', 'NoTaxCalculated'],
    FOO: [],
  };
  const lines = R3().text.split('\n').filter(Boolean), h = lines[0], base = lines[1].split('\t'); let cells = 0;
  const expectedState = { InvoicePending: 'PENDING', CreditNotePending: 'PENDING', InvoiceProcessing: 'PROCESSING', CreditNoteProcessing: 'PROCESSING', InvoiceUploaded: 'ACCEPTED', CreditNoteUploaded: 'ACCEPTED', InvoiceRejected: 'REJECTED', CreditNoteRejected: 'REJECTED', InvoiceCreatedByAmazon: 'CREATED_BY_AMAZON', CreditNoteCreatedByAmazon: 'CREATED_BY_AMAZON', NoTaxCalculated: 'SELLER_UPLOAD_REQUIRED' };
  assert.equal(Object.keys(expectedState).length, 11);
  for (const type of ['SHIPMENT', 'REFUND', 'RETURN', 'FOO']) for (const status of Object.keys(expectedState)) {
    const c = [...base]; c[col(h, 'invoice-status')] = status; c[col(h, 'transaction-type')] = type; c[col(h, 'transaction-id')] = type === 'SHIPMENT' || type === 'FOO' ? 'S9001' : 'amzn1:crow:X1';
    const out = reconcile([{ ...R3(), text: h + '\n' + c.join('\t') + '\n' }]), d = out.docs[0]; cells++;
    const want = OK[type].includes(status) ? expectedState[status] : 'INCOMPATIBLE_STATUS_AND_TYPE';
    assert.equal(d.state, want, `${type} + ${status}`); assert.equal(d.rawStatus, status);
    if (want === 'INCOMPATIBLE_STATUS_AND_TYPE') { assert.notEqual(d.state, 'ACCEPTED'); assert.notEqual(d.state, 'UNMATCHED'); assert.match(d.explanation, /cannot go with this transaction type/); assert.equal(out.headline.cannotDetermineParts.incompatibleStatusAndType, 1); assert.equal(out.headline.accepted, 0); }
    invariant(out, `${type}+${status}`);
  }
  assert.equal(cells, 44);
  for (const [s, t] of [['InvoiceUploaded', 'REFUND'], ['CreditNoteUploaded', 'SHIPMENT'], ['InvoiceUploaded', 'RETURN']]) { const f = statusTypeCompatibility(s, t); assert.equal(f.ok, false); assert.equal(f.code, 'FAMILY_MISMATCH'); }
  assert.equal(statusTypeCompatibility('InvoiceUploaded', 'FOO').code, 'UNKNOWN_TRANSACTION_TYPE');
  console.log('P1-c matrix cells asserted:', cells, '| e.g. REFUND+InvoiceUploaded ->', 'INCOMPATIBLE_STATUS_AND_TYPE');
});

test('P2-a: exceptions never exceed documents; rows without a key are their own line outside the denominator', () => {
  const sets = [[R1()], [R2()], [R3()], [PO()], [SR1()], [SR2()], [R1(), R2(), R3(), PO(), SR1(), SR2()]];
  for (const [i, set] of sets.entries()) { const o = reconcile(set), h = o.headline; assert.ok(h.exceptions <= h.documents, 'set ' + i); assert.equal(h.documents, o.docs.length); invariant(o, 'set ' + i); }
  // only unkeyed rows: zero documents, zero exceptions, the rows reported separately
  const lines = R3().text.split('\n').filter(Boolean), c = lines[1].split('\t'); c[col(lines[0], 'shipping-id')] = '';
  const only = reconcile([{ ...R3(), text: lines[0] + '\n' + c.join('\t') + '\n' + c.join('\t') + '\n' }]);
  assert.equal(only.headline.documents, 0); assert.equal(only.headline.exceptions, 0); assert.equal(only.headline.rowsWithoutKey, 2); assert.equal(only.headline.cannotDetermine, 0);
  // a document that is both REJECTED and in an open correction cycle is one exception, not two
  const t = SR1().text.split('\n').map(l => l.includes('CorrectionReversal:X:200000001') ? l.replace('CreditNoteUploaded', 'CreditNoteRejected') : l).join('\n');
  const o2 = reconcile([{ ...SR1(), text: t }]); assert.ok(o2.headline.exceptions <= o2.headline.documents); assert.ok(o2.headline.rejected >= 1 && o2.headline.correctionCyclesNotClosed >= 1);
});

test('P2-b: each stage reads only ITS OWN report snapshot, never the current report', () => {
  const r1 = R1(), r2 = R2(), r3 = R3();
  r1.text = r1.text.replace(/(\tS9001\tS9001\tSHIPMENT\t\tInvoicePending\t\tFALSE\t[^\t]*\t)2026-11-06T09:00:00Z/, '$12026-11-07T01:02:03Z');
  assert.match(r1.text, /2026-11-07T01:02:03Z/);
  r2.text = r2.text.replace('A-2026-000123', ''); // the Processing report shows the upload without a number
  r3.text = r3.text.replace('A-2026-000123', 'A-2026-000999'); // the final report shows a different (re-uploaded) number
  const out = reconcile([r1, r2, r3]), d = doc(out, A), st = stages(d);
  assert.equal(d.state, 'ACCEPTED'); assert.equal(d.evidence.invoiceNumber, 'A-2026-000999');
  assert.equal(st.expected.columns['shipment-date'], '2026-11-07T01:02:03Z', 'Expected reads the shipment-date in its own (first) report, not the current one');
  assert.equal(st.expected.source, 'import all-r1-pending'); assert.equal(st.uploaded.source, 'import all-r2-processing');
  assert.equal(st.uploaded.documentId, 'NOT VISIBLE in that report', 'Uploaded must not borrow the number from the current report');
  assert.equal(st.accepted.documentId, 'A-2026-000999'); assert.equal(st.accepted.source, 'import all-r3-uploaded');
  assert.ok(d.history.every(x => Array.isArray(x.rows) && x.rows.length >= 1), 'every observation keeps its own matched-row snapshot');
  // a stage that its own snapshot cannot support says so
  assert.equal(stages(doc(reconcile([PO()]), 'S9701')).accepted.state, 'NOT SHOWN');
});

test('structure: ACCEPTED is produced in one place (gateAccepted) and every ACCEPTED in every fixture combination passes the invariant', () => {
  const src = readFileSync('src/reconcile.js', 'utf8');
  const assigns = src.split('\n').filter(l => /(state|mapped)\s*[:=]\s*[^=]*'ACCEPTED'/.test(l) && !/===|!==|\?\s*'ACCEPTED'\s*:\s*accepted/.test(l) && !l.trim().startsWith('//') && !l.includes('STATUS_MAP') && !l.includes('InvoiceUploaded:'));
  assert.deepEqual(assigns.map(l => l.trim().slice(0, 90)), [assigns[0].trim().slice(0, 90)], 'exactly one line assigns the ACCEPTED state: ' + JSON.stringify(assigns));
  assert.match(assigns[0], /!unmet\.length \? 'ACCEPTED' : onlyDate/);
  for (const set of [[R1(), R2(), R3()], [R3(), PO()], [PO(), R2()], [SR1(), SR2()]]) invariant(reconcile(set), 'combo');
});

// ---------------------------------------------------------------- round 4: required values are never dropped before validation
const withExtraRow = (base, edit) => { const L = base.text.split('\n').filter(l => l.length), h = L[0].split('\t'), c = L[1].split('\t'); edit(c, h); return { ...base, text: L.join('\n') + '\n' + c.join('\t') + '\n' }; };

test('P1-1: a row with an empty order date makes the whole import INCOMPLETE_SOURCE (MISSING_OR_INVALID_ORDER_DATE); accepted = 0', () => {
  const imp = withExtraRow(R3(), (c, h) => { c[h.indexOf('order-date')] = ''; c[h.indexOf('shipping-id')] = 'S9998'; c[h.indexOf('transaction-id')] = 'S9998'; c[h.indexOf('order-id')] = '405-0000000-0000008'; c[h.indexOf('invoice-status')] = 'InvoicePending'; c[h.indexOf('invoice-number')] = ''; });
  const two = (() => { const L = imp.text.split('\n').filter(l => l.length); return { ...imp, text: [L[0], L[1], L.at(-1)].join('\n') + '\n' }; })();
  assert.equal(reconcile([two]).headline.accepted, 0, 'one InvoiceUploaded plus one row with an empty date: nothing accepted');
  const out = reconcile([imp]);
  assert.ok(out.imports[0].problemCodes.includes('MISSING_OR_INVALID_ORDER_DATE')); assert.equal(out.imports[0].scope, 'INCOMPLETE_SOURCE');
  assert.equal(out.headline.accepted, 0); assert.equal(doc(out, 'S9001').state, 'INCOMPLETE_SOURCE'); assert.equal(doc(out, 'S9001').reasonCode, 'MISSING_OR_INVALID_ORDER_DATE');
  assert.ok(out.headline.cannotDetermineParts.orderDateMissingOrUnreadable >= 1); assert.equal(out.headline.cannotDetermineParts.orderDateMissingOrUnreadable, out.docs.filter(d => d.reasonCode === 'MISSING_OR_INVALID_ORDER_DATE').length);
  for (const bad of ['31/02/2018', '32/01/2018', '00/10/2026', '  ']) {
    const o = reconcile([withExtraRow(R3(), (c, h) => { c[h.indexOf('order-date')] = bad; c[h.indexOf('shipping-id')] = 'S9997'; c[h.indexOf('transaction-id')] = 'S9997'; c[h.indexOf('order-id')] = '405-0000000-0000007'; })]);
    assert.equal(o.headline.accepted, 0, bad); assert.ok(o.imports[0].problemCodes.includes('MISSING_OR_INVALID_ORDER_DATE'), bad);
  }
  console.log('P1-1 one good InvoiceUploaded + one row with an empty order date ->', out.imports[0].scope, out.imports[0].problemCodes.join(','), '| accepted =', out.headline.accepted, '| S9001:', doc(out, 'S9001').state, doc(out, 'S9001').reasonCode);
});

test('P1-2: invoice number blank on one row and filled on another of the same document is a disagreement; no ACCEPTED; explicit state', () => {
  const lines = R3().text.split('\n').filter(l => l.length), h = lines[0].split('\t'), c = lines[1].split('\t'), c2 = [...c];
  c2[h.indexOf('order-item-id')] = c[h.indexOf('order-item-id')] + '-B'; c2[h.indexOf('invoice-number')] = '';
  const out = reconcile([{ ...R3(), text: [lines[0], lines[1], c2.join('\t'), ...lines.slice(2)].join('\n') + '\n' }]);
  const solo = reconcile([{ ...R3(), text: [lines[0], lines[1], c2.join('\t')].join('\n') + '\n' }]); assert.equal(solo.headline.accepted, 0); assert.equal(solo.headline.documents, 1);
  const d = doc(out, 'S9001');
  assert.equal(d.state, 'INVOICE_NUMBER_INCOMPLETE'); assert.equal(out.headline.accepted, reconcile([R3()]).headline.accepted - 1, 'only this document lost its ACCEPTED'); assert.match(d.explanation, /blank is treated as a value/);
  assert.equal(out.headline.cannotDetermineParts.invoiceNumberIncomplete, 1); assert.ok(out.headline.exceptions <= out.headline.documents);
  // two different non-blank numbers stay an ambiguity, and all-blank on an InvoiceUploaded row cannot be accepted either
  const c3 = [...c2]; c3[h.indexOf('invoice-number')] = 'A-2026-000777';
  assert.equal(doc(reconcile([{ ...R3(), text: [lines[0], lines[1], c3.join('\t'), ...lines.slice(2)].join('\n') + '\n' }]), 'S9001').state, 'UNMATCHED');
  const c4 = [...c]; c4[h.indexOf('invoice-number')] = '';
  assert.notEqual(doc(reconcile([{ ...R3(), text: [lines[0], c4.join('\t'), ...lines.slice(2)].join('\n') + '\n' }]), 'S9001').state, 'ACCEPTED');
  console.log('P1-2 multi-row document, one row numbered, one blank ->', d.state, '| accepted (that document alone, 2 rows) =', solo.headline.accepted, '|', d.explanation.slice(0, 150));
});

test('P2-1 Expected: InvoiceUploaded shows no Expected', () => {
  const st = stages(doc(reconcile([R3()]), 'S9001')); assert.equal(st.expected.state, 'NOT VISIBLE'); assert.equal(st.expected.obligation, undefined);
});
const oneStatus = (status, id) => { const lines = R3().text.split('\n').filter(l => l.length), h = lines[0].split('\t'), c = lines[1].split('\t'); c[h.indexOf('invoice-status')] = status; if (status !== 'InvoiceUploaded') c[h.indexOf('invoice-number')] = ''; return stages(doc(reconcile([{ ...R3(), text: lines[0] + '\n' + c.join('\t') + '\n' }]), id)); };
test('P2-1 Expected: InvoiceProcessing shows no new upload required', () => { const st = oneStatus('InvoiceProcessing', 'S9001'); assert.equal(st.expected.state, 'NO NEW UPLOAD REQUIRED'); assert.equal(st.expected.obligation, undefined); });
test('P2-1 Expected: InvoicePending shows Expected', () => { const st = oneStatus('InvoicePending', 'S9001'); assert.equal(st.expected.state, 'EVIDENCE'); assert.match(st.expected.obligation, /waiting for the seller/); });
test('P2-1 Expected: InvoiceRejected shows re-upload required', () => { const st = oneStatus('InvoiceRejected', 'S9001'); assert.equal(st.expected.state, 'EVIDENCE'); assert.match(st.expected.obligation, /Re-upload required/); });
test('P2-1 Expected: NoTaxCalculated shows the seller upload obligation', () => { const st = oneStatus('NoTaxCalculated', 'S9001'); assert.equal(st.expected.state, 'EVIDENCE'); assert.match(st.expected.obligation, /seller must upload the invoice/); });
test('P2-1 Expected: an INCOMPLETE_SOURCE document whose status was Uploaded never becomes Expected', () => {
  const lines = R3().text.split('\n').filter(l => l.length), c = lines[1].split('\t'), h = lines[0].split('\t'); c[h.indexOf('order-date')] = '31/02/2026';
  const d = doc(reconcile([{ ...R3(), text: lines[0] + '\n' + c.join('\t') + '\n' }]), 'S9001'); assert.equal(d.state, 'INCOMPLETE_SOURCE'); assert.notEqual(stages(d).expected.state, 'EVIDENCE');
});

test('P2-2: one exported contract version; the document, the log and the bundle all derive from it; a mismatch fails', async () => {
  const doc0 = readFileSync('docs/EVIDENCE-CONTRACT.md', 'utf8'), first = doc0.split('\n')[0];
  assert.equal(first, `# InvoiceGuard Evidence Contract ${CONTRACT_VERSION} (normative; implemented in src/reconcile.js, src/txid.js, src/history.js)`);
  assert.equal(CONTRACT_LABEL, `EVIDENCE-CONTRACT ${CONTRACT_VERSION}`);
  const out = reconcile([R1(), R2(), R3()]); assert.equal(evidenceLog(doc(out, A), [R1(), R2(), R3()], out.imports).contract, CONTRACT_LABEL);
  const { createHistory, memoryAdapter } = await import('../src/history.js'); const h = createHistory(memoryAdapter()); await h.addImport(R3());
  assert.equal((await h.evidenceBundle()).contract, CONTRACT_LABEL);
  for (const f of ['src/reconcile.js', 'src/history.js']) assert.ok(!/EVIDENCE-CONTRACT v\d/.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')), `${f} hard-codes a contract version`);
});

test('class: no required field is dropped, defaulted or skipped before validation between parse and gateAccepted', () => {
  for (const f of ['src/reconcile.js', 'src/history.js']) assert.ok(!/\.filter\(Boolean\)/.test(readFileSync(f, 'utf8')), `${f} still uses .filter(Boolean)`);
  const src = readFileSync('src/reconcile.js', 'utf8');
  assert.ok(!/\.filter\(x => !!x\)|\.filter\(Number\)|\.filter\(String\)/.test(src));
  // behaviour: blank each required column in ONE extra row of an otherwise good, accepted import. Never a silently complete import.
  for (const col of ['marketplace-id', 'order-id', 'order-item-id', 'shipping-id', 'transaction-id', 'transaction-type', 'invoice-status', 'order-date']) {
    const imp = withExtraRow(R3(), (c, h) => { c[h.indexOf(col)] = ''; if (!['order-id', 'shipping-id', 'transaction-id'].includes(col)) { c[h.indexOf('order-id')] = '405-0000000-0000006'; c[h.indexOf('shipping-id')] = 'S9996'; c[h.indexOf('transaction-id')] = 'S9996'; } });
    const out = reconcile([imp]); assert.equal(out.imports[0].scope, 'INCOMPLETE_SOURCE', `blank ${col} left the import COMPLETE_SCOPE`); assert.equal(out.headline.accepted, 0, `blank ${col}`);
  }
  // invoice-number: blank is a value; mixed blank and filled is never accepted (see P1-2)
  const base = reconcile([R3()]); assert.equal(base.imports[0].scope, 'COMPLETE_SCOPE'); assert.ok(base.headline.accepted >= 1);
});

// ---------------------------------------------------------------- round 5: file dates (Amazon's DD/MM/YYYY), separate declared parser, ambiguity, blank lines
const setDates = (imp, f) => { const L = imp.text.split('\n').filter(l => l.length), h = L[0].split('\t'), i = h.indexOf('order-date'); let n = 0; return { ...imp, text: L.map((l, k) => { if (!k) return l; const c = l.split('\t'); c[i] = typeof f === 'function' ? f(n++) : f; return c.join('\t'); }).join('\n') + '\n' }; };
const withRange = (imp, from, to) => ({ ...imp, declared: { ...imp.declared, rangeFrom: from, rangeTo: to } });

test('dates: 17/05/2018 (Amazon\'s documented DD/MM/YYYY) is read, matches a range covering 17 May 2018, and the document is ACCEPTED', () => {
  const imp = withRange(setDates(R3(), '17/05/2018'), '2018-05-01', '2018-05-30'), out = reconcile([imp]);
  assert.equal(out.imports[0].scope, 'COMPLETE_SCOPE'); assert.ok(out.headline.accepted >= 1); assert.equal(out.imports[0].dateOrder.order, 'DAY_FIRST'); assert.match(out.imports[0].dateOrder.basis, /proven/);
  assert.deepEqual(out.imports[0].fileOrderDates, { first: '2018-05-17', last: '2018-05-17' });
  const exact = reconcile([withRange(setDates(R3(), '17/05/2018'), '2018-05-17', '2018-05-17')]); assert.ok(exact.headline.accepted >= 1);
  const miss = reconcile([withRange(setDates(R3(), '17/05/2018'), '2018-06-01', '2018-06-30')]); assert.equal(miss.headline.accepted, 0); assert.ok(miss.imports[0].problemCodes.includes('ROWS_OUTSIDE_RANGE'));
});

test('dates: impossible days are rejected (31/02/2018, 32/01/2018) and a blank date still blocks completeness and ACCEPTED', () => {
  for (const [bad, code] of [['31/02/2018', 'MISSING_OR_INVALID_ORDER_DATE'], ['32/01/2018', 'MISSING_OR_INVALID_ORDER_DATE'], ['', 'MISSING_OR_INVALID_ORDER_DATE']]) {
    const imp = withRange(setDates(R3(), (n) => n === 0 ? bad : '17/05/2018'), '2018-05-01', '2018-05-30'), out = reconcile([imp]);
    assert.equal(out.imports[0].scope, 'INCOMPLETE_SOURCE', JSON.stringify(bad)); assert.ok(out.imports[0].problemCodes.includes(code), JSON.stringify(bad)); assert.equal(out.headline.accepted, 0, JSON.stringify(bad));
  }
});

test('dates: no prefix matching: 2026-11-27Tgarbage, 2026-11-27T99:99:99Z and every other non-DD/MM/YYYY shape give UNRECOGNIZED_DATE_FORMAT', () => {
  for (const bad of ['2026-11-27Tgarbage', '2026-11-27T99:99:99Z', '2026-11-27', '2026-11-27T10:00:00Z', '17/11/2026 garbage', '17/11/26', '17/5/2026', '17-11-2026', 'tomorrow', '17/11/2026T10:00', ' 17/11/2026x']) {
    const out = reconcile([withRange(setDates(R3(), (n) => n === 0 ? bad : '17/11/2026'), '2026-11-01', '2026-11-30')]);
    assert.ok(out.imports[0].problemCodes.includes('UNRECOGNIZED_DATE_FORMAT'), bad); assert.equal(out.headline.accepted, 0, bad);
    assert.ok(out.docs.filter(d => d.rawStatus === 'InvoiceUploaded').every(d => d.state === 'INCOMPLETE_SOURCE' && d.reasonCode === 'UNRECOGNIZED_DATE_FORMAT'), bad);
  }
  const o = reconcile([withRange(setDates(R3(), '2026-11-27'), '2026-11-01', '2026-11-30')]);
  assert.match(o.imports[0].problems.join(' '), /not in a format we recognise. Amazon documents DD\/MM\/YYYY/); assert.ok(o.headline.cannotDetermineParts.dateFormatUnrecognized >= 1);
  assert.match(o.headline.sentence, /with dates in a format we do not recognise, that look month-first or that contradict each other/);
  console.log('dates: unrecognised format ->', o.imports[0].scope, o.imports[0].problemCodes.join(','), '| accepted =', o.headline.accepted, '|', o.imports[0].problems[0]);
});

test('dates: the two kinds of date use different parsers (declared range is the seller\'s ISO date picker value; file dates are Amazon\'s DD/MM/YYYY)', () => {
  const dd = reconcile([withRange(R3(), '01/11/2026', '30/11/2026')]); assert.ok(dd.imports[0].problemCodes.includes('NO_RANGE')); assert.equal(dd.headline.accepted, 0);
  const iso = reconcile([withRange(R3(), '2026-11-01', '2026-11-30')]); assert.ok(iso.headline.accepted >= 1);
  const bad = reconcile([withRange(R3(), '2026-02-31', '2026-11-30')]); assert.equal(bad.headline.accepted, 0);
  const tail = reconcile([withRange(R3(), '2026-11-01Tjunk', '2026-11-30')]); assert.equal(tail.headline.accepted, 0);
});

const CONFIRM = { dateOrderConfirmed: 'DD/MM/YYYY' };
const withConfirm = (imp, extra = CONFIRM) => ({ ...imp, declared: { ...imp.declared, ...extra } });

test('dates: DD/MM/YYYY proven by a value in the file is accepted and needs no confirmation', () => {
  const out = reconcile([withRange(setDates(R3(), (n) => n === 0 ? '17/03/2018' : '05/03/2018'), '2018-03-01', '2018-03-30')]);
  assert.equal(out.imports[0].dateOrder.order, 'DAY_FIRST'); assert.equal(out.imports[0].dateOrder.provenByFile, true); assert.equal(out.imports[0].dateOrder.sellerConfirmed, null);
  assert.ok(out.headline.accepted >= 1); assert.equal(out.imports[0].scope, 'COMPLETE_SCOPE'); assert.equal(out.headline.cannotDetermineParts.dateOrderUnconfirmed, 0);
});

test('dates: MONTH_FIRST is not a parse path: a month-first value makes the file unreadable (MONTH_FIRST_NOT_SUPPORTED) even with a seller confirmation', () => {
  for (const imp of [withRange(setDates(R3(), (n) => n === 0 ? '05/17/2018' : '05/03/2018'), '2018-05-01', '2018-05-30'), withConfirm(withRange(setDates(R3(), (n) => n === 0 ? '05/17/2018' : '05/03/2018'), '2018-05-01', '2018-05-30'))]) {
    const out = reconcile([imp]);
    assert.equal(out.imports[0].scope, 'INCOMPLETE_SOURCE'); assert.ok(out.imports[0].problemCodes.includes('MONTH_FIRST_NOT_SUPPORTED')); assert.equal(out.imports[0].dateOrder, null); assert.equal(out.headline.accepted, 0);
    assert.match(out.imports[0].problems.join(' '), /look month-first \(for example "05\/17\/2018"\)\. Amazon documents DD\/MM\/YYYY for this report, so this file cannot be read as it is/);
    assert.ok(out.docs.filter(d => d.rawStatus === 'InvoiceUploaded').every(d => d.state === 'INCOMPLETE_SOURCE' && d.reasonCode === 'MONTH_FIRST_NOT_SUPPORTED'));
    assert.ok(out.headline.cannotDetermineParts.dateFormatUnrecognized >= 1);
  }
  const o = reconcile([withRange(setDates(R3(), (n) => n === 0 ? '05/17/2018' : '05/03/2018'), '2018-05-01', '2018-05-30')]);
  console.log('dates: month-first file ->', o.imports[0].scope, o.imports[0].problemCodes.join(','), '| accepted =', o.headline.accepted, '|', o.imports[0].problems[0]);
});

test('dates: a file of entirely ambiguous dates with no seller confirmation gives accepted = 0 (DATE_ORDER_UNCONFIRMED)', () => {
  const out = reconcile([withRange(setDates(R3(), '05/03/2018'), '2018-03-01', '2018-03-30')]), d = doc(out, 'S9001');
  assert.equal(out.imports[0].dateOrder.provenByFile, false); assert.equal(out.headline.accepted, 0);
  assert.equal(d.state, 'DATE_ORDER_UNCONFIRMED'); assert.equal(d.reasonCode, 'DATE_ORDER_UNCONFIRMED'); assert.match(d.explanation, /Confirm DD\/MM\/YYYY/);
  assert.ok(out.headline.cannotDetermineParts.dateOrderUnconfirmed >= 1); assert.ok(out.headline.exceptions <= out.headline.documents);
  assert.ok(out.imports[0].warnings.some(w => /nothing is shown as accepted until the seller confirms/.test(w)));
  console.log('dates: unconfirmed ambiguous file (all 05/03/2018) ->', out.imports[0].scope, '| accepted =', out.headline.accepted, '|', d.state, '|', out.imports[0].warnings[0]);
});

test('dates: the same ambiguous file WITH the seller confirmation proceeds to the remaining conditions (declared, not verified)', () => {
  const march = reconcile([withConfirm(withRange(setDates(R3(), '05/03/2018'), '2018-03-01', '2018-03-30'))]);
  assert.ok(march.headline.accepted >= 1); assert.equal(march.imports[0].dateOrder.sellerConfirmed, true); assert.match(march.imports[0].dateOrder.confirmationLabel, /declared by the seller, not verified by InvoiceGuard/);
  const chk = doc(march, 'S9001').evidence.preconditions.find(p => p.name === 'date order known'); assert.equal(chk.ok, true); assert.equal(chk.how, 'declared-by-seller');
  // it proceeds to the OTHER conditions, which still block on their own: the read is 5 March, so a May range blocks, and a missing declaration blocks
  const may = reconcile([withConfirm(withRange(setDates(R3(), '05/03/2018'), '2018-05-01', '2018-05-30'))]); assert.equal(may.headline.accepted, 0); assert.ok(may.imports[0].problemCodes.includes('ROWS_OUTSIDE_RANGE'));
  const wrong = reconcile([withConfirm(withRange(setDates(R3(), '05/03/2018'), '2018-03-01', '2018-03-30'), { dateOrderConfirmed: 'MM/DD/YYYY' })]); assert.equal(wrong.headline.accepted, 0);
  const noHow = reconcile([withConfirm(withRange(setDates(R3(), '05/03/2018'), '2018-03-01', '2018-03-30'), { dateOrderConfirmed: 'DD/MM/YYYY', obtainedHow: '' })]); assert.equal(noHow.headline.accepted, 0);
});

test('dates: a confirmation belongs to one import: it does not carry to another file, and a later month-first file contradicting it is surfaced, not overridden', () => {
  const a = withConfirm(withRange({ ...setDates(R3(), '05/03/2018'), id: 'file-a' }, '2018-03-01', '2018-03-30'));
  const b = withRange({ ...setDates(R3(), '05/03/2018'), id: 'file-b', declared: { ...R3().declared, createdAt: '2026-11-20T08:00:00Z' } }, '2018-03-01', '2018-03-30'); // same seller, no confirmation of its own
  const out = reconcile([a, b]); assert.equal(out.imports.find(i => i.id === 'file-a').dateOrder.sellerConfirmed, true); assert.equal(out.imports.find(i => i.id === 'file-b').dateOrder.sellerConfirmed, false);
  assert.ok(out.docs.some(d => d.state === 'DATE_ORDER_UNCONFIRMED' && d.current.importId === 'file-b'));
  const c = withRange({ ...setDates(R3(), (n) => n === 0 ? '05/17/2018' : '05/03/2018'), id: 'file-c', declared: { ...R3().declared, createdAt: '2026-11-25T08:00:00Z' } }, '2018-05-01', '2018-05-30');
  const clash = reconcile([a, c]); assert.equal(clash.dateOrderConflicts.length, 1); assert.equal(clash.dateOrderConflicts[0].confirmedImport, 'file-a'); assert.equal(clash.dateOrderConflicts[0].contradictingImport, 'file-c');
  assert.ok(clash.warnings.some(w => w.importId === 'file-a' && /confirmation is not applied/.test(w.warning)));
  assert.equal(clash.imports.find(i => i.id === 'file-a').dateOrder.sellerConfirmed, true); assert.equal(clash.headline.accepted, 0, 'the confirmed file is not accepted while a contradiction stands');
});

test('dates: a file whose only dates are unrecognised (or blank) does not claim its dates are ambiguous', () => {
  for (const v of ['2026-11-27', '', '31/02/2018', 'tomorrow']) {
    const out = reconcile([withConfirm(withRange(setDates(R3(), v), '2026-11-01', '2026-11-30'))]);
    assert.equal(out.imports[0].dateOrder, null, JSON.stringify(v)); assert.ok(!out.imports[0].warnings.some(w => /ambiguous/.test(w)), JSON.stringify(v)); assert.equal(out.headline.accepted, 0);
  }
});

test('dates: the evidence log carries the date order, its basis, the file\'s order dates and the date warnings', () => {
  const imp = withConfirm(withRange(setDates(R3(), '05/03/2018'), '2018-03-01', '2018-03-30')), out = reconcile([imp]), d = doc(out, 'S9001'), log = evidenceLog(d, [imp], out.imports);
  assert.equal(log.dateReading.dateOrder, 'DAY_FIRST'); assert.match(log.dateReading.dateOrderBasis, /seller must confirm DD\/MM\/YYYY/); assert.equal(log.dateReading.sellerConfirmedDateOrder, true);
  assert.match(log.dateReading.confirmationLabel, /not verified by InvoiceGuard/); assert.deepEqual(log.dateReading.fileOrderDates, { first: '2018-03-05', last: '2018-03-05' });
  assert.ok(log.dateReading.dateWarnings.length >= 1); assert.ok(log.notVerifiedAutomatically.some(x => /date order/.test(x)));
  const proven = reconcile([R3()]), pl = evidenceLog(doc(proven, A), [R3()], proven.imports); assert.equal(pl.dateReading.dateOrderBasis, 'proven by values in the file'); assert.ok(!pl.notVerifiedAutomatically.some(x => /date order/.test(x)));
});

test('dates: the cross-file conflict alone blocks the confirmed import: two imports with DIFFERENT documents, so no document is shared and recency cannot explain the refusal', () => {
  const A1 = withConfirm(withRange({ ...setDates(R3(), '05/03/2018'), id: 'file-a' }, '2018-03-01', '2018-03-30'));
  // file-b: month-first dates, and every document key is different from file-a's (other orders, shipments, transactions)
  const rekey = (imp) => { const L = imp.text.split('\n').filter(l => l.length), h = L[0].split('\t'); const ix = ['order-id', 'shipping-id', 'transaction-id'].map(k => h.indexOf(k));
    return { ...imp, text: L.map((l, k) => { if (!k) return l; const c = l.split('\t'); c[ix[0]] = c[ix[0]].replace(/^405-/, '999-'); c[ix[1]] = 'Z' + c[ix[1]]; c[ix[2]] = 'Z' + c[ix[2]]; return c.join('\t'); }).join('\n') + '\n' }; };
  const B1 = withRange({ ...rekey(setDates(R3(), (n) => n === 0 ? '05/17/2018' : '05/03/2018')), id: 'file-b' }, '2018-05-01', '2018-05-30');
  const keysA = new Set(reconcile([A1]).docs.map(d => d.key)), keysB = new Set(reconcile([B1]).docs.map(d => d.key));
  assert.ok(keysA.size >= 1 && keysB.size >= 1); assert.equal([...keysA].filter(k => keysB.has(k)).length, 0, 'the two imports share no document');
  // control: file-a alone is accepted on the strength of its confirmation
  const alone = reconcile([A1]); assert.ok(alone.headline.accepted >= 1); assert.equal(alone.dateOrderConflicts.length, 0);
  // together: nothing about file-a's own documents changed except the conflict, and they are refused for that reason only
  const both = reconcile([A1, B1]), aDocs = both.docs.filter(d => keysA.has(d.key));
  assert.equal(both.dateOrderConflicts.length, 1); assert.equal(both.dateOrderConflicts[0].confirmedImport, 'file-a'); assert.equal(both.dateOrderConflicts[0].contradictingImport, 'file-b');
  assert.ok(aDocs.every(d => d.current.importId === 'file-a'), "each of file-a's documents is current in file-a: file-b is not a newer report of it");
  const cand = aDocs.filter(d => d.rawStatus === 'InvoiceUploaded'); assert.ok(cand.length >= 1);
  assert.ok(cand.every(d => d.state === 'DATE_ORDER_UNCONFIRMED' && d.reasonCode === 'DATE_ORDER_UNCONFIRMED'));
  assert.ok(cand.every(d => d.evidence.preconditions.filter(p => !p.ok).map(p => p.name).join() === 'date order known'), 'the conflict is the ONLY unmet condition');
  assert.match(cand[0].evidence.preconditions.find(p => p.name === 'date order known').detail, /does not carry across files and is not silently overridden/);
  assert.equal(both.headline.accepted, 0);
  // file-b's own documents are refused for their own reason (month-first), not for the conflict
  assert.ok(both.docs.filter(d => keysB.has(d.key) && d.rawStatus === 'InvoiceUploaded').every(d => d.reasonCode === 'MONTH_FIRST_NOT_SUPPORTED'));
});
