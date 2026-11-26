// Round-18: external critic round-16 finding on 6c51951 - sync failure AFTER download.
// The two failure classes are separated: a failure BEFORE the download clears the in-flight
// block (the stored snapshot is genuinely the latest); the moment a download completes the
// report is stored IMMEDIATELY (storeDownloadedReport) while the block stays up until
// processing completes. A processing failure after the store lifts the block safely, because
// approval revalidates against the newer stored report. If the store itself fails, the
// store_pending flag keeps the block up across boots until a later sync stores a report.
// Invariant: a stale snapshot must never be usable for approval once a newer report has arrived.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, currentAttemptSeq, nextReportGen } from '../src/db.js';
import { processReport } from '../src/pipeline.js';
import { detectRepairs, listRepairs, approveRepair, recordReportSnapshot, latestReportSnapshot, markReportInFlight, clearReportInFlight, clearAllInFlightReports, markReportStorePending, storeDownloadedReport } from '../src/repair.js';

const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'selR18', name: 'Test S.L.', nif: 'B1', address: 'x', country: 'ES' };
const vies = async (v) => ({ status: 'valid', vat: v });
const api = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };

function refundReport(scale = 1) {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const row = rows[0].split('\t');
  const ref = [...row]; ref[ix('transaction-type')] = 'REFUND'; ref[ix('transaction-id')] = 'r-100-1'; ref[ix('invoice-status')] = 'CreditNotePending';
  ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { ref[ix(n)] = String(-Math.abs(Number(ref[ix(n)])) * scale); });
  return [head, ref.join('\t')].join('\n');
}
const rectCount = (db) => db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c;
const holds = (db) => db.prepare("SELECT count(*) c FROM events WHERE seller_id=? AND type='stale_proposal_held'").get(seller.id).c;

async function seedProposal(db) {
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const g1 = nextReportGen(db, seller.id);
  detectRepairs(db, seller, refundReport(), { reportAttemptSeq: currentAttemptSeq(db, seller.id), reportRequestedAt: new Date('2026-11-25T10:00:00Z'), reportGen: g1 });
  recordReportSnapshot(db, seller.id, { gen: g1, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-25T10:00:00Z').toISOString(), text: refundReport() });
  const [p] = listRepairs(db, seller.id);
  return { p, g1 };
}

test('R16-1: the download succeeds with CHANGED amounts, the next processing step fails - the old proposal can never issue', async () => {
  const db = openDb();
  const { p } = await seedProposal(db);
  // Sync: the newer report (amounts halved) downloads fine and is stored IMMEDIATELY; the block
  // stays up while processing runs - exactly the syncInner order after the round-18 fix.
  const g2 = nextReportGen(db, seller.id);
  markReportInFlight(db, seller.id, new Date('2026-11-26T10:00:00Z').toISOString());
  markReportStorePending(db, seller.id);
  storeDownloadedReport(db, seller.id, { gen: g2, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-26T10:00:00Z').toISOString(), text: refundReport(0.5) });
  assert.equal(latestReportSnapshot(db, seller.id).in_flight, 1, 'the block stays up while processing runs');
  assert.equal(latestReportSnapshot(db, seller.id).store_pending, 0, 'the store cleared the pending flag');
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /sync is running/, 'blocked while the newer report is being processed');
  // The next processing step throws. syncInner's catch lifts the block because the store
  // succeeded - and approval now revalidates against the NEWER stored report.
  clearReportInFlight(db, seller.id);
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /different refund amounts/, 'the newer stored report holds the stale proposal');
  assert.equal(rectCount(db), 0, 'no financial document was issued at any point');
  assert.equal(holds(db), 1, 'the hold is logged');
  assert.equal(listRepairs(db, seller.id).length, 1, 'the proposal stays in the queue');
});

test('R16-1b: the download succeeds with the event REMOVED, processing fails - the old proposal can never issue', async () => {
  const db = openDb();
  const { p } = await seedProposal(db);
  const g2 = nextReportGen(db, seller.id);
  markReportInFlight(db, seller.id, new Date('2026-11-26T10:00:00Z').toISOString());
  markReportStorePending(db, seller.id);
  storeDownloadedReport(db, seller.id, { gen: g2, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-26T10:00:00Z').toISOString(), text }); // the event is gone
  clearReportInFlight(db, seller.id); // processing failure after the store: the block lifts...
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /no longer lists this refund event/, '...and the newer stored report still holds the approval');
  assert.equal(rectCount(db), 0, 'nothing was issued');
});

test('R16-2: the store ITSELF fails after download - the block stays up, survives boot, and recovers on the next sync', async () => {
  const db = openDb();
  const { p } = await seedProposal(db);
  // The newer report (amounts halved) downloaded, then the store failed: store_pending stays set
  // and the block must not lift, not even at boot.
  markReportInFlight(db, seller.id, new Date('2026-11-26T10:00:00Z').toISOString());
  markReportStorePending(db, seller.id);
  // (storeDownloadedReport threw - simulated by never completing it)
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /sync is running/, 'the approval stays blocked');
  assert.equal(rectCount(db), 0, 'nothing was issued');
  // A crash and restart must NOT release this block: the last stored snapshot is known-stale.
  clearAllInFlightReports(db);
  assert.equal(latestReportSnapshot(db, seller.id).in_flight, 1, 'boot did not release a store-pending block');
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /sync is running/, 'still blocked after boot');
  // The next sync retries: the download stores successfully and processing completes.
  const g2 = nextReportGen(db, seller.id);
  markReportInFlight(db, seller.id, new Date('2026-11-27T10:00:00Z').toISOString());
  markReportStorePending(db, seller.id);
  storeDownloadedReport(db, seller.id, { gen: g2, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-27T10:00:00Z').toISOString(), text: refundReport(0.5) });
  clearReportInFlight(db, seller.id);
  assert.equal(latestReportSnapshot(db, seller.id).in_flight, 0, 'the recovered sync lifted the block');
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /different refund amounts/, 'the recovered newer report holds the stale proposal');
  assert.equal(rectCount(db), 0, 'nothing was ever issued from stale data');
});

test('R16-3: a processing failure after the store with MATCHING amounts does not over-block - the approval issues', async () => {
  const db = openDb();
  const { p } = await seedProposal(db);
  const g2 = nextReportGen(db, seller.id);
  markReportInFlight(db, seller.id, new Date('2026-11-26T10:00:00Z').toISOString());
  markReportStorePending(db, seller.id);
  storeDownloadedReport(db, seller.id, { gen: g2, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-26T10:00:00Z').toISOString(), text: refundReport() }); // same amounts
  clearReportInFlight(db, seller.id); // processing failed after the store
  const res = await approveRepair(db, seller, p.event_key, { api, validate: vies });
  assert.ok(res.rectNumber, 'the credit note issued from re-validated fresh data');
});

test('R16-4: a failure BEFORE the download clears the block - the stored snapshot is genuinely the latest', async () => {
  const db = openDb();
  const { p } = await seedProposal(db);
  // The sync starts but the download never completes (request/wait/download threw).
  markReportInFlight(db, seller.id, new Date('2026-11-26T10:00:00Z').toISOString());
  // syncInner catch: !downloaded -> clearReportInFlight
  clearReportInFlight(db, seller.id);
  const res = await approveRepair(db, seller, p.event_key, { api, validate: vies });
  assert.ok(res.rectNumber, 'the approval proceeds on the last stored report, which is genuinely the latest');
});
