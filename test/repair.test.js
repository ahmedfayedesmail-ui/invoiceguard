import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { processReport, processCorrections, pollFeeds, settleUnknownDocuments, unknownSettleCheck } from '../src/pipeline.js';
import { detectRepairs, listRepairs, decideRepair, approveRepair, recoverStuckRepairs, recoverUncertainUploads } from '../src/repair.js';

const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'selR', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const api = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }) };
const vies = async (v) => ({ status: 'valid', vat: v });

function refundReport() {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const row = rows[0].split('\t');
  const ref = [...row]; ref[ix('transaction-type')] = 'REFUND'; ref[ix('transaction-id')] = 'r-100-1'; ref[ix('invoice-status')] = 'CreditNotePending';
  ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { ref[ix(n)] = '-' + ref[ix(n)]; });
  return [head, ref.join('\t')].join('\n');
}

test('a plain return after issuance becomes a review-first proposal, idempotent, no auto-issue', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const before = db.prepare('SELECT count(*) c FROM invoices WHERE seller_id=?').get(seller.id).c;
  const rep = refundReport();
  const r = detectRepairs(db, seller, rep);
  assert.equal(r.proposed, 1); assert.equal(r.skipped.length, 0);
  const q = listRepairs(db, seller.id);
  assert.equal(q.length, 1);
  assert.equal(q[0].kind, 'return'); assert.equal(q[0].state, 'proposed');
  assert.equal(q[0].suggestion.action, 'credit_note'); assert.ok(q[0].suggestion.total > 0);
  assert.match(q[0].reason, /Return or refund/);
  // nothing was issued: invoice count unchanged (proposal only, review-first)
  assert.equal(db.prepare('SELECT count(*) c FROM invoices WHERE seller_id=?').get(seller.id).c, before);
  // idempotent
  const again = detectRepairs(db, seller, rep);
  assert.equal(again.proposed, 0); assert.equal(listRepairs(db, seller.id).length, 1);
});

test('decisions move a proposal out of the queue, and only once', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  detectRepairs(db, seller, refundReport());
  const [p] = listRepairs(db, seller.id);
  decideRepair(db, seller.id, p.event_key, 'approved');
  assert.equal(listRepairs(db, seller.id).length, 0);
  assert.equal(listRepairs(db, seller.id, 'approved').length, 1);
  assert.throws(() => decideRepair(db, seller.id, p.event_key, 'approved'), /No proposed repair/);
  assert.throws(() => decideRepair(db, seller.id, 'nope', 'dismissed'), /No proposed repair/);
});

test('approving a return issues the chained credit note with the refund TransactionId and closes the repair', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  detectRepairs(db, seller, refundReport());
  const [p] = listRepairs(db, seller.id);
  const before = db.prepare('SELECT count(*) c FROM invoices WHERE seller_id=?').get(seller.id).c;
  const res = await approveRepair(db, seller, p.event_key, { api, validate: vies });
  assert.equal(res.original, p.original_number); assert.ok(res.rectNumber);
  const cn = db.prepare('SELECT * FROM invoices WHERE seller_id=? AND number=?').get(seller.id, res.rectNumber);
  assert.equal(cn.kind, 'rectificativa'); assert.equal(cn.rectifies, p.original_number);
  const cj = JSON.parse(cn.json); assert.ok(cj.totals.incl < 0, 'credit note is negative');
  assert.equal(db.prepare('SELECT count(*) c FROM invoices WHERE seller_id=?').get(seller.id).c, before + 1);
  assert.equal(listRepairs(db, seller.id).length, 0);
  assert.equal(listRepairs(db, seller.id, 'issued')[0].rect_number, res.rectNumber);
  // no double issue
  await assert.rejects(() => approveRepair(db, seller, p.event_key, { api, validate: vies }), /No open repair/);
});

/** One of the two SKU-A units comes back; shipping is not refunded. */
function partialRefundReport(sku = 'SKU-A') {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const ref = [...rows[0].split('\t')]; ref[ix('transaction-type')] = 'REFUND'; ref[ix('transaction-id')] = 'r-100-1'; ref[ix('invoice-status')] = 'CreditNotePending';
  ref[ix('item-vat-incl-amount')] = '-24.20'; ref[ix('item-vat-amount')] = '-4.20'; ref[ix('item-vat-excl-amount')] = '-20.00'; ref[ix('sku')] = sku;
  ['shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { ref[ix(n)] = '0'; });
  return [head, ref.join('\t')].join('\n');
}

test('a PARTIAL return credits only the returned amount, never the whole invoice', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const origBefore = db.prepare("SELECT json FROM invoices WHERE seller_id=? AND kind='invoice'").get(seller.id).json;
  const r = detectRepairs(db, seller, partialRefundReport());
  assert.equal(r.proposed, 1);
  const [p] = listRepairs(db, seller.id);
  assert.equal(p.suggestion.full, false); assert.equal(p.suggestion.total, 24.2); assert.equal(p.suggestion.vat, 4.2);
  const res = await approveRepair(db, seller, p.event_key, { api, validate: vies });
  const cn = JSON.parse(db.prepare('SELECT json FROM invoices WHERE seller_id=? AND number=?').get(seller.id, res.rectNumber).json);
  assert.equal(cn.totals.excl, -20); assert.equal(cn.totals.vat, -4.2); assert.equal(cn.totals.incl, -24.2, 'the credit note covers the returned unit only');
  assert.equal(cn.lines.length, 1, 'only the returned line appears as a delta');
  assert.equal(db.prepare("SELECT json FROM invoices WHERE seller_id=? AND kind='invoice'").get(seller.id).json, origBefore, 'the original invoice is untouched');
});

test('a refund we cannot match to the original lines issues nothing and says so', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  detectRepairs(db, seller, partialRefundReport('SKU-NOT-ON-INVOICE'));
  const [p] = listRepairs(db, seller.id);
  const before = db.prepare('SELECT count(*) c FROM invoices WHERE seller_id=?').get(seller.id).c;
  await assert.rejects(() => approveRepair(db, seller, p.event_key, { api, validate: vies }), /cannot be matched/);
  assert.equal(db.prepare('SELECT count(*) c FROM invoices WHERE seller_id=?').get(seller.id).c, before, 'nothing issued');
  assert.equal(listRepairs(db, seller.id).length, 1, 'the proposal stays open for review');
});

test('a FULL return still cancels the whole invoice', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  detectRepairs(db, seller, refundReport());
  const [p] = listRepairs(db, seller.id);
  assert.equal(p.suggestion.full, true);
  const res = await approveRepair(db, seller, p.event_key, { api, validate: vies });
  const cn = JSON.parse(db.prepare('SELECT json FROM invoices WHERE seller_id=? AND number=?').get(seller.id, res.rectNumber).json);
  assert.equal(cn.totals.incl, -54.45, 'full cancellation');
});

test('a refund for an invoice we did not issue is skipped, not proposed', () => {
  const db = openDb();
  const r = detectRepairs(db, seller, refundReport());
  assert.equal(r.proposed, 0);
  assert.equal(r.skipped.length, 1); assert.match(r.skipped[0].reason, /not issued by us/);
});

/** A RETURN-type row (item physically returned) - Amazon's third transaction type. */
function returnTypeReport() {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const ref = [...rows[0].split('\t')]; ref[ix('transaction-type')] = 'RETURN'; ref[ix('transaction-id')] = 'ret-200-1'; ref[ix('invoice-status')] = 'CreditNotePending';
  ref[ix('invoice-status')] = 'CreditNotePending';
  ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { ref[ix(n)] = '-' + ref[ix(n)]; });
  return [head, ref.join('\t')].join('\n');
}

test('a RETURN transaction (not only REFUND) becomes a repair proposal', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const r = detectRepairs(db, seller, returnTypeReport());
  assert.equal(r.proposed, 1, 'RETURN rows must not be missed');
  const [p] = listRepairs(db, seller.id);
  assert.equal(p.suggestion.action, 'credit_note');
});

function partialOf(txId, excl, vat, incl, sku = 'SKU-A') {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const ref = [...rows[0].split('\t')]; ref[ix('transaction-type')] = 'REFUND'; ref[ix('transaction-id')] = txId; ref[ix('sku')] = sku; ref[ix('invoice-status')] = 'CreditNotePending';
  ref[ix('item-vat-incl-amount')] = String(-incl); ref[ix('item-vat-amount')] = String(-vat); ref[ix('item-vat-excl-amount')] = String(-excl);
  ['shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { ref[ix(n)] = '0'; });
  return [head, ref.join('\t')].join('\n');
}

test('two partial refunds that together exceed the line: the second is stopped, nothing issued', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  // fixture SKU-A line: 2 units at 24.20 incl each = 48.40 line; first refund 36.30 (1.5 units worth)
  detectRepairs(db, seller, partialOf('r-1', 30, 6.3, 36.3));
  const [p1] = listRepairs(db, seller.id);
  await approveRepair(db, seller, p1.event_key, { api, validate: vies });
  // second refund of another 36.30: cumulative 72.60 > what remains of the line
  detectRepairs(db, seller, partialOf('r-2', 30, 6.3, 36.3));
  const [p2] = listRepairs(db, seller.id);
  const before = db.prepare('SELECT count(*) c FROM invoices WHERE seller_id=?').get(seller.id).c;
  await assert.rejects(() => approveRepair(db, seller, p2.event_key, { api, validate: vies }), /more than/);
  assert.equal(db.prepare('SELECT count(*) c FROM invoices WHERE seller_id=?').get(seller.id).c, before, 'no second credit note');
});

test('two partial refunds inside the invoice total both issue, each for its own amount', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  detectRepairs(db, seller, partialOf('r-1', 10, 2.1, 12.1));
  const [p1] = listRepairs(db, seller.id);
  const a = await approveRepair(db, seller, p1.event_key, { api, validate: vies });
  detectRepairs(db, seller, partialOf('r-2', 10, 2.1, 12.1));
  const [p2] = listRepairs(db, seller.id);
  const b = await approveRepair(db, seller, p2.event_key, { api, validate: vies });
  assert.notEqual(a.rectNumber, b.rectNumber);
  const cnB = JSON.parse(db.prepare('SELECT json FROM invoices WHERE seller_id=? AND number=?').get(seller.id, b.rectNumber).json);
  assert.equal(cnB.totals.incl, -12.1, 'each credit note covers its own refund only');
});

test('a failed upload leaves one pending correction; re-approving retries the SAME document, never a second number', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  detectRepairs(db, seller, refundReport());
  const [p] = listRepairs(db, seller.id);
  const failing = { uploadInvoice: async () => { throw new Error('network down'); }, feedStatus: async () => ({ status: 'DONE' }) };
  await assert.rejects(() => approveRepair(db, seller, p.event_key, { api: failing, validate: vies }), /network down/);
  const pend = db.prepare("SELECT * FROM invoices WHERE seller_id=? AND kind='rectificativa'").all(seller.id);
  assert.equal(pend.length, 1); assert.equal(pend[0].upload_status, 'pending');
  // re-approve with a working API: same number, no new document
  const res = await approveRepair(db, seller, p.event_key, { api, validate: vies });
  assert.equal(res.rectNumber, pend[0].number, 'the pending correction is retried, not re-issued');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 1);
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, pend[0].number).upload_status, 'submitted');
  // and a third approval finds nothing open
  await assert.rejects(() => approveRepair(db, seller, p.event_key, { api, validate: vies }), /No open repair/);
});

test('processCorrections retries a pending correction upload instead of skipping it forever', async () => {
  const db = openDb();
  const calls2 = [];
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const rep = correctionReport();
  const flaky = { uploadInvoice: async (a) => { calls2.push(a); if (calls2.length === 1) throw new Error('upload boom'); return 'fx' + calls2.length; }, feedStatus: async () => ({ status: 'DONE' }) };
  const r1 = await processCorrections(db, seller, rep, { api: flaky, validate: vies });
  assert.equal(r1.errors.length, 1); assert.equal(r1.creditNotes, 0);
  const nums1 = db.prepare("SELECT number, upload_status FROM invoices WHERE seller_id=? AND kind='rectificativa' ORDER BY number").all(seller.id);
  assert.equal(nums1.length, 1); assert.equal(nums1[0].upload_status, 'pending');
  const r2 = await processCorrections(db, seller, rep, { api: flaky, validate: vies });
  assert.equal(r2.errors.length, 0, JSON.stringify(r2.errors));
  const nums2 = db.prepare("SELECT number, upload_status FROM invoices WHERE seller_id=? AND kind='rectificativa' ORDER BY number").all(seller.id);
  assert.equal(nums2.filter(x => x.number === nums1[0].number).length, 1, 'same correction document retried');
  assert.equal(nums2.find(x => x.number === nums1[0].number).upload_status, 'submitted');
});

test('an off-by-one-cent refund is stopped, not issued (true per-cent matching)', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  detectRepairs(db, seller, partialOf('r-cent', 20, 4.19, 24.20)); // vat off by a cent vs incl-excl
  const [p] = listRepairs(db, seller.id);
  const before = db.prepare('SELECT count(*) c FROM invoices WHERE seller_id=?').get(seller.id).c;
  await assert.rejects(() => approveRepair(db, seller, p.event_key, { api, validate: vies }), /to the cent/);
  assert.equal(db.prepare('SELECT count(*) c FROM invoices WHERE seller_id=?').get(seller.id).c, before);
});

function correctionReport() {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const row = rows[0].split('\t');
  const rev = [...row]; rev[ix('transaction-type')] = 'REFUND'; rev[ix('transaction-id')] = 'CorrectionReversal:X:1';
  ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { rev[ix(n)] = '-' + rev[ix(n)]; });
  rev[ix('invoice-status')] = 'CreditNotePending';
  return [head, rev.join('\t')].join('\n');
}

/** The demo mock: with two uploaded shipments the second comes back as a RETURN, so the
    /sample and demo flows dogfood the RETURN path too (Amazon's transaction-type vocabulary). */
test('mock amazon returns the second uploaded shipment as a RETURN row with halved amounts', async () => {
  const { MockApi } = await import('../src/mockamazon.js');
  const mock = new MockApi(['S1001', 'S1002']);
  const [head, ...rows] = (await mock.downloadReport()).trim().split('\n');
  const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const rt = rows.map(r => r.split('\t')).find(r => r[ix('transaction-id')] === 'RT-DEMO-1');
  assert.ok(rt, 'mock must emit the RT-DEMO-1 return once two shipments are uploaded');
  assert.equal(rt[ix('transaction-type')], 'RETURN');
  assert.equal(rt[ix('shipping-id')], 'S1002');
  const orig = rows.map(r => r.split('\t')).find(r => r[ix('shipping-id')] === 'S1002' && r[ix('transaction-type')] === 'SHIPMENT');
  for (const n of ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount']) {
    const exp = -Math.round(parseFloat(orig[ix(n)]) / 2 * 100) / 100;
    assert.equal(parseFloat(rt[ix(n)]).toFixed(2), exp.toFixed(2), n + ' halved and negative');
  }
  for (const n of ['shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount']) assert.equal(rt[ix(n)], '0', n + ' zeroed on the partial return');
  assert.equal(rt[ix('invoice-status')], 'CreditNotePending');
  await mock.uploadInvoice({ documentType: 'CreditNote', transactionId: 'RT-DEMO-1' });
  const again = (await mock.downloadReport()).trim().split('\n').map(r => r.split('\t'));
  assert.equal(again.find(r => r[ix('transaction-id')] === 'RT-DEMO-1')[ix('invoice-status')], 'CreditNoteUploaded', 'uploaded credit note reconciles');
});

test('two concurrent approvals of the same repair issue exactly one document', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  detectRepairs(db, seller, refundReport());
  const [p] = listRepairs(db, seller.id);
  const results = await Promise.allSettled([
    approveRepair(db, seller, p.event_key, { api, validate: vies }),
    approveRepair(db, seller, p.event_key, { api, validate: vies }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, 'exactly one approval went through');
  const bad = results.find(r => r.status === 'rejected');
  assert.match(String(bad.reason), /No open repair|already being issued|already exists/);
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 1, 'exactly one credit note exists');
});

test('a full refund with a one-cent tax mismatch is held, never zeroed blindly', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const [head, ...rows] = refundReport().trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const ref = rows[0].split('\t');
  ref[ix('item-vat-amount')] = (parseFloat(ref[ix('item-vat-amount')]) - 0.01).toFixed(2); // one cent of tax more than the invoice
  const d = detectRepairs(db, seller, [head, ref.join('\t')].join('\n'));
  assert.equal(d.proposed, 1);
  const [p] = listRepairs(db, seller.id);
  assert.equal(p.suggestion.full, false, 'a gross match with a tax mismatch is not a plain full cancellation');
  const before = db.prepare('SELECT count(*) c FROM invoices WHERE seller_id=?').get(seller.id).c;
  await assert.rejects(approveRepair(db, seller, p.event_key, { api, validate: vies }), /add up to more than the invoice|larger than that line|do not add up|does not match/);
  assert.equal(db.prepare('SELECT count(*) c FROM invoices WHERE seller_id=?').get(seller.id).c, before, 'nothing was issued');
  assert.equal(listRepairs(db, seller.id).length, 1, 'the proposal went back to the review queue');
});

test('a refund Amazon already covers is not proposed (only CreditNotePending needs a credit note)', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  for (const st of ['CreditNoteUploaded', 'CreditNoteCreatedByAmazon', 'CreditNoteProcessing', 'CreditNoteRejected']) {
    const [head, ...rows] = refundReport().trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
    const ref = rows[0].split('\t'); ref[ix('invoice-status')] = st; ref[ix('transaction-id')] = 'r-st-' + st;
    const d = detectRepairs(db, seller, [head, ref.join('\t')].join('\n'));
    assert.equal(d.proposed, 0, st + ' must not propose a credit note');
    assert.equal(d.skipped.length, 1);
  }
  assert.equal(listRepairs(db, seller.id).length, 0);
});

test('a rejected invoice gets a reviewed retry that re-uploads the SAME document', async () => {
  const db = openDb();
  const calls = [];
  const api2 = { uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) };
  await processReport(db, seller, text, { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  const invCount = db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='invoice'").get(seller.id).c;
  await processReport(db, seller, singleRow('InvoiceRejected', 'Internal processing error'), { api: api2, validate: vies });
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'rejected');
  const q = listRepairs(db, seller.id);
  assert.equal(q.length, 1); assert.equal(q[0].kind, 'rejected_invoice'); assert.equal(q[0].suggestion.action, 'retry_upload');
  const upBefore = calls.length;
  const res = await approveRepair(db, seller, q[0].event_key, { api: api2, validate: vies });
  assert.equal(res.retried, inv.number);
  assert.equal(calls.length, upBefore + 1, 'one new upload happened');
  assert.equal(calls[calls.length - 1].number, inv.number, 'the SAME invoice number was uploaded');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'submitted');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='invoice'").get(seller.id).c, invCount, 'no second invoice number was burned');
});

test('a rejected credit note retries the SAME document through the repair queue', async () => {
  const db = openDb();
  const api2 = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }) };
  await processReport(db, seller, text, { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  detectRepairs(db, seller, refundReport());
  const [p] = listRepairs(db, seller.id);
  await approveRepair(db, seller, p.event_key, { api: api2, validate: vies });
  const rect = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id);
  const [head, ...rows] = refundReport().trim().split('\n');
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), 'CreditNoteRejected', 'Internal processing error'), { api: api2, validate: vies });
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, rect.number).upload_status, 'rejected');
  const reopened = db.prepare('SELECT state, suggestion FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, p.event_key);
  assert.equal(reopened.state, 'proposed', 'a rejection re-opens the review instead of leaving dead history');
  assert.equal(JSON.parse(reopened.suggestion).action, 'retry_rect');
  const res = await approveRepair(db, seller, p.event_key, { api: api2, validate: vies });
  assert.equal(res.rectNumber, rect.number, 'the SAME credit note number was retried');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, rect.number).upload_status, 'submitted');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 1, 'no second credit note exists');
});

function correctionPair() {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const row = rows[0].split('\t');
  const rev = [...row]; rev[ix('transaction-type')] = 'REFUND'; rev[ix('transaction-id')] = 'CorrectionReversal:X:1';
  ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { rev[ix(n)] = '-' + rev[ix(n)]; });
  rev[ix('invoice-status')] = 'CreditNotePending';
  const fixed = [...row]; fixed[ix('transaction-id')] = 'Correction::X:2'; fixed[ix('billing-name')] = 'Mediterranea Logistica Norte S.L.'; fixed[ix('is-invoice-corrected')] = undefined;
  return [head, rev.join('\t'), fixed.join('\t')].join('\n');
}

// The fixture predates the invoice-status-description column, so verdict tests append it.
const withDesc = (head, row, status, desc) => {
  const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const r = [...row];
  while (r.length < c.length) r.push(''); // a trim() round-trip can eat trailing empty fields
  if (status) r[ix('invoice-status')] = status;
  r.push(desc ?? '');
  return [head + '\tinvoice-status-description', r.join('\t')].join('\n');
};
const singleRow = (status, desc) => {
  const [head, ...rows] = text.trim().split('\n');
  return withDesc(head, rows[0].split('\t'), status, desc);
};

test('repeat rejections re-open the retry review, and Amazon acceptance closes the repair for good', async () => {
  const db = openDb();
  const calls = [];
  const api2 = { uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) };
  await processReport(db, seller, singleRow(null), { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  await processReport(db, seller, singleRow('InvoiceRejected', 'Internal processing error'), { api: api2, validate: vies });
  let [q] = listRepairs(db, seller.id);
  assert.equal(q.suggestion.action, 'retry_upload');
  await approveRepair(db, seller, q.event_key, { api: api2, validate: vies });
  // Amazon rejects the SAME document again: a fresh review must appear (the old fixed key swallowed it)
  await processReport(db, seller, singleRow('InvoiceRejected', 'Internal processing error'), { api: api2, validate: vies });
  const q2 = listRepairs(db, seller.id);
  assert.equal(q2.length, 1, 'the repeated rejection produced a fresh proposal');
  assert.equal(q2[0].state, 'proposed');
  await approveRepair(db, seller, q2[0].event_key, { api: api2, validate: vies });
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='invoice'").get(seller.id).c, 1, 'still one invoice number, never a second');
  // Amazon's acceptance then closes the repair for good
  await processReport(db, seller, singleRow('InvoiceUploaded'), { api: api2, validate: vies });
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'uploaded');
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, q2[0].event_key).state, 'uploaded');
});

test('a rejected Amazon billing-correction credit note gets a reviewed retry of the SAME document', async () => {
  const db = openDb();
  const calls = [];
  const api2 = { uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) };
  await processReport(db, seller, text, { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const corr = correctionPair();
  const r = await processCorrections(db, seller, corr, { api: api2, validate: vies });
  assert.deepEqual([r.creditNotes, r.invoices, r.errors.length], [1, 0, 0], 'the replacement waits until Amazon confirms the credit note');
  const cn = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='rectificativa' AND shipment_key='REFUND:CorrectionReversal:X:1'").get(seller.id);
  assert.ok(cn, 'the correction credit note exists');
  const [head, ...rows] = corr.trim().split('\n');
  // Amazon confirms the credit note -> the pair completes on the next pass
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), 'CreditNoteUploaded'), { api: api2, validate: vies });
  const r2 = await processCorrections(db, seller, corr, { api: api2, validate: vies });
  assert.equal(r2.invoices, 1, 'the replacement went out after acceptance');
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), 'CreditNoteRejected', 'Internal processing error'), { api: api2, validate: vies });
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, cn.number).upload_status, 'rejected');
  const q = listRepairs(db, seller.id).find(x => x.kind === 'rejected_credit_note');
  assert.ok(q, 'a reviewed retry was proposed for the correction credit note');
  assert.equal(q.suggestion.action, 'retry_rect');
  const res = await approveRepair(db, seller, q.event_key, { api: api2, validate: vies });
  assert.equal(res.rectNumber, cn.number, 'the SAME credit note number was retried');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 2, 'no second document beyond credit note + replacement invoice');
});

test('a rejected correction replacement invoice retries the SAME document, and the verdict never lands on the original', async () => {
  const db = openDb();
  const calls = [];
  const api2 = { uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) };
  await processReport(db, seller, text, { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const corr = correctionPair();
  await processCorrections(db, seller, corr, { api: api2, validate: vies });
  const [h0, ...cRows] = corr.trim().split('\n');
  await processReport(db, seller, withDesc(h0, cRows[0].split('\t'), 'CreditNoteUploaded'), { api: api2, validate: vies });
  await processCorrections(db, seller, corr, { api: api2, validate: vies });
  const repl = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='rectificativa' AND shipment_key='SHIPMENT:Correction::X:2'").get(seller.id);
  const orig = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  assert.ok(repl, 'the replacement document exists');
  const [head, ...rows] = corr.trim().split('\n');
  await processReport(db, seller, withDesc(head, rows[1].split('\t'), 'InvoiceRejected', 'Internal processing error'), { api: api2, validate: vies });
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, repl.number).upload_status, 'rejected');
  assert.notEqual(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, orig.number).upload_status, 'rejected', 'the original invoice is untouched');
  const q = listRepairs(db, seller.id).find(x => x.kind === 'rejected_correction_invoice');
  assert.ok(q, 'a reviewed retry was proposed for the replacement document');
  assert.equal(q.suggestion.action, 'retry_rect');
  const res = await approveRepair(db, seller, q.event_key, { api: api2, validate: vies });
  assert.equal(res.rectNumber, repl.number, 'the SAME replacement document was retried');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 2, 'no second replacement was minted');
});

test('boot recovery reads the document state instead of blindly resetting stuck repairs', async () => {
  const db = openDb();
  const api2 = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }) };
  await processReport(db, seller, singleRow(null), { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  await processReport(db, seller, singleRow('InvoiceRejected', 'Internal processing error'), { api: api2, validate: vies });
  const [p] = listRepairs(db, seller.id);
  // crash mid-approval, document never retried: the review safely comes back
  db.prepare("UPDATE repairs SET state='issuing' WHERE seller_id=? AND event_key=?").run(seller.id, p.event_key);
  assert.equal(recoverStuckRepairs(db), 1);
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, p.event_key).state, 'proposed');
  // crash AFTER the document went out: reverting to proposed would wedge it against the idempotency guard
  db.prepare("UPDATE repairs SET state='issuing' WHERE seller_id=? AND event_key=?").run(seller.id, p.event_key);
  db.prepare("UPDATE invoices SET upload_status='submitted' WHERE seller_id=? AND number=?").run(seller.id, inv.number);
  assert.equal(recoverStuckRepairs(db), 1);
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, p.event_key).state, 'issued');
  // a credit-note repair with no document at all also comes back to the queue
  detectRepairs(db, seller, refundReport());
  const cn = listRepairs(db, seller.id).find(r => r.kind === 'return');
  db.prepare("UPDATE repairs SET state='issuing' WHERE seller_id=? AND event_key=?").run(seller.id, cn.event_key);
  recoverStuckRepairs(db);
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, cn.event_key).state, 'proposed');
});

test('an interrupted upload is never blindly resent: unknown state, a hold for a human, and the fresh report settles it', async () => {
  const db = openDb();
  let calls = 0, fail = true;
  const api3 = { uploadInvoice: async () => { calls++; if (fail) { const e = new Error('socket hang up'); e.unknownOutcome = true; throw e; } return 'f9'; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  const out = await processReport(db, seller, singleRow(null), { api: api3, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  assert.equal(out.errors.length, 1);
  const inv = db.prepare("SELECT number, upload_status FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  assert.equal(inv.upload_status, 'unknown');
  const hold = listRepairs(db, seller.id).find(r => r.kind === 'unknown_outcome');
  assert.ok(hold, 'a human-visible hold exists');
  assert.equal(hold.suggestion.action, 'hold');
  await assert.rejects(() => approveRepair(db, seller, hold.event_key, { api: api3, validate: vies }), /Nothing was re-uploaded/);
  // the next sync sees a FRESH report still listing the shipment as pending, and the feed-list
  // cross-check finds no orphan feed from the interruption window - so the resend is cleared
  fail = false;
  await processReport(db, seller, singleRow(null), { api: api3, validate: vies });
  assert.equal(calls, 2, 'exactly one resend happened');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'submitted');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='invoice'").get(seller.id).c, 1, 'no second invoice was burned');
  // Amazon's verdict then closes the hold
  await processReport(db, seller, singleRow('InvoiceUploaded'), { api: api3, validate: vies });
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'uploaded');
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, hold.event_key).state, 'uploaded');
});

test('a content rejection is held for a real fix, never blindly re-uploaded', async () => {
  const db = openDb();
  const calls = [];
  const api2 = { uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) };
  await processReport(db, seller, singleRow(null), { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  await processReport(db, seller, singleRow('InvoiceRejected', 'TotalAmount does not match'), { api: api2, validate: vies });
  const [q] = listRepairs(db, seller.id);
  assert.equal(q.suggestion.action, 'hold', 'content rejections are held, not retried');
  const upBefore = calls.length;
  await assert.rejects(() => approveRepair(db, seller, q.event_key, { api: api2, validate: vies }), /Nothing was re-uploaded/);
  assert.equal(calls.length, upBefore, 'no re-upload happened');
});

// ---------- round-5: every path audited, interruption windows simulated ----------

test('a retry upload interrupted mid-flight goes to unknown with a hold and refuses re-approval until the fresh report settles it', async () => {
  const db = openDb();
  let calls = 0, fail = false;
  const api2 = { uploadInvoice: async () => { calls++; if (fail) { const e = new Error('socket hang up'); e.unknownOutcome = true; throw e; } return 'f' + calls; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, singleRow(null), { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  await processReport(db, seller, singleRow('InvoiceRejected', 'Internal processing error'), { api: api2, validate: vies });
  const [q] = listRepairs(db, seller.id);
  fail = true;
  await assert.rejects(() => approveRepair(db, seller, q.event_key, { api: api2, validate: vies }), /socket hang up/);
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'unknown');
  const hold = listRepairs(db, seller.id).find(r => r.kind === 'unknown_outcome');
  assert.ok(hold, 'the interrupted retry produced a visible hold');
  // the interrupted retry repair is HELD, not re-proposed: no doomed duplicate action next to the hold
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, q.event_key).state, 'held');
  assert.equal(listRepairs(db, seller.id).filter(r => r.event_key === q.event_key).length, 0, 'the held repair left the review queue');
  await assert.rejects(() => approveRepair(db, seller, q.event_key, { api: api2, validate: vies }), /No open repair/);
  assert.equal(calls, 2, 'no blind second resend happened');
  // the fresh report still lists the shipment pending and the feed list shows no orphan -> cleared resend
  fail = false;
  await processReport(db, seller, singleRow(null), { api: api2, validate: vies });
  assert.equal(calls, 3, 'exactly one settling resend');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'submitted');
  await processReport(db, seller, singleRow('InvoiceUploaded'), { api: api2, validate: vies });
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, hold.event_key).state, 'uploaded');
});

test('content rejections of credit notes and replacement invoices are HELD, and an empty reason holds too', async () => {
  const db = openDb();
  const api2 = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }) };
  await processReport(db, seller, text, { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const corr = correctionPair();
  await processCorrections(db, seller, corr, { api: api2, validate: vies });
  const [head, ...rows] = corr.trim().split('\n');
  // the replacement exists only after Amazon confirms the credit note
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), 'CreditNoteUploaded'), { api: api2, validate: vies });
  await processCorrections(db, seller, corr, { api: api2, validate: vies });
  // content rejection of the correction credit note
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), 'CreditNoteRejected', 'TotalAmount does not match'), { api: api2, validate: vies });
  const cnHold = listRepairs(db, seller.id).find(r => r.kind === 'rejected_credit_note');
  assert.ok(cnHold, 'credit note rejection proposed');
  assert.equal(cnHold.suggestion.action, 'hold', 'a content rejection of a credit note is held, not retried');
  // content rejection of the replacement invoice
  await processReport(db, seller, withDesc(head, rows[1].split('\t'), 'InvoiceRejected', 'TotalVATAmount mismatch'), { api: api2, validate: vies });
  const replHold = listRepairs(db, seller.id).find(r => r.kind === 'rejected_correction_invoice');
  assert.ok(replHold, 'replacement rejection proposed');
  assert.equal(replHold.suggestion.action, 'hold', 'a content rejection of a replacement invoice is held, not retried');
  // an empty rejection reason on a plain invoice holds too (unknown class never retries)
  await processReport(db, seller, singleRow('InvoiceRejected'), { api: api2, validate: vies });
  const emptyHold = listRepairs(db, seller.id).find(r => r.kind === 'rejected_invoice');
  assert.ok(emptyHold, 'plain invoice rejection proposed');
  assert.equal(emptyHold.suggestion.action, 'hold', 'an empty/unclear reason holds instead of guessing');
});

test('boot recovery never closes a repair on an unknown or rejected document', async () => {
  const db = openDb();
  let fail = true;
  const api2 = { uploadInvoice: async () => { if (fail) { const e = new Error('timeout'); e.unknownOutcome = true; throw e; } return 'f1'; }, feedStatus: async () => ({ status: 'DONE' }) };
  await processReport(db, seller, singleRow(null), { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const hold = listRepairs(db, seller.id).find(r => r.kind === 'unknown_outcome');
  assert.ok(hold, 'the unknown outcome created a hold');
  // crash mid-approval of that hold: it must come BACK to review, not vanish as issued
  db.prepare("UPDATE repairs SET state='issuing' WHERE seller_id=? AND event_key=?").run(seller.id, hold.event_key);
  recoverStuckRepairs(db);
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, hold.event_key).state, 'proposed', 'a hold on an unknown document stays in review');
  // a credit-note repair whose document was REJECTED before the crash also comes back
  fail = false;
  await processReport(db, seller, singleRow('InvoiceUploaded'), { api: api2, validate: vies });
  detectRepairs(db, seller, refundReport());
  const [p] = listRepairs(db, seller.id).filter(r => r.kind === 'return');
  await approveRepair(db, seller, p.event_key, { api: api2, validate: vies });
  const [head, ...rows] = refundReport().trim().split('\n');
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), 'CreditNoteRejected', 'Internal processing error'), { api: api2, validate: vies });
  db.prepare("UPDATE repairs SET state='issuing' WHERE seller_id=? AND event_key=?").run(seller.id, p.event_key);
  recoverStuckRepairs(db);
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, p.event_key).state, 'proposed', 'a rejected document keeps its retry decision in review');
});

test('the crash window between Amazon acceptance and the local write is recovered as unknown, never blindly resent', async () => {
  const db = openDb();
  let docNumber = null;
  const api2 = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE', resultDocumentId: 'rd1' }), downloadFeedResult: async () => `record\tdoc\tstatus\n1\t${docNumber}\terror: processing failed`, listFeeds: async () => [] };
  await processReport(db, seller, singleRow(null), { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT number, shipment_key FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  docNumber = inv.number;
  // simulate the crash: Amazon accepted, the process died before the feed id was saved
  db.prepare("UPDATE invoices SET upload_status='sending' WHERE seller_id=? AND number=?").run(seller.id, inv.number);
  db.prepare("UPDATE shipments SET status='sending' WHERE seller_id=? AND key=?").run(seller.id, inv.shipment_key);
  assert.equal(recoverUncertainUploads(db), 1);
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'unknown');
  const hold = listRepairs(db, seller.id).find(r => r.kind === 'unknown_outcome');
  assert.ok(hold, 'a human-visible hold exists for the crashed upload');
  await assert.rejects(() => approveRepair(db, seller, hold.event_key, { api: api2, validate: vies }), /Nothing was re-uploaded/);
  // fresh report still lists the shipment as due -> the settle path resends the same document once
  // the blocking feed's processing report proves the document failed (round-10 contract: "still
  // due" alone never lifts the block, the report names the document with a failure verdict).
  await processReport(db, seller, singleRow(null), { api: api2, validate: vies });
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'submitted');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='invoice'").get(seller.id).c, 1, 'no second invoice was burned');
  await processReport(db, seller, singleRow('InvoiceUploaded'), { api: api2, validate: vies });
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, hold.event_key).state, 'uploaded');
});

test('an unknown-outcome credit note refuses re-approval and is settled by the fresh report (return flow)', async () => {
  const db = openDb();
  let fail = false, calls = 0;
  const api2 = { uploadInvoice: async () => { calls++; if (fail) { const e = new Error('connection reset'); e.unknownOutcome = true; throw e; } return 'f' + calls; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, text, { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  detectRepairs(db, seller, refundReport());
  const [p] = listRepairs(db, seller.id);
  fail = true;
  await assert.rejects(() => approveRepair(db, seller, p.event_key, { api: api2, validate: vies }), /connection reset/);
  const rect = db.prepare("SELECT number, upload_status FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id);
  assert.equal(rect.upload_status, 'unknown');
  assert.ok(listRepairs(db, seller.id).some(r => r.kind === 'unknown_outcome'), 'a visible hold was created for the correction document');
  // the interrupted approval HELD the original repair: no doomed re-approval remains in the queue
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, p.event_key).state, 'held');
  await assert.rejects(() => approveRepair(db, seller, p.event_key, { api: api2, validate: vies }), /No open repair/);
  // the fresh report still lists the refund as CreditNotePending and the feed list shows no orphan
  // from the interruption window -> the resend of the SAME document is cleared
  fail = false;
  const settled = await settleUnknownDocuments(db, seller, refundReport(), { api: api2, validate: vies });
  assert.deepEqual(settled.resubmitted, [rect.number], 'the SAME credit note was resubmitted');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 1, 'no second credit note exists');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, rect.number).upload_status, 'submitted');
});

test('an unknown-outcome correction credit note is not treated as done: processCorrections settles it on the fresh report', async () => {
  const db = openDb();
  let fail = false, calls = 0;
  const api2 = { uploadInvoice: async (a) => { calls++; if (fail) { const e = new Error('econnreset'); e.unknownOutcome = true; throw e; } return 'f' + calls; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, text, { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const corr = correctionPair();
  fail = true;
  const r1 = await processCorrections(db, seller, corr, { api: api2, validate: vies });
  assert.equal(r1.errors.length, 1, 'the interrupted credit note upload surfaced as an error');
  const cn = db.prepare("SELECT number, upload_status FROM invoices WHERE seller_id=? AND kind='rectificativa' AND shipment_key='REFUND:CorrectionReversal:X:1'").get(seller.id);
  assert.equal(cn.upload_status, 'unknown');
  assert.ok(listRepairs(db, seller.id).some(r => r.kind === 'unknown_outcome'), 'visible hold for the unknown correction document');
  // the next sync sees the SAME report still listing the event -> settles the same document
  fail = false;
  const r2 = await processCorrections(db, seller, corr, { api: api2, validate: vies });
  assert.equal(r2.creditNotes, 1, 'the fresh report re-drove the correction');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, cn.number).upload_status, 'submitted');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 1, 'the replacement still waits for Amazon to confirm the credit note');
  // Amazon confirms the credit note -> only then does the pair complete
  const [h0, ...cRows] = corr.trim().split('\n');
  await processReport(db, seller, withDesc(h0, cRows[0].split('\t'), 'CreditNoteUploaded'), { api: api2, validate: vies });
  const r3 = await processCorrections(db, seller, corr, { api: api2, validate: vies });
  assert.equal(r3.invoices, 1);
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 2, 'still exactly credit note + replacement, no third document');
});

test('a feed failure on a correction document proposes the record-key retry, never the crash-prone plain path', async () => {
  const db = openDb();
  const calls = [];
  const api2 = { uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) };
  await processReport(db, seller, text, { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  await processCorrections(db, seller, correctionPair(), { api: api2, validate: vies });
  const cn = db.prepare("SELECT number, feed_id FROM invoices WHERE seller_id=? AND kind='rectificativa' AND shipment_key='REFUND:CorrectionReversal:X:1'").get(seller.id);
  // CANCELLED = the feed never started processing (Feeds use-case guide): a safe same-document retry
  const cancelled = { feedStatus: async (id) => ({ status: id === cn.feed_id ? 'CANCELLED' : 'DONE' }) };
  await pollFeeds(db, seller, cancelled);
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, cn.number).upload_status, 'rejected');
  const q = listRepairs(db, seller.id).find(r => r.kind === 'rejected_correction_document');
  assert.ok(q, 'a retry was proposed for the cancelled correction feed');
  assert.equal(q.suggestion.action, 'retry_rect', 'correction documents go through the record-key path');
  const res = await approveRepair(db, seller, q.event_key, { api: api2, validate: vies });
  assert.equal(res.rectNumber, cn.number, 'the SAME correction document was retried, no crash on the missing shipments row');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 1, 'the replacement never went out while its reversal was unconfirmed');
});

// ---------- round-6: retry paths get the same crash discipline as first uploads ----------

test('a retry upload is marked sending BEFORE Amazon is called, and a crash mid-retry is recovered as unknown', async () => {
  const db = openDb();
  let inv, seen;
  const api2 = { uploadInvoice: async () => { seen = db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status; const e = new Error('socket hang up'); e.unknownOutcome = true; throw e; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  const api0 = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, singleRow(null), { api: api0, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  inv = db.prepare("SELECT number, shipment_key FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  await processReport(db, seller, singleRow('InvoiceRejected', 'Internal processing error'), { api: api0, validate: vies });
  const [q] = listRepairs(db, seller.id);
  await assert.rejects(() => approveRepair(db, seller, q.event_key, { api: api2, validate: vies }), /socket hang up/);
  assert.equal(seen, 'sending', 'the retry marked the document sending before calling Amazon');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'unknown');
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, q.event_key).state, 'held', 'the interrupted retry repair is held, not re-proposed');
  // a true crash leaves the document in 'sending': boot recovery turns it into unknown + hold
  const db2 = openDb();
  await processReport(db2, seller, singleRow(null), { api: api0, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv2 = db2.prepare("SELECT number, shipment_key FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  await processReport(db2, seller, singleRow('InvoiceRejected', 'Internal processing error'), { api: api0, validate: vies });
  db2.prepare("UPDATE invoices SET upload_status='sending' WHERE seller_id=? AND number=?").run(seller.id, inv2.number); // the retry's marker, then the process died
  db2.prepare("UPDATE shipments SET status='sending' WHERE seller_id=? AND key=?").run(seller.id, inv2.shipment_key);
  assert.equal(recoverUncertainUploads(db2), 1);
  assert.equal(db2.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv2.number).upload_status, 'unknown');
  assert.ok(listRepairs(db2, seller.id).some(r => r.kind === 'unknown_outcome'), 'boot recovery created the hold for the crashed retry');
});

test('a definitely refused retry returns the document to rejected, so the reviewed retry stays available', async () => {
  const db = openDb();
  let fail = true;
  const api2 = { uploadInvoice: async () => { if (fail) { const e = new Error('SP-API POST /feeds -> 400 {"errors":[{"code":"InvalidInput"}]}'); throw e; } return 'f2'; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, singleRow(null), { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  await processReport(db, seller, singleRow('InvoiceRejected', 'Internal processing error'), { api: api2, validate: vies });
  const [q] = listRepairs(db, seller.id);
  await assert.rejects(() => approveRepair(db, seller, q.event_key, { api: api2, validate: vies }), /InvalidInput/);
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'rejected', 'a definite refusal restores rejected');
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, q.event_key).state, 'proposed', 'the review stays open');
  fail = false;
  await approveRepair(db, seller, q.event_key, { api: api2, validate: vies });
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'submitted');
});

test('a retried correction document is marked sending before Amazon, and an interrupted retry creates a hold', async () => {
  const db = openDb();
  const calls = [];
  const api2 = { uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, text, { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const corr = correctionPair();
  await processCorrections(db, seller, corr, { api: api2, validate: vies });
  const cn = db.prepare("SELECT number, feed_id FROM invoices WHERE seller_id=? AND kind='rectificativa' AND shipment_key='REFUND:CorrectionReversal:X:1'").get(seller.id);
  // the credit note's feed is cancelled before processing -> a reviewed retry of the same document is proposed
  const cancelled = { feedStatus: async (id) => ({ status: id === cn.feed_id ? 'CANCELLED' : 'DONE' }) };
  await pollFeeds(db, seller, cancelled);
  const q = listRepairs(db, seller.id).find(r => r.kind === 'rejected_correction_document');
  assert.ok(q, 'a retry was proposed for the failed correction feed');
  // the retry itself is interrupted after Amazon may have received it
  let seen;
  const api3 = { uploadInvoice: async () => { seen = db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, cn.number).upload_status; const e = new Error('connection reset'); e.unknownOutcome = true; throw e; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await assert.rejects(() => approveRepair(db, seller, q.event_key, { api: api3, validate: vies }), /connection reset/);
  assert.equal(seen, 'sending', 'the retry marked the correction document sending before calling Amazon');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, cn.number).upload_status, 'unknown');
  assert.ok(listRepairs(db, seller.id).some(r => r.kind === 'unknown_outcome'), 'a visible hold was created for the interrupted correction retry');
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, q.event_key).state, 'held', 'the retried repair is held, not re-proposed');
  assert.equal(calls.filter(c => c.documentType === 'Invoice' && c.transactionId === 'Correction::X:2').length, 0, 'the replacement never went out while its reversal was unconfirmed');
});

test('a credit note Amazon reports as Processing is never resent, even when the local state was unknown', async () => {
  const db = openDb();
  let calls = 0, fail = true;
  const api2 = { uploadInvoice: async () => { calls++; if (fail) { const e = new Error('econnreset'); e.unknownOutcome = true; throw e; } return 'f' + calls; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, text, { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const corr = correctionPair();
  await processCorrections(db, seller, corr, { api: api2, validate: vies });
  const cn = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='rectificativa' AND shipment_key='REFUND:CorrectionReversal:X:1'").get(seller.id);
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, cn.number).upload_status, 'unknown');
  const callsBefore = calls;
  // Amazon's next report says it is PROCESSING the credit note: Amazon holds it, no seller action needed
  const [head, ...rows] = corr.trim().split('\n');
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), 'CreditNoteProcessing'), { api: api2, validate: vies });
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, cn.number).upload_status, 'processing');
  assert.ok(listRepairs(db, seller.id, 'issued').some(r => r.kind === 'unknown_outcome'), 'the unknown-outcome hold was closed by Amazon processing evidence');
  // and the correction pass must not resend it, nor issue the replacement yet
  fail = false;
  const r = await processCorrections(db, seller, corr, { api: api2, validate: vies });
  assert.equal(calls, callsBefore, 'no resend while Amazon is processing the document');
  assert.equal(r.creditNotes, 0);
  assert.equal(r.invoices, 0, 'processing is not acceptance - the replacement still waits');
});

test('a fresh pending report alone does not clear a resend: an orphan feed from the interruption window blocks it', async () => {
  const db = openDb();
  let fail = true, calls = 0, feeds = [];
  const orphan = { feedId: 'feed-orphan-1', status: 'IN_PROGRESS', createdTime: new Date().toISOString() };
  const api2 = { uploadInvoice: async () => { calls++; if (fail) { const e = new Error('socket hang up'); e.unknownOutcome = true; throw e; } return 'f' + calls; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => feeds };
  await processReport(db, seller, singleRow(null), { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'unknown');
  // the stale-pending scenario: the report still says due, but Amazon's feed list holds an orphan
  // feed from the interruption window - the report may be lagging, so no resend
  fail = false; feeds = [orphan];
  const out = await processReport(db, seller, singleRow(null), { api: api2, validate: vies });
  assert.equal(calls, 1, 'no resend while an orphan feed exists');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'unknown');
  assert.ok(out.held.some(h => /feed-orphan-1/.test(h.reason)), 'the hold names the orphan feed');
  // Amazon keeps feeds for up to 90 days, so the orphan does NOT age out of the list: the resolution
  // is a human checking the feed in Seller Central and dismissing the hold -> the resend proceeds
  const hold = listRepairs(db, seller.id).find(r => r.kind === 'unknown_outcome');
  decideRepair(db, seller.id, hold.event_key, 'dismissed');
  await processReport(db, seller, singleRow(null), { api: api2, validate: vies });
  assert.equal(calls, 2, 'exactly one cleared resend after the human dismissal');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'submitted');
});

test('the replacement waits for acceptance of the credit note - a failed reversal feed never strands a half pair', async () => {
  const db = openDb();
  const calls = [];
  const api2 = { uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, text, { api: api2, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const corr = correctionPair();
  const r1 = await processCorrections(db, seller, corr, { api: api2, validate: vies });
  assert.equal(r1.creditNotes, 1);
  assert.equal(r1.invoices, 0, 'the replacement waits for the credit note to be confirmed');
  assert.ok(r1.skipped.some(x => /not yet confirmed accepted/.test(x.reason)));
  const cn = db.prepare("SELECT number, feed_id FROM invoices WHERE seller_id=? AND kind='rectificativa' AND shipment_key='REFUND:CorrectionReversal:X:1'").get(seller.id);
  // the credit note's feed is cancelled BEFORE any replacement exists
  const cancelled = { feedStatus: async (id) => ({ status: id === cn.feed_id ? 'CANCELLED' : 'DONE' }) };
  await pollFeeds(db, seller, cancelled);
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, cn.number).upload_status, 'rejected');
  const r2 = await processCorrections(db, seller, corr, { api: api2, validate: vies });
  assert.equal(r2.invoices, 0, 'no replacement while the reversal is unconfirmed');
  assert.equal(calls.filter(c => c.documentType === 'Invoice' && c.transactionId === 'Correction::X:2').length, 0, 'the replacement was never sent');
  // Amazon confirms the credit note -> the pair completes on the next pass
  const [head, ...rows] = corr.trim().split('\n');
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), 'CreditNoteUploaded'), { api: api2, validate: vies });
  const r3 = await processCorrections(db, seller, corr, { api: api2, validate: vies });
  assert.equal(r3.invoices, 1, 'the replacement goes out only after acceptance');
});

// ---------- round-7: FATAL is not CANCELLED; attempt-time anchoring; human orphan resolution ----------

test('a FATAL feed is never treated as never-processed: unknown + hold, no retry proposal, only the settle path resends', async () => {
  const db = openDb();
  let calls = 0, resultFetched = 0;
  const api0 = { uploadInvoice: async () => { calls++; return 'f' + calls; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, singleRow(null), { api: api0, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'submitted');
  // Amazon stops the feed with a FATAL error and generated a processing report
  const fatal = { feedStatus: async () => ({ status: 'FATAL', resultDocumentId: 'rd1' }),
    downloadFeedResult: async (id) => { resultFetched++; assert.equal(id, 'rd1'); return 'record\tdoc\tstatus\n1\t' + inv.number + '\terror: simulated fatal failure'; } };
  await pollFeeds(db, seller, fatal);
  assert.equal(resultFetched, 1, 'the FATAL processing report was fetched as evidence (Amazon generates one only sometimes)');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'unknown',
    'FATAL means "some, none, or all of the operations might have completed" - never proof Amazon holds nothing');
  const holds = listRepairs(db, seller.id).filter(r => r.kind === 'unknown_outcome');
  assert.equal(holds.length, 1, 'a visible unknown-outcome hold was created');
  assert.equal(holds[0].suggestion.action, 'hold');
  assert.ok(!listRepairs(db, seller.id).some(r => ['retry_upload', 'retry_rect'].includes(r.suggestion.action)), 'FATAL alone never justifies a resend: no retry was proposed');
  assert.equal(calls, 1, 'nothing was resent during the poll');
  // the fresh report still lists the shipment as due and the logged processing report proves THIS
  // document failed -> the settle path resends the SAME document (round-10: the report, not the
  // due-state, lifts the block).
  const out = await processReport(db, seller, singleRow(null), { api: api0, validate: vies });
  assert.equal(calls, 2, 'exactly one resend through the settle path');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'submitted');
});

test('a long downtime cannot hide the original feed: the settle window anchors on the attempt start', async () => {
  const db = openDb();
  const api0 = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, singleRow(null), { api: api0, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT number, shipment_key FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  // simulate a crash in the upload window TWO HOURS ago: the feed id was never recorded
  const twoHoursBack = new Date(Date.now() - 2 * 3600e3).toISOString();
  db.prepare("UPDATE invoices SET upload_status='sending', feed_id=NULL, sending_at=? WHERE seller_id=? AND number=?").run(twoHoursBack, seller.id, inv.number);
  db.prepare("UPDATE shipments SET status='sending' WHERE seller_id=? AND key=?").run(seller.id, inv.shipment_key);
  assert.equal(recoverUncertainUploads(db), 1);
  const ev = db.prepare("SELECT detail FROM events WHERE seller_id=? AND type='upload_unknown_outcome' ORDER BY ts DESC LIMIT 1").get(seller.id);
  assert.equal(JSON.parse(ev.detail).attemptedAt, twoHoursBack, 'the recovery event keeps the original attempt time, not the boot time');
  // the feed Amazon created during the original attempt, 2 hours back. The listFeeds stub filters by
  // createdSince exactly like the real API - an event-time window around NOW would never see it.
  const orphan = { feedId: 'feed-old-orphan', status: 'DONE', createdTime: new Date(Date.parse(twoHoursBack) + 60e3).toISOString() };
  let calls = 0;
  const api2 = { uploadInvoice: async () => { calls++; return 'f9'; }, feedStatus: async () => ({ status: 'DONE' }),
    listFeeds: async ({ createdSince } = {}) => [orphan].filter(f => !createdSince || f.createdTime >= createdSince) };
  const out = await processReport(db, seller, singleRow(null), { api: api2, validate: vies });
  assert.equal(calls, 0, 'the orphan from the original attempt window still blocks after hours of downtime');
  assert.ok(out.held.some(h => /feed-old-orphan/.test(h.reason)), 'the hold names the orphan feed');
  // the human checked the feed in Seller Central: Amazon does not hold the document -> dismiss -> resend
  const hold = listRepairs(db, seller.id).find(r => r.kind === 'unknown_outcome');
  decideRepair(db, seller.id, hold.event_key, 'dismissed');
  assert.ok(db.prepare("SELECT 1 FROM events WHERE seller_id=? AND type='unknown_hold_dismissed'").get(seller.id), 'the dismissal is on record');
  await processReport(db, seller, singleRow(null), { api: api2, validate: vies });
  assert.equal(calls, 1, 'the dismissal cleared the resend even with the orphan still listed');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'submitted');
});

test('the orphan cross-check blocks on a FATAL feed but not on a CANCELLED one (cancelled feeds never ran)', async () => {
  const db = openDb();
  const api0 = { uploadInvoice: async () => { const e = new Error('socket hang up'); e.unknownOutcome = true; throw e; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, singleRow(null), { api: api0, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'unknown');
  const nowIso = new Date().toISOString();
  const mk = (status) => ({ listFeeds: async () => [{ feedId: 'fx-' + status, status, createdTime: nowIso }] });
  const fatalBlock = await unknownSettleCheck(db, seller, mk('FATAL'), inv.number);
  assert.ok(fatalBlock && /fx-FATAL/.test(fatalBlock), 'a FATAL orphan may have been processed - it blocks the resend');
  assert.ok(/dismiss the hold/.test(fatalBlock), 'the block names the human resolution path');
  const cancelBlock = await unknownSettleCheck(db, seller, mk('CANCELLED'), inv.number);
  assert.equal(cancelBlock, null, 'a CANCELLED orphan never started processing - it does not block');
});
