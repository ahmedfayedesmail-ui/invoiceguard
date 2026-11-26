// Round-14: external critic round-12 findings on e547c31.
// 1. EVENT ORDERING WITHOUT TIMESTAMPS (his main ask): ms timestamps cannot order a report
//    request against an attempt claimed in the same millisecond, and a >= comparison would risk
//    skipping a FRESH verdict. Fix (his prescription): a monotonic per-seller attempt sequence.
//    Every atomic claim takes the next attempt_seq; every VIDR report snapshots the seller's
//    current sequence at request time; a document whose current attempt_seq is newer than the
//    report's snapshot cannot be described by that report - the verdict is skipped and logged.
// 2. CREDIT-NOTE PATH COVERAGE: the guard exists in reconcileCreditNote; these tests prove it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, migrateAuth, currentAttemptSeq } from '../src/db.js';
import { processReport, processCorrections } from '../src/pipeline.js';
import { listRepairs, approveRepair } from '../src/repair.js';

const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'selR14', name: 'Test S.L.', nif: 'B1', address: 'x', country: 'ES' };
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
const vidrAt = (db, number) => db.prepare('SELECT vidr_processing_at FROM invoices WHERE seller_id=? AND number=?').get(seller.id, number)?.vidr_processing_at;
const attemptSeqOf = (db, number) => db.prepare('SELECT attempt_seq FROM invoices WHERE seller_id=? AND number=?').get(seller.id, number)?.attempt_seq;
const skips = (db, number) => db.prepare("SELECT detail FROM events WHERE seller_id=? AND type='stale_report_verdict_skipped'").all(seller.id).filter(e => String(e.detail).includes(number));
const untilSending = async (db, number) => { for (let i = 0; i < 500 && statusOf(db, number) !== 'sending'; i++) await new Promise(r => setImmediate(r)); };

// A billing correction: a reversal (credit note) for transaction X:1 plus the corrected row X:2.
function correctionPair() {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const row = rows[0].split('\t');
  const rev = [...row]; rev[ix('transaction-type')] = 'REFUND'; rev[ix('transaction-id')] = 'CorrectionReversal:X:1';
  ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { rev[ix(n)] = '-' + rev[ix(n)]; });
  rev[ix('invoice-status')] = 'CreditNotePending';
  const fixed = [...row]; fixed[ix('transaction-id')] = 'Correction::X:2'; fixed[ix('billing-name')] = 'Mediterranea Logistica Norte S.L.'; fixed[ix('is-invoice-corrected')] = undefined;
  return [head, rev.join('\t'), fixed.join('\t')].join('\n');
}

// Seed: upload, Amazon rejects (technical), a reviewed retry is proposed (plain invoice path).
async function seedRejectedInvoice(db) {
  const api = { uploadInvoice: async () => 'feed-0', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT * FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  const [head, ...rows] = text.trim().split('\n');
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceRejected', 'invoice-status-description': 'Internal processing error' }), { api, validate: vies });
  assert.equal(statusOf(db, inv.number), 'rejected');
  const q = listRepairs(db, seller.id).find(r => r.kind === 'rejected_invoice');
  assert.ok(q, 'a reviewed retry was proposed');
  return { api, inv, head, rows, q };
}

// Seed: a correction credit note went out, Amazon rejected it (technical), a reviewed retry
// (retry_rect: the SAME document goes up again) is proposed.
async function seedRejectedCreditNote(db) {
  const api = { uploadInvoice: async () => 'feed-0', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const corr = correctionPair();
  const r = await processCorrections(db, seller, corr, { api, validate: vies });
  assert.equal(r.creditNotes, 1, 'the correction credit note went out');
  const cn = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='rectificativa' AND shipment_key='REFUND:CorrectionReversal:X:1'").get(seller.id);
  assert.ok(cn, 'the credit note exists');
  const [head, ...rows] = corr.trim().split('\n');
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'CreditNoteRejected', 'invoice-status-description': 'Internal processing error' }), { api, validate: vies });
  assert.equal(statusOf(db, cn.number), 'rejected');
  const q = listRepairs(db, seller.id).find(x => x.kind === 'rejected_credit_note');
  assert.ok(q, 'a reviewed retry was proposed for the credit note');
  return { api, cn, head, rows, q };
}

test('R12-1: identical timestamps cannot express the ordering - the attempt SEQUENCE still skips the stale verdict', async () => {
  const db = openDb(); seedSeller(db);
  const { api, inv, head, rows, q } = await seedRejectedInvoice(db);
  const staleTs = new Date();
  const staleSeq = currentAttemptSeq(db, seller.id); // the sync's report request predates the retry
  let release; const gate = new Promise(r => release = r);
  const api2 = { uploadInvoice: () => gate.then(() => 'feed-NEW'), feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  const retry = approveRepair(db, seller, q.event_key, { api: api2, validate: vies });
  await untilSending(db, inv.number);
  assert.ok(attemptSeqOf(db, inv.number) > staleSeq, 'the claim took a higher sequence than the report snapshot');
  // Force the exact clock tie the critic warned about: the claim's sending_at reads as the SAME
  // millisecond as the report request. A timestamp comparison cannot tell these events apart
  // (and >= would risk skipping a fresh verdict); the sequence orders them exactly.
  db.prepare('UPDATE invoices SET sending_at=? WHERE seller_id=? AND number=?').run(staleTs.toISOString(), seller.id, inv.number);
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceRejected', 'invoice-status-description': 'Internal processing error' }), { api, validate: vies, reportRequestedAt: staleTs, reportAttemptSeq: staleSeq });
  assert.equal(statusOf(db, inv.number), 'sending', 'the stale rejection is skipped even with identical timestamps');
  assert.equal(skips(db, inv.number).length, 1, 'the skip is logged as evidence');
  release(); await retry;
  assert.equal(statusOf(db, inv.number), 'submitted', 'the successful attempt stands - no resurrection to rejected');
});

test('R12-2 (his a): a STALE CreditNoteProcessing arriving after a new claim must skip and log', async () => {
  const db = openDb(); seedSeller(db);
  const { api, cn, head, rows, q } = await seedRejectedCreditNote(db);
  const staleSeq = currentAttemptSeq(db, seller.id); // report requested BEFORE the retry's claim
  let release; const gate = new Promise(r => release = r);
  const api2 = { uploadInvoice: () => gate.then(() => 'feed-CN-NEW'), feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  const retry = approveRepair(db, seller, q.event_key, { api: api2, validate: vies });
  await untilSending(db, cn.number);
  assert.equal(statusOf(db, cn.number), 'sending');
  assert.equal(vidrAt(db, cn.number), null, 'the claim cleared the old verdict');
  // The pre-attempt report says "processing": it cannot describe the attempt now in flight.
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'CreditNoteProcessing' }), { api, validate: vies, reportAttemptSeq: staleSeq });
  assert.equal(vidrAt(db, cn.number), null, 'the stale verdict must NOT stamp the credit note');
  assert.equal(statusOf(db, cn.number), 'sending', 'the stale verdict must NOT move the attempt');
  assert.equal(skips(db, cn.number).length, 1, 'the skip is logged as evidence');
  release(); await retry;
  assert.equal(statusOf(db, cn.number), 'submitted', 'no stamp -> plain submitted');
});

test('R12-3 (his b): a STALE CreditNoteRejected during a credit-note resend must NOT re-reject after success', async () => {
  const db = openDb(); seedSeller(db);
  const { api, cn, head, rows, q } = await seedRejectedCreditNote(db);
  const staleSeq = currentAttemptSeq(db, seller.id);
  let release; const gate = new Promise(r => release = r);
  const api2 = { uploadInvoice: () => gate.then(() => 'feed-CN-NEW'), feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  const retry = approveRepair(db, seller, q.event_key, { api: api2, validate: vies });
  await untilSending(db, cn.number);
  // The pre-attempt report carries the OLD rejection again: it must not resurrect it.
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'CreditNoteRejected', 'invoice-status-description': 'Internal processing error' }), { api, validate: vies, reportAttemptSeq: staleSeq });
  assert.equal(statusOf(db, cn.number), 'sending', 'the stale rejection must NOT move the attempt');
  assert.equal(skips(db, cn.number).length, 1, 'the skip is logged');
  release(); await retry;
  assert.equal(statusOf(db, cn.number), 'submitted', 'the successful attempt stands - no resurrection to rejected');
  assert.equal(listRepairs(db, seller.id).filter(r => r.kind === 'rejected_credit_note').length, 0, 'no duplicate retry proposal from the stale report');
});
