// Round-15: external critic round-13 findings on c7fbddb.
// P1-A: sequence allocation and the conditional claim were separate statements. Now every claim
//   path runs them inside ONE BEGIN IMMEDIATE transaction, so no report can observe the
//   incremented counter before the attempt is recorded on the document. A lost claim burns a
//   number (documented, harmless gap).
// P1-B: the snapshot guard covered only final-state verdicts. Now EVERY report-row-driven
//   decision is guarded: a stale report (requested before a document's current attempt) must
//   never cause a new financial upload - not via InvoicePending rows in processReport, not via
//   CreditNotePending in settleUnknownDocuments, not via CorrectionReversal/Correction:: rows in
//   processCorrections. His closing principle: it is not enough to stop a stale report from
//   changing state; it must also never cause a new upload based on old information.
import test from 'node:test'; import { proved, seqOpt, authorizeRetry } from './helpers/prove-verdict.js';
import { acceptReport } from './correction-helpers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, migrateAuth, currentAttemptSeq, nextAttemptSeq, txImm } from '../src/db.js';
import { processReport, processCorrections as processCorrectionsRaw, settleUnknownDocuments } from '../src/pipeline.js';
import { withApproval } from './correction-helpers.js';
const processCorrections = withApproval(processCorrectionsRaw); // owner decision Nov 28: a person approves the pair first (older tests, assertions unchanged)
import { listRepairs, approveRepair } from '../src/repair.js';

const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'selR15', name: 'Test S.L.', nif: 'B1', address: 'x', country: 'ES' };
const vies = async (v) => ({ status: 'valid', vat: v });

function seedSeller(db) {
  migrateAuth(db);
  db.prepare('INSERT INTO sellers (id,name,nif,address,marketplace_ids,region,created_at,country) VALUES (?,?,?,?,?,?,?,?)')
    .run(seller.id, seller.name, seller.nif, seller.address, '["ES"]', 'EU', new Date().toISOString(), 'ES');
}
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
const staleSkips = (db, number) => db.prepare("SELECT detail FROM events WHERE seller_id=? AND type='stale_report_row_skipped'").all(seller.id).filter(e => String(e.detail).includes(number));
const spyApi = (state) => ({ uploadInvoice: async () => { state.uploads++; return 'feed-SPY-' + state.uploads; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] });
const failingApi = () => ({ uploadInvoice: async () => { throw Object.assign(new Error('network dropped after submission'), { unknownOutcome: true }); }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] });

function correctionPair() {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const row = rows[0].split('\t');
  const rev = [...row]; rev[ix('transaction-type')] = 'REFUND'; rev[ix('transaction-id')] = 'CorrectionReversal:X:1';
  ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { rev[ix(n)] = '-' + rev[ix(n)]; });
  rev[ix('invoice-status')] = 'CreditNotePending';
  const fixed = [...row]; fixed[ix('transaction-id')] = 'Correction::X:2'; fixed[ix('billing-name')] = 'Mediterranea Logistica Norte S.L.'; fixed[ix('is-invoice-corrected')] = undefined;
  return [head, rev.join('\t'), fixed.join('\t')].join('\n');
}

// Invoice uploaded, rejected (technical), retry proposed, retry approved, retry's outcome UNKNOWN:
// the document now has a NEWER attempt (higher attempt_seq) whose result Amazon has not confirmed.
async function seedUnknownInvoice(db) {
  const api = { uploadInvoice: async () => 'feed-0', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT * FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  const [head, ...rows] = text.trim().split('\n');
  await processReport(db, seller, proved(db, seller.id, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceRejected', 'invoice-status-description': 'Internal processing error' })), { ...seqOpt(db, seller.id), api, validate: vies });
  const q = listRepairs(db, seller.id).find(r => r.kind === 'rejected_invoice');
  const staleSeq = currentAttemptSeq(db, seller.id); // a report requested NOW predates the retry
  await assert.rejects(approveRepair(db, seller, q.event_key, { api: failingApi(), validate: vies }));
  assert.equal(statusOf(db, inv.number), 'unknown', 'the new attempt went unknown');
  assert.ok(attemptSeqOf(db, inv.number) > staleSeq, 'the retry took a newer attempt_seq');
  return { api, inv, staleSeq };
}

// Same shape for a correction credit note: issued, rejected, retry proposed, retry went unknown.
async function seedUnknownCreditNote(db) {
  const api = { uploadInvoice: async () => 'feed-0', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const corr = correctionPair();
  await processCorrections(db, seller, corr, { api, validate: vies });
  const cn = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='rectificativa' AND shipment_key='REFUND:CorrectionReversal:X:1'").get(seller.id);
  const [head, ...rows] = corr.trim().split('\n');
  await acceptReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'CreditNoteRejected', 'invoice-status-description': 'Internal processing error' }), { api, validate: vies });
  const q = listRepairs(db, seller.id).find(x => x.kind === 'rejected_credit_note');
  const staleSeq = currentAttemptSeq(db, seller.id);
  await assert.rejects(approveRepair(db, seller, q.event_key, { api: failingApi(), validate: vies }));
  assert.equal(statusOf(db, cn.number), 'unknown', 'the credit note retry went unknown');
  assert.ok(attemptSeqOf(db, cn.number) > staleSeq, 'the retry took a newer attempt_seq');
  return { api, cn, corr, staleSeq };
}

test('R13-1 (his danger scenario): a STALE "still pending" report must NOT resend an invoice whose new attempt went unknown', async () => {
  const db = openDb(); seedSeller(db);
  const { inv, staleSeq } = await seedUnknownInvoice(db);
  const spy = { uploads: 0 };
  // The stale report (requested BEFORE the retry) lists the shipment as still pending.
  await processReport(db, seller, text, { api: spyApi(spy), validate: vies, reportAttemptSeq: staleSeq });
  assert.equal(spy.uploads, 0, 'the stale report caused NO new upload');
  assert.equal(statusOf(db, inv.number), 'unknown', 'the document state is untouched');
  assert.ok(staleSkips(db, inv.number).length >= 1, 'the stale row skip is logged as evidence');
});

test('R13-2 (control): a FRESH report still settles the same unknown document - the guard is what blocked R13-1', async () => {
  const db = openDb(); seedSeller(db);
  const { inv } = await seedUnknownInvoice(db);
  const spy = { uploads: 0 };
  const freshSeq = currentAttemptSeq(db, seller.id); // requested AFTER the unknown attempt
  await processReport(db, seller, text, { api: spyApi(spy), validate: vies, reportAttemptSeq: freshSeq });
  assert.equal(spy.uploads, 0, 'ruling 5: a fresh report alone never resubmits an unknown outcome');
  const hold = db.prepare("SELECT event_key k FROM repairs WHERE kind='unknown_outcome' AND state='proposed'").get();
  await authorizeRetry(db, seller.id, hold.k);
  await processReport(db, seller, text, { api: spyApi(spy), validate: vies, reportAttemptSeq: freshSeq });
  assert.equal(spy.uploads, 1, 'after the one-shot authorization the same document is resubmitted');
  assert.equal(statusOf(db, inv.number), 'submitted');
});

test('R13-3: a STALE CreditNotePending must NOT resubmit a credit note whose new attempt went unknown (settleUnknownDocuments)', async () => {
  const db = openDb(); seedSeller(db);
  const { cn, corr, staleSeq } = await seedUnknownCreditNote(db);
  const spy = { uploads: 0 };
  const res = await settleUnknownDocuments(db, seller, corr, { api: spyApi(spy), validate: vies, reportAttemptSeq: staleSeq });
  assert.equal(spy.uploads, 0, 'the stale report caused NO resubmission');
  assert.equal(statusOf(db, cn.number), 'unknown');
  assert.ok(res.waiting.includes(cn.number), 'the document keeps waiting');
  assert.ok(staleSkips(db, cn.number).length >= 1, 'the stale row skip is logged');
});

test('R13-4: a STALE CorrectionReversal row must NOT drive a credit-note upload (processCorrections)', async () => {
  const db = openDb(); seedSeller(db);
  const { cn, corr, staleSeq } = await seedUnknownCreditNote(db);
  const spy = { uploads: 0 };
  const out = await processCorrections(db, seller, corr, { api: spyApi(spy), validate: vies, reportAttemptSeq: staleSeq });
  assert.equal(spy.uploads, 0, 'the stale report caused NO new upload');
  assert.equal(out.creditNotes, 0);
  assert.ok(out.skipped.some(x => x.key === 'REFUND:CorrectionReversal:X:1' && /stale report row/.test(x.reason)), 'the skip names the reason');
  assert.equal(statusOf(db, cn.number), 'unknown');
});

test('R13-5 (P1-A): allocation lives inside the claim transaction - unique, monotonic, gap-tolerant', async () => {
  const db = openDb(); seedSeller(db);
  const api = { uploadInvoice: async () => 'feed-0', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const seqs = db.prepare("SELECT attempt_seq FROM invoices WHERE seller_id=? AND attempt_seq IS NOT NULL ORDER BY attempt_seq").all(seller.id).map(r => r.attempt_seq);
  assert.ok(seqs.length > 0, 'claims assigned sequences');
  assert.equal(new Set(seqs).size, seqs.length, 'no two documents share an attempt_seq');
  assert.equal(Math.max(...seqs), currentAttemptSeq(db, seller.id), 'the counter equals the highest claimed attempt');
  // A losing claim (document already submitted) burns a number inside its own transaction: the
  // gap is documented and harmless - the NEXT real claim still takes a strictly higher sequence.
  const inv = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  const before = currentAttemptSeq(db, seller.id);
  const loser = txImm(db, () => db.prepare("UPDATE invoices SET upload_status='sending', sending_at=?, vidr_processing_at=NULL, attempt_seq=? WHERE seller_id=? AND number=? AND upload_status IN ('pending','unknown')").run(new Date().toISOString(), nextAttemptSeq(db, seller.id), seller.id, inv.number));
  assert.equal(loser.changes, 0, 'the claim loses on the state predicate');
  assert.ok(currentAttemptSeq(db, seller.id) > before, 'the burned number leaves a documented gap, monotonicity intact');
});
