// Round-13: external critic round-11 finding on 54f2bdd.
// P1 - stale VIDR report resurrection: sync requests a VIDR report, and before it is processed
//   the user can approve a resend (repairs/approve is outside the sync lock). The claim clears
//   the old verdict and starts a new attempt; then the PRE-ATTEMPT report is processed and its
//   verdicts (Processing/Rejected/Uploaded) stamp vidr_processing_at or move the document's
//   state, resurrecting an old verdict over the new attempt.
//   Fix: the report's request time travels into processing (reportRequestedAt); a verdict from a
//   report requested before the document's current attempt (sending_at, stamped by the atomic
//   claim) is skipped and logged as stale_report_verdict_skipped.
// Round-11/12 semantics are untouched: claim-time clearing, the atomic success write, and
// previous-cycle staleness all keep working - these tests prove both directions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, migrateAuth, currentAttemptSeq } from '../src/db.js';
import { processReport, pollFeeds } from '../src/pipeline.js';
import { listRepairs, approveRepair } from '../src/repair.js';

const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'selR13', name: 'Test S.L.', nif: 'B1', address: 'x', country: 'ES' };
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
const skips = (db, number) => db.prepare("SELECT detail FROM events WHERE seller_id=? AND type='stale_report_verdict_skipped'").all(seller.id).filter(e => String(e.detail).includes(number));
const untilSending = async (db, number) => { for (let i = 0; i < 500 && statusOf(db, number) !== 'sending'; i++) await new Promise(r => setImmediate(r)); };

// Seed: upload, Amazon rejects (technical), a reviewed retry is proposed.
async function seedRejected(db) {
  const api = { uploadInvoice: async () => 'feed-0', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT * FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  const [head, ...rows] = text.trim().split('\n');
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceRejected', 'invoice-status-description': 'Internal processing error' }), { api, validate: vies });
  assert.equal(statusOf(db, inv.number), 'rejected');
  const q = listRepairs(db, seller.id).find(r => r.kind === 'rejected_invoice');
  assert.ok(q, 'a reviewed retry was proposed');
  return { api, inv, head, rows };
}

test('R11-1 (his test 1): a STALE InvoiceProcessing report must NOT protect the new feed from FATAL', async () => {
  const db = openDb(); seedSeller(db);
  const { api, inv, head, rows } = await seedRejected(db);
  const q = listRepairs(db, seller.id).find(r => r.kind === 'rejected_invoice');
  // The sync's report was requested BEFORE the retry's claim.
  const staleRequestedAt = new Date();
  const staleSeq = currentAttemptSeq(db, seller.id);
  let release; const gate = new Promise(r => release = r);
  const api2 = { uploadInvoice: () => gate.then(() => 'feed-NEW'), feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  const retry = approveRepair(db, seller, q.event_key, { api: api2, validate: vies });
  await untilSending(db, inv.number);
  assert.equal(statusOf(db, inv.number), 'sending');
  // The pre-attempt report is processed while the new attempt is in flight: its verdict is stale.
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceProcessing' }), { api, validate: vies, reportRequestedAt: staleRequestedAt, reportAttemptSeq: staleSeq });
  assert.equal(vidrAt(db, inv.number), null, 'the stale verdict must NOT stamp the document');
  assert.equal(statusOf(db, inv.number), 'sending', 'the stale verdict must NOT move the attempt');
  assert.equal(skips(db, inv.number).length, 1, 'the skip is logged as evidence');
  release(); await retry;
  assert.equal(statusOf(db, inv.number), 'submitted', 'no stamp -> plain submitted');
  // The new feed goes FATAL: the stale verdict gives NO protection - normal discipline applies.
  const p = await pollFeeds(db, seller, { ...api, feedStatus: async (id) => id === 'feed-NEW' ? { status: 'FATAL', resultDocumentId: 'rdS' } : { status: 'DONE' }, downloadFeedResult: async () => 'error\tfatal' });
  assert.equal(statusOf(db, inv.number), 'unknown');
  assert.ok(listRepairs(db, seller.id).some(r => r.kind === 'unknown_outcome'), 'the human hold exists');
  assert.equal(p.conflicts, 0, 'no false protection from the stale report');
});

test('R11-2 (his test 2): a STALE InvoiceRejected arriving during a resend must NOT re-reject after success', async () => {
  const db = openDb(); seedSeller(db);
  const { api, inv, head, rows } = await seedRejected(db);
  const q = listRepairs(db, seller.id).find(r => r.kind === 'rejected_invoice');
  const staleRequestedAt = new Date();
  const staleSeq = currentAttemptSeq(db, seller.id);
  let release; const gate = new Promise(r => release = r);
  const api2 = { uploadInvoice: () => gate.then(() => 'feed-NEW'), feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  const retry = approveRepair(db, seller, q.event_key, { api: api2, validate: vies });
  await untilSending(db, inv.number);
  // The pre-attempt report carries the OLD rejection again: it must not resurrect it.
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceRejected', 'invoice-status-description': 'Internal processing error' }), { api, validate: vies, reportRequestedAt: staleRequestedAt, reportAttemptSeq: staleSeq });
  assert.equal(statusOf(db, inv.number), 'sending', 'the stale rejection must NOT move the attempt');
  assert.equal(skips(db, inv.number).length, 1, 'the skip is logged');
  release(); await retry;
  assert.equal(statusOf(db, inv.number), 'submitted', 'the successful attempt stands - no resurrection to rejected');
  assert.equal(listRepairs(db, seller.id).filter(r => r.kind === 'rejected_invoice').length, 0, 'no duplicate retry proposal from the stale report');
});

test('R11-3: a FRESH report (requested after the claim) mid-flight still applies its verdict', async () => {
  const db = openDb(); seedSeller(db);
  const { api, inv, head, rows } = await seedRejected(db);
  const q = listRepairs(db, seller.id).find(r => r.kind === 'rejected_invoice');
  let release; const gate = new Promise(r => release = r);
  const api2 = { uploadInvoice: () => gate.then(() => 'feed-NEW'), feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  const retry = approveRepair(db, seller, q.event_key, { api: api2, validate: vies });
  await untilSending(db, inv.number);
  const freshRequestedAt = new Date(); // requested AFTER the claim
  const freshSeq = currentAttemptSeq(db, seller.id); // the snapshot INCLUDES the in-flight claim
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceProcessing' }), { api, validate: vies, reportRequestedAt: freshRequestedAt, reportAttemptSeq: freshSeq });
  assert.ok(vidrAt(db, inv.number), 'the fresh verdict stamps the document');
  assert.equal(skips(db, inv.number).length, 0, 'nothing was skipped');
  release(); await retry;
  assert.equal(statusOf(db, inv.number), 'processing', 'round-12 semantics intact: fresh mid-flight verdict wins');
  const p = await pollFeeds(db, seller, { ...api, feedStatus: async (id) => id === 'feed-NEW' ? { status: 'FATAL', resultDocumentId: 'rdF' } : { status: 'DONE' }, downloadFeedResult: async () => 'error\tfatal' });
  assert.equal(statusOf(db, inv.number), 'processing', 'the fresh verdict protects the new feed');
  assert.equal(p.conflicts, 1);
});

test('R11-4: verdicts apply normally once a report is requested after the attempt (no over-blocking)', async () => {
  const db = openDb(); seedSeller(db);
  const { api, inv, head, rows } = await seedRejected(db);
  const q = listRepairs(db, seller.id).find(r => r.kind === 'rejected_invoice');
  await approveRepair(db, seller, q.event_key, { api: { ...api, uploadInvoice: async () => 'feed-NEW' }, validate: vies });
  assert.equal(statusOf(db, inv.number), 'submitted');
  // The NEXT sync's report (requested after the attempt) says processing: applies as always.
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceProcessing' }), { api, validate: vies, reportRequestedAt: new Date(), reportAttemptSeq: currentAttemptSeq(db, seller.id) });
  assert.equal(statusOf(db, inv.number), 'processing');
  assert.ok(vidrAt(db, inv.number));
});
