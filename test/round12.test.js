// Round-12: external critic round-10 findings on 1be84e2.
// P1: vidr_processing_at was cleared on upload SUCCESS. A retry overlapping the scheduled sync
//   raced: claim -> Amazon call in flight -> sync stamps a fresh InvoiceProcessing verdict ->
//   success handler cleared the stamp and forced 'submitted', wiping the fresh verdict; the next
//   sync's FATAL/CANCELLED feed then flipped the document despite Amazon saying it is processing.
//   Fix: the stamp is cleared at the ATOMIC CLAIM (before the call) on all four upload paths, and
//   the success handler never clears it again - a verdict stamped DURING flight is fresh evidence
//   and wins ('processing', or whatever state the verdict set). Staleness semantics from round-11
//   are preserved: a verdict from a PREVIOUS cycle dies at the claim.
// P2: feed_conflict inserted a duplicate event every hourly poll. Now one event per
//   document+feed+status; repeats only bump its counter and last-seen time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, migrateAuth } from '../src/db.js';
import { processReport, pollFeeds } from '../src/pipeline.js';
import { listRepairs, approveRepair } from '../src/repair.js';

const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'selR12', name: 'Test S.L.', nif: 'B1', address: 'x', country: 'ES' };
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
const conflictEvents = (db, number) => db.prepare("SELECT detail FROM events WHERE seller_id=? AND type='feed_conflict'").all(seller.id).filter(e => String(e.detail).includes(number));
const untilSending = async (db, number) => { for (let i = 0; i < 500 && statusOf(db, number) !== 'sending'; i++) await new Promise(r => setImmediate(r)); };

// ---------- the P1 race, invoice path (his required regression test) ----------

test('R10-1 (invoice): a retry overlapping a sync must not wipe a mid-flight VIDR verdict', async () => {
  const db = openDb(); seedSeller(db);
  const uploads = [];
  const api = { uploadInvoice: async (a) => { uploads.push(a.number); return uploads.length === 1 ? 'feed-TARGET' : 'feed-ok-' + uploads.length; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT * FROM invoices WHERE seller_id=? AND kind='invoice' AND feed_id='feed-TARGET'").get(seller.id);
  const [head, ...rows] = text.trim().split('\n');
  // Amazon rejects (document level, technical reason) -> reviewed retry proposed, human approves.
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceRejected', 'invoice-status-description': 'Internal processing error' }), { api, validate: vies });
  assert.equal(statusOf(db, inv.number), 'rejected');
  const q = listRepairs(db, seller.id).find(r => r.kind === 'rejected_invoice');
  assert.ok(q, 'a reviewed retry was proposed');
  // The retry's Amazon call hangs in flight...
  let release; const gate = new Promise(r => release = r);
  const api2 = { uploadInvoice: () => gate.then(() => 'feed-RETRY'), feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  const retry = approveRepair(db, seller, q.event_key, { api: api2, validate: vies });
  await untilSending(db, inv.number);
  assert.equal(statusOf(db, inv.number), 'sending', 'the retry claimed the document');
  assert.equal(vidrAt(db, inv.number), null, 'the claim cleared the stale verdict BEFORE the call');
  // ...WHILE the call is in flight, the scheduled sync records a fresh InvoiceProcessing verdict.
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceProcessing' }), { api, validate: vies });
  assert.ok(vidrAt(db, inv.number), 'the mid-flight verdict was stamped');
  // The upload returns success: the fresh verdict must NOT be wiped.
  release(); await retry;
  assert.equal(statusOf(db, inv.number), 'processing', 'freshest information wins - no regression to submitted');
  assert.ok(vidrAt(db, inv.number), 'the mid-flight verdict survived the success handler');
  assert.equal(db.prepare('SELECT feed_id FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).feed_id, 'feed-RETRY');
  // Next sync: the feed goes FATAL. Amazon's document-level verdict still wins.
  const p = await pollFeeds(db, seller, { ...api, feedStatus: async (id) => id === 'feed-RETRY' ? { status: 'FATAL', resultDocumentId: 'rdX' } : { status: 'DONE' }, downloadFeedResult: async () => 'error\tfatal' });
  assert.equal(statusOf(db, inv.number), 'processing');
  assert.equal(p.conflicts, 1);
  assert.ok(!listRepairs(db, seller.id).some(r => r.kind === 'unknown_outcome'), 'no hold was re-opened');
  assert.equal(listRepairs(db, seller.id).filter(r => r.kind === 'rejected_invoice').length, 0, 'no new retry proposal');
  assert.equal(conflictEvents(db, inv.number).length, 1);
});

// ---------- the P1 race, credit-note path (his required regression test) ----------

test('R10-2 (credit note): a correction retry overlapping a sync must not wipe a mid-flight verdict', async () => {
  const db = openDb(); seedSeller(db);
  const s = { key: 'SHIPMENT:SH1', orderId: 'O1', shippingId: 'SH1', marketplace: 'ES', transactionId: 'SH1', billing: { name: 'Buyer SA', lines: ['Calle 1'], city: 'Madrid', postal: '28001', country: 'ES' }, buyerVat: null, buyerCompany: 'Buyer SA', shipCountry: 'ES', incl: 121, vat: 21, shipmentDate: '2026-11-20T00:00:00Z' };
  db.prepare(`INSERT INTO shipments (seller_id,key,order_id,shipping_id,buyer_vat,buyer,country,total,vat,shipment_date,due_at,status,reason,raw,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(seller.id, s.key, s.orderId, s.shippingId, null, s.buyerCompany, 'ES', 121, 21, s.shipmentDate, null, 'uploaded', null, JSON.stringify(s), new Date().toISOString());
  const doc = { number: 'A-2026-000001', type: 'invoice', series: 'A', issueDate: '2026-11-20', operationDate: '2026-11-20', orderId: 'O1', buyer: { name: 'Buyer SA', vat: null, address: ['Calle 1'] }, buyerCountry: 'ES', seller: { name: 'Test S.L.', nif: 'B1', address: 'x' }, currency: 'EUR', langs: ['es'], lines: [{ description: 'W', sku: 'S', qty: 1, unitExcl: 100, excl: 100, vat: 21, rate: 21 }], totals: { excl: 100, vat: 21, incl: 121 } };
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,json,feed_id,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(seller.id, doc.number, s.key, 'invoice', new Date().toISOString(), 121, 21, JSON.stringify(doc), 'f0', 'uploaded');
  const rect = { ...doc, number: 'R-2026-000001', type: 'rectificativa', series: 'R', rectifies: { number: 'A-2026-000001' }, totals: { excl: -100, vat: -21, incl: -121 } };
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,rectifies,issued_at,total,vat,json,feed_id,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(seller.id, rect.number, 'REFUND:TX9', 'rectificativa', 'A-2026-000001', new Date().toISOString(), -121, -21, JSON.stringify(rect), 'feed-OLD', 'rejected');
  // The reviewed retry of the rejected credit note (technical reason -> retry, as production proposes).
  const { proposeRejectedRetry } = await import('../src/repair.js');
  proposeRejectedRetry(db, seller, { eventKey: 'REFUND:TX9', kind: 'rejected_credit_note', number: rect.number, originalNumber: doc.number, shipmentKey: 'REFUND:TX9', rectNumber: rect.number, retryAction: 'retry_rect', rawReason: 'Internal processing error',
    reason: `Amazon rejected credit note ${rect.number}: Internal processing error. Amazon expects the same credit note to be uploaded again.` });
  let release; const gate = new Promise(r => release = r);
  const uploads = [];
  const api = { uploadInvoice: (a) => { uploads.push(a.number); return gate.then(() => 'feed-CN-RETRY'); }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  const retry = approveRepair(db, seller, 'REFUND:TX9', { api, validate: vies });
  await untilSending(db, rect.number);
  assert.equal(statusOf(db, rect.number), 'sending', 'the correction retry claimed the document');
  assert.equal(vidrAt(db, rect.number), null, 'the claim cleared any stale verdict BEFORE the call');
  // While the Amazon call is in flight, the sync records CreditNoteProcessing for it.
  const [head, ...rows] = text.trim().split('\n');
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'transaction-type': 'REFUND', 'transaction-id': 'TX9', 'invoice-status': 'CreditNoteProcessing' }), { api, validate: vies });
  assert.ok(vidrAt(db, rect.number), 'the mid-flight verdict was stamped');
  release(); await retry;
  assert.equal(statusOf(db, rect.number), 'processing', 'freshest information wins - no regression to submitted');
  assert.ok(vidrAt(db, rect.number), 'the mid-flight verdict survived the success handler');
  // Next sync: the retry's feed goes FATAL. The document-level verdict still wins.
  const p = await pollFeeds(db, seller, { ...api, feedStatus: async (id) => id === 'feed-CN-RETRY' ? { status: 'FATAL', resultDocumentId: 'rdC' } : { status: 'DONE' }, downloadFeedResult: async () => 'error\tfatal' });
  assert.equal(statusOf(db, rect.number), 'processing');
  assert.equal(p.conflicts, 1);
  assert.ok(!listRepairs(db, seller.id).some(r => r.kind === 'unknown_outcome'), 'no hold was re-opened');
  assert.equal(conflictEvents(db, rect.number).length, 1);
});

// ---------- staleness semantics survive: a PREVIOUS cycle's verdict still dies ----------

test('R10-3: a verdict from a previous cycle is cleared at the claim, never protects the retry feed', async () => {
  const db = openDb(); seedSeller(db);
  const api = { uploadInvoice: async () => 'feed-A', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT * FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  const [head, ...rows] = text.trim().split('\n');
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceProcessing' }), { api, validate: vies });
  assert.ok(vidrAt(db, inv.number), 'cycle 1 verdict recorded');
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceRejected', 'invoice-status-description': 'Internal processing error' }), { api, validate: vies });
  const q = listRepairs(db, seller.id).find(r => r.kind === 'rejected_invoice');
  await approveRepair(db, seller, q.event_key, { api: { ...api, uploadInvoice: async () => 'feed-B' }, validate: vies });
  assert.equal(vidrAt(db, inv.number), null, 'cleared at the claim');
  assert.equal(statusOf(db, inv.number), 'submitted', 'no mid-flight verdict -> plain submitted, as before');
  const p = await pollFeeds(db, seller, { ...api, feedStatus: async (id) => id === 'feed-B' ? { status: 'FATAL', resultDocumentId: 'rdS' } : { status: 'DONE' }, downloadFeedResult: async () => 'error\tfatal' });
  assert.equal(statusOf(db, inv.number), 'unknown', 'the new cycle gets the normal FATAL discipline');
  assert.ok(listRepairs(db, seller.id).some(r => r.kind === 'unknown_outcome'), 'the human hold exists');
  assert.equal(p.conflicts, 0, 'no false protection from the stale verdict');
});

// ---------- P2: feed_conflict dedup ----------

test('R10-4: repeated polls aggregate one feed_conflict event instead of duplicating it', async () => {
  const db = openDb(); seedSeller(db);
  const uploads = [];
  const api = { uploadInvoice: async (a) => { uploads.push(a.number); return uploads.length === 1 ? 'feed-TARGET' : 'feed-ok-' + uploads.length; }, feedStatus: async (id) => id === 'feed-TARGET' ? { status: 'FATAL', resultDocumentId: 'rdT' } : { status: 'DONE' }, downloadFeedResult: async () => 'error\tfatal', listFeeds: async () => [] };
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT * FROM invoices WHERE seller_id=? AND kind='invoice' AND feed_id='feed-TARGET'").get(seller.id);
  const [head, ...rows] = text.trim().split('\n');
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceProcessing' }), { api, validate: vies });
  await pollFeeds(db, seller, api);
  await pollFeeds(db, seller, api);
  await pollFeeds(db, seller, api);
  const evs = conflictEvents(db, inv.number);
  assert.equal(evs.length, 1, 'three polls -> ONE conflict event');
  const detail = JSON.parse(evs[0].detail);
  assert.equal(detail.repeats, 2, 'the repeats are aggregated onto the same event');
  assert.ok(detail.lastSeenAt, 'last-seen is recorded');
});
