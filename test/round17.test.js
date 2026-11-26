// Round-17: external critic round-15 findings on 5581d9d.
// P1-A: report freshness is ordered by report_generation - one per report taken in - never by
//       attempt_seq: two consecutive reports with no upload between them share an attempt_seq,
//       and the second must still hold a stale proposal.
// P1-B: credit-note approvals are blocked while a newer report is in flight (mark stored in the
//       DB); a successful sync stores the report and lifts the block, a failed sync clears it
//       explicitly, and boot clears any mark a crash left behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, currentAttemptSeq, nextReportGen } from '../src/db.js';
import { processReport } from '../src/pipeline.js';
import { detectRepairs, listRepairs, approveRepair, recordReportSnapshot, latestReportSnapshot, markReportInFlight, clearReportInFlight, clearAllInFlightReports } from '../src/repair.js';

const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'selR17', name: 'Test S.L.', nif: 'B1', address: 'x', country: 'ES' };
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
  const [p] = listRepairs(db, seller.id);
  assert.equal(p.report_gen, g1, 'the proposal is stamped with its source report generation');
  return { p, g1 };
}

test('R15-1 (P1-A): two consecutive reports at the SAME attempt_seq - the second with DIFFERENT amounts - hold the approval', async () => {
  const db = openDb();
  const { p } = await seedProposal(db);
  const seq = currentAttemptSeq(db, seller.id);
  // A second report arrives; NO upload happened in between, so the attempt sequence is identical.
  assert.equal(currentAttemptSeq(db, seller.id), seq, 'no upload between the two reports');
  const g2 = nextReportGen(db, seller.id);
  recordReportSnapshot(db, seller.id, { gen: g2, seq, requestedAt: new Date('2026-11-26T10:00:00Z').toISOString(), text: refundReport(0.5) });
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /different refund amounts/);
  assert.equal(rectCount(db), 0, 'nothing was issued from the stale proposal');
  assert.equal(holds(db), 1, 'the hold is logged');
  assert.equal(listRepairs(db, seller.id).length, 1, 'the proposal stays in the queue');
});

test('R15-2 (P1-A): two consecutive reports at the SAME attempt_seq - the second NO LONGER listing the refund event - hold the approval', async () => {
  const db = openDb();
  const { p } = await seedProposal(db);
  const seq = currentAttemptSeq(db, seller.id);
  const g2 = nextReportGen(db, seller.id);
  recordReportSnapshot(db, seller.id, { gen: g2, seq, requestedAt: new Date('2026-11-26T10:00:00Z').toISOString(), text }); // the event is gone
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /no longer lists this refund event/);
  assert.equal(rectCount(db), 0, 'nothing was issued');
  assert.equal(holds(db), 1, 'the hold is logged');
  assert.equal(listRepairs(db, seller.id).length, 1, 'the proposal stays in the queue');
});

test('R15-3 (P1-B): an in-flight sync blocks the approval; storing the report lifts the block and matching data issues', async () => {
  const db = openDb();
  const { p, g1 } = await seedProposal(db);
  recordReportSnapshot(db, seller.id, { gen: g1, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-25T10:00:00Z').toISOString(), text: refundReport() });
  // A sync starts: a newer report is being fetched and processed right now.
  markReportInFlight(db, seller.id, new Date('2026-11-26T10:00:00Z').toISOString());
  assert.equal(latestReportSnapshot(db, seller.id).in_flight, 1, 'the in-flight mark is recorded in the DB');
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /sync is running/);
  assert.equal(rectCount(db), 0, 'nothing was issued while the newer report was in flight');
  // The sync succeeds: the report lands, the block lifts, and matching data issues.
  const g2 = nextReportGen(db, seller.id);
  recordReportSnapshot(db, seller.id, { gen: g2, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-26T10:05:00Z').toISOString(), text: refundReport() });
  assert.equal(latestReportSnapshot(db, seller.id).in_flight, 0, 'storing the report lifted the block');
  const res = await approveRepair(db, seller, p.event_key, { api, validate: vies });
  assert.ok(res.rectNumber, 'the credit note issued after the sync completed with matching data');
});

test('R15-4 (P1-B): a FAILED sync clears the in-flight mark explicitly and the approval proceeds', async () => {
  const db = openDb();
  const { p, g1 } = await seedProposal(db);
  recordReportSnapshot(db, seller.id, { gen: g1, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-25T10:00:00Z').toISOString(), text: refundReport() });
  markReportInFlight(db, seller.id, new Date('2026-11-26T10:00:00Z').toISOString());
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /sync is running/);
  assert.equal(rectCount(db), 0, 'nothing was issued while the newer report was in flight');
  // The sync failed: the mark is cleared explicitly; the approval proceeds on the last stored report.
  clearReportInFlight(db, seller.id);
  assert.equal(latestReportSnapshot(db, seller.id).in_flight, 0, 'the failure path released the block');
  const res = await approveRepair(db, seller, p.event_key, { api, validate: vies });
  assert.ok(res.rectNumber, 'the credit note issued once the failed sync released the block');
});

test('R15-5 (P1-B): a CRASHED sync leaves a stale in-flight mark; boot clearing releases it', async () => {
  const db = openDb();
  const { p, g1 } = await seedProposal(db);
  recordReportSnapshot(db, seller.id, { gen: g1, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date('2026-11-25T10:00:00Z').toISOString(), text: refundReport() });
  // The process crashed mid-sync: the mark is still set and nobody clears it until boot.
  markReportInFlight(db, seller.id, new Date('2026-11-26T10:00:00Z').toISOString());
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /sync is running/);
  // Boot: no sync can be running at startup, so every mark is stale.
  clearAllInFlightReports(db);
  assert.equal(latestReportSnapshot(db, seller.id).in_flight, 0, 'boot cleared the stale mark');
  const res = await approveRepair(db, seller, p.event_key, { api, validate: vies });
  assert.ok(res.rectNumber, 'the credit note issued after boot cleared the crashed sync mark');
});
