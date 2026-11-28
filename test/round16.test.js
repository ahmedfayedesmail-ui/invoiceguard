// Round-16: external critic round-14 findings on 68f57b1.
// 1. COVERAGE: round15.test.js proved the CorrectionReversal pass; R14-1 adds the standalone
//    Correction:: second-pass test (stale report row must never resubmit the replacement).
// 2. PROPOSAL FRESHNESS: detectRepairs stamps every proposal with its source report's snapshot
//    and request time; the review UI shows that freshness; approval re-validates the refund event
//    and amounts against the latest stored report whenever a fresher one exists, holding with a
//    clear reason on divergence. A stale report may mint an APPROVABLE proposal; it must never
//    ISSUE from stale amounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, migrateAuth, currentAttemptSeq, nextReportGen } from '../src/db.js';
import { processReport, processCorrections as processCorrectionsRaw } from '../src/pipeline.js';
import { withApproval, acceptReport } from './correction-helpers.js';
const processCorrections = withApproval(processCorrectionsRaw); // owner decision Nov 28: a person approves the pair first (older tests, assertions unchanged)
import { detectRepairs, listRepairs, approveRepair, recordReportSnapshot } from '../src/repair.js';

const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'selR16', name: 'Test S.L.', nif: 'B1', address: 'x', country: 'ES' };
const vies = async (v) => ({ status: 'valid', vat: v });
const api = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };

const withDesc = (head, row, patch) => {
  const c = head.split('\t'); const ix = (n) => c.indexOf(n); const r = [...row];
  while (r.length < c.length) r.push('');
  let desc = '';
  for (const [k, v] of Object.entries(patch)) { if (k === 'invoice-status-description') { desc = v ?? ''; continue; } r[ix(k)] = v; }
  r.push(desc);
  return [head + '\tinvoice-status-description', r.join('\t')].join('\n');
};
const statusOf = (db, number) => db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, number)?.upload_status;
const attemptSeqOf = (db, number) => db.prepare('SELECT attempt_seq FROM invoices WHERE seller_id=? AND number=?').get(seller.id, number)?.attempt_seq;
const spyApi = (state) => ({ uploadInvoice: async () => { state.uploads++; return 'feed-SPY-' + state.uploads; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] });
const failingApi = () => ({ uploadInvoice: async () => { throw Object.assign(new Error('network dropped after submission'), { unknownOutcome: true }); }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] });

function refundReport(scale = 1) {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const row = rows[0].split('\t');
  const ref = [...row]; ref[ix('transaction-type')] = 'REFUND'; ref[ix('transaction-id')] = 'r-100-1'; ref[ix('invoice-status')] = 'CreditNotePending';
  ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { ref[ix(n)] = String(-Math.abs(Number(ref[ix(n)])) * scale); });
  return [head, ref.join('\t')].join('\n');
}
function correctionPair() {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const row = rows[0].split('\t');
  const rev = [...row]; rev[ix('transaction-type')] = 'REFUND'; rev[ix('transaction-id')] = 'CorrectionReversal:X:1';
  ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { rev[ix(n)] = '-' + rev[ix(n)]; });
  rev[ix('invoice-status')] = 'CreditNotePending';
  const fixed = [...row]; fixed[ix('transaction-id')] = 'Correction::X:2'; fixed[ix('billing-name')] = 'Mediterranea Logistica Norte S.L.'; fixed[ix('is-invoice-corrected')] = undefined;
  return [head, rev.join('\t'), fixed.join('\t')].join('\n');
}

test('R14-1: a STALE Correction:: row must NOT resubmit the replacement (processCorrections pass 2, standalone)', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const corr = correctionPair();
  await processCorrections(db, seller, corr, { api, validate: vies });
  const [h0, ...cRows] = corr.trim().split('\n');
  await acceptReport(db, seller, withDesc(h0, cRows[0].split('\t'), { 'invoice-status': 'CreditNoteUploaded' }), { api, validate: vies });
  await processCorrections(db, seller, corr, { api, validate: vies });
  const repl = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='rectificativa' AND shipment_key='SHIPMENT:Correction::X:2'").get(seller.id);
  assert.ok(repl, 'the replacement document exists');
  // Amazon rejects the replacement; the reviewed retry goes out and its outcome is UNKNOWN.
  await processReport(db, seller, withDesc(h0, cRows[1].split('\t'), { 'invoice-status': 'InvoiceRejected', 'invoice-status-description': 'Internal processing error' }), { api, validate: vies });
  assert.equal(statusOf(db, repl.number), 'rejected');
  const q = listRepairs(db, seller.id).find(x => x.kind === 'rejected_correction_invoice');
  assert.ok(q, 'a reviewed retry was proposed');
  const staleSeq = currentAttemptSeq(db, seller.id); // a report requested NOW predates the retry
  await assert.rejects(approveRepair(db, seller, q.event_key, { api: failingApi(), validate: vies }));
  assert.equal(statusOf(db, repl.number), 'unknown', 'the retry went unknown');
  assert.ok(attemptSeqOf(db, repl.number) > staleSeq, 'the retry took a newer attempt_seq');
  // The stale report still lists the Correction:: row: pass 2 must skip it, never resubmit.
  const spy = { uploads: 0 };
  const out = await processCorrections(db, seller, corr, { api: spyApi(spy), validate: vies, reportAttemptSeq: staleSeq });
  assert.equal(spy.uploads, 0, 'the stale report caused NO resubmission');
  assert.equal(out.invoices, 0);
  assert.ok(out.skipped.some(x => x.key === 'SHIPMENT:Correction::X:2' && /stale report row/.test(x.reason)), 'the skip names the reason');
  assert.equal(statusOf(db, repl.number), 'unknown');
});

test('R14-2: proposals carry the source report generation + request time, re-stamped in place on a fresher report', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const g0 = nextReportGen(db, seller.id), at0 = new Date('2026-11-25T10:00:00Z');
  detectRepairs(db, seller, refundReport(), { reportGen: g0, reportRequestedAt: at0 });
  const row = db.prepare('SELECT report_gen, report_at FROM repairs WHERE seller_id=?').get(seller.id);
  assert.equal(row.report_gen, g0, 'the proposal is stamped with the source report generation (round-17: generation, not attempt_seq)');
  assert.equal(row.report_at, at0.toISOString(), 'and the request time');
  const g1 = nextReportGen(db, seller.id), at1 = new Date('2026-11-26T10:00:00Z');
  detectRepairs(db, seller, refundReport(), { reportGen: g1, reportRequestedAt: at1 });
  const row2 = db.prepare('SELECT report_gen, report_at FROM repairs WHERE seller_id=?').get(seller.id);
  assert.equal(row2.report_gen, g1, 'the open proposal is re-stamped by the fresher report');
  assert.equal(row2.report_at, at1.toISOString());
});

test('R14-3: a fresher report with DIFFERENT amounts holds the approval - nothing issues from stale amounts', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const g0 = nextReportGen(db, seller.id);
  detectRepairs(db, seller, refundReport(), { reportGen: g0, reportRequestedAt: new Date('2026-11-25T10:00:00Z') });
  const [p] = listRepairs(db, seller.id);
  recordReportSnapshot(db, seller.id, { gen: g0 + 1, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-26T10:00:00Z').toISOString(), text: refundReport(0.5) });
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /different refund amounts/);
  assert.equal(listRepairs(db, seller.id).length, 1, 'the proposal stays in the queue');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 0, 'nothing was issued');
  assert.equal(db.prepare("SELECT count(*) c FROM events WHERE seller_id=? AND type='stale_proposal_held'").get(seller.id).c, 1, 'the hold is logged');
});

test('R14-4: a fresher report with MATCHING amounts lets the approval issue normally', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const g0 = nextReportGen(db, seller.id);
  detectRepairs(db, seller, refundReport(), { reportGen: g0, reportRequestedAt: new Date('2026-11-25T10:00:00Z') });
  const [p] = listRepairs(db, seller.id);
  recordReportSnapshot(db, seller.id, { gen: g0 + 1, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-26T10:00:00Z').toISOString(), text: refundReport() });
  const res = await approveRepair(db, seller, p.event_key, { api, validate: vies });
  assert.ok(res.rectNumber, 'the credit note was issued from re-validated fresh data');
  assert.equal(db.prepare("SELECT count(*) c FROM events WHERE seller_id=? AND type='stale_proposal_held'").get(seller.id).c, 0, 'no hold was logged');
});

test('R14-5: a fresher report that NO LONGER lists the refund event holds the approval', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const g0 = nextReportGen(db, seller.id);
  detectRepairs(db, seller, refundReport(), { reportGen: g0, reportRequestedAt: new Date('2026-11-25T10:00:00Z') });
  const [p] = listRepairs(db, seller.id);
  recordReportSnapshot(db, seller.id, { gen: g0 + 1, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-26T10:00:00Z').toISOString(), text }); // the event is gone
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /no longer lists this refund event/);
  assert.equal(listRepairs(db, seller.id).length, 1, 'the proposal stays in the queue');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 0, 'nothing was issued');
});

test('R14-6 (reviewer re-check): a LEGACY un-stamped proposal + divergent fresher snapshot is held, not issued', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  detectRepairs(db, seller, refundReport()); // pre-freshness: no stamp options -> report_gen NULL
  const [p] = listRepairs(db, seller.id);
  assert.equal(p.report_gen ?? null, null, 'this proposal predates freshness tracking');
  recordReportSnapshot(db, seller.id, { gen: 1, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-26T10:00:00Z').toISOString(), text: refundReport(0.5) });
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /different refund amounts/);
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 0, 'nothing was issued from the stale legacy proposal');
  assert.equal(db.prepare("SELECT count(*) c FROM events WHERE seller_id=? AND type='stale_proposal_held'").get(seller.id).c, 1, 'the hold is logged');
});

test('R14-7 (reviewer re-check): a LEGACY un-stamped proposal + fresher snapshot with the event GONE is held, not issued', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  detectRepairs(db, seller, refundReport());
  const [p] = listRepairs(db, seller.id);
  recordReportSnapshot(db, seller.id, { gen: 1, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-26T10:00:00Z').toISOString(), text }); // event gone
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /no longer lists this refund event/);
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 0, 'nothing was issued');
});
