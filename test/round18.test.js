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
import { detectRepairs, listRepairs, approveRepair, recordReportSnapshot, latestReportSnapshot, markReportInFlight, clearReportInFlight, reconcileReportMarksAtBoot, markReportStorePending, storeDownloadedReport, takeInManualReport } from '../src/repair.js';

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
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /previous sync did not finish/, 'the approval stays blocked');
  assert.equal(rectCount(db), 0, 'nothing was issued');
  // A crash and restart must NOT release this block: the last stored snapshot is known-stale.
  reconcileReportMarksAtBoot(db);
  assert.equal(latestReportSnapshot(db, seller.id).in_flight, 1, 'boot did not release a store-pending block');
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /previous sync did not finish/, 'still blocked after boot');
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

test('R16-5 (reviewer HOLD on 43a15bb): store failure, then a PRE-DOWNLOAD failure on the next sync - approval stays blocked until a successful store', async () => {
  const db = openDb();
  const { p } = await seedProposal(db);
  // Sync N: download OK (amounts halved), store FAILED -> store_pending stays set.
  markReportInFlight(db, seller.id, new Date('2026-11-26T10:00:00Z').toISOString());
  markReportStorePending(db, seller.id);
  // Sync N+1 fails BEFORE download (Amazon down): its catch calls clearReportInFlight.
  markReportInFlight(db, seller.id, new Date('2026-11-27T10:00:00Z').toISOString());
  clearReportInFlight(db, seller.id);
  assert.equal(latestReportSnapshot(db, seller.id).in_flight, 1, 'the pre-download failure did not release the store-pending block');
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /previous sync did not finish/, 'approval still blocked');
  assert.equal(rectCount(db), 0, 'nothing issued from the known-stale snapshot');
  // Defense in depth: even with in_flight forced off, store_pending alone blocks approval.
  db.prepare('UPDATE report_snapshots SET in_flight=0 WHERE seller_id=?').run(seller.id);
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /previous sync did not finish/, 'store_pending alone blocks');
  // Next successful sync stores its report: block lifts, stale proposal is held.
  const g2 = nextReportGen(db, seller.id);
  markReportInFlight(db, seller.id, new Date('2026-11-28T10:00:00Z').toISOString());
  markReportStorePending(db, seller.id);
  storeDownloadedReport(db, seller.id, { gen: g2, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-28T10:00:00Z').toISOString(), text: refundReport(0.5) });
  clearReportInFlight(db, seller.id);
  assert.equal(latestReportSnapshot(db, seller.id).in_flight, 0, 'block lifted by the successful store');
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /different refund amounts/, 'stale proposal held');
  assert.equal(rectCount(db), 0, 'never issued');
});

test('R17-1 (critic round-17): crash BETWEEN downloadReport and markReportStorePending (in_flight=1, store_pending=0, old snapshot) - boot keeps approvals blocked', async () => {
  const db = openDb();
  const { p } = await seedProposal(db);
  // Crash state: a newer report arrived but nothing about it was recorded beyond the pre-request mark.
  db.prepare('UPDATE report_snapshots SET in_flight=1, in_flight_at=?, store_pending=0 WHERE seller_id=?').run('2026-11-26T10:00:00Z', seller.id);
  reconcileReportMarksAtBoot(db); // boot after the crash
  const s = latestReportSnapshot(db, seller.id);
  assert.equal(s.in_flight, 1, 'boot did not clear the mark');
  assert.equal(s.store_pending, 1, 'a crashed run cannot prove no newer report arrived');
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /previous sync did not finish/, 'approval blocked');
  assert.equal(rectCount(db), 0, 'zero financial documents issued');
  // A later live-process pre-download failure still cannot release it.
  markReportInFlight(db, seller.id, new Date('2026-11-27T10:00:00Z').toISOString());
  clearReportInFlight(db, seller.id);
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /previous sync did not finish/, 'still blocked');
  // A successful sync stores the newer report (amounts halved): the block lifts and the stale proposal is held.
  const g2 = nextReportGen(db, seller.id);
  markReportInFlight(db, seller.id, new Date('2026-11-28T10:00:00Z').toISOString());
  markReportStorePending(db, seller.id);
  storeDownloadedReport(db, seller.id, { gen: g2, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-28T10:00:00Z').toISOString(), text: refundReport(0.5) });
  clearReportInFlight(db, seller.id);
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /different refund amounts/, 'stale proposal held by revalidation');
  assert.equal(rectCount(db), 0, 'never issued from stale data');
});

test('R18-1 (critic round-18 P2): manual path - a STORE failure surfaces loudly and the block stays up; a successful manual store lifts it and approval proceeds', async () => {
  const db = openDb();
  const { p } = await seedProposal(db);
  db.prepare('UPDATE report_snapshots SET in_flight=1, store_pending=1 WHERE seller_id=?').run(seller.id); // crashed-run block
  const failingStore = () => { throw new Error('disk I/O error'); };
  assert.throws(() => takeInManualReport(db, seller, refundReport(), { gen: nextReportGen(db, seller.id), seq: currentAttemptSeq(db, seller.id), requestedAt: new Date().toISOString(), store: failingStore }), /disk I\/O error/, 'a store failure is NOT swallowed as "no refund rows"');
  assert.equal(latestReportSnapshot(db, seller.id).store_pending, 1, 'the block is still up');
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /previous sync did not finish/);
  assert.equal(rectCount(db), 0, 'nothing issued');
  // A successful manual store (matching data) releases the valve.
  takeInManualReport(db, seller, refundReport(), { gen: nextReportGen(db, seller.id), seq: currentAttemptSeq(db, seller.id), requestedAt: new Date().toISOString() });
  const s = latestReportSnapshot(db, seller.id);
  assert.equal(s.in_flight, 0); assert.equal(s.store_pending, 0);
  const res = await approveRepair(db, seller, p.event_key, { api, validate: vies });
  assert.ok(res.rectNumber, 'approval proceeds after the successful manual store');
});

test('R18-2 (cosmetic): the block message distinguishes a running sync from a previous sync that did not finish', async () => {
  const db = openDb();
  const { p } = await seedProposal(db);
  markReportInFlight(db, seller.id, new Date().toISOString());
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /sync is running right now/);
  markReportStorePending(db, seller.id);
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /previous sync did not finish/);
});

test('R18-3 (reviewer HOLD on 8e8471e): manual store failure with NO prior block still blocks approvals; re-upload releases', async () => {
  const db = openDb();
  const { p } = await seedProposal(db);
  assert.equal(latestReportSnapshot(db, seller.id).store_pending ?? 0, 0, 'no prior block');
  assert.equal(latestReportSnapshot(db, seller.id).in_flight ?? 0, 0);
  const failingStore = () => { throw new Error('disk I/O error'); };
  assert.throws(() => takeInManualReport(db, seller, refundReport(0.5), { gen: nextReportGen(db, seller.id), seq: currentAttemptSeq(db, seller.id), requestedAt: new Date().toISOString(), store: failingStore }), /disk I\/O error/);
  assert.equal(latestReportSnapshot(db, seller.id).store_pending, 1, 'the failed store left store_pending=1');
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /previous sync did not finish/);
  assert.equal(rectCount(db), 0, 'nothing issued from the stale snapshot');
  // Re-upload (divergent report) stores successfully: block lifts, stale proposal held by revalidation.
  takeInManualReport(db, seller, refundReport(0.5), { gen: nextReportGen(db, seller.id), seq: currentAttemptSeq(db, seller.id), requestedAt: new Date().toISOString() });
  assert.equal(latestReportSnapshot(db, seller.id).store_pending, 0);
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /do not add up against the original invoice/, 'the re-upload re-stamped the proposal from the divergent report; the exact credit cannot be computed, so nothing issues');
  assert.equal(rectCount(db), 0);
});
