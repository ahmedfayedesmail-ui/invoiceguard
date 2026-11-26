import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { processReport, processCorrections } from '../src/pipeline.js';
import { detectRepairs, listRepairs, decideRepair, approveRepair } from '../src/repair.js';

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
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const rej = [...rows[0].split('\t')]; rej[ix('invoice-status')] = 'InvoiceRejected'; rej[ix('invoice-status-description')] = 'TotalAmount mismatch';
  await processReport(db, seller, [head, rej.join('\t')].join('\n'), { api: api2, validate: vies });
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
  const [head, ...rows] = refundReport().trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const rej = [...rows[0].split('\t')]; rej[ix('invoice-status')] = 'CreditNoteRejected';
  await processReport(db, seller, [head, rej.join('\t')].join('\n'), { api: api2, validate: vies });
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, rect.number).upload_status, 'rejected');
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, p.event_key).state, 'rejected');
  const res = await approveRepair(db, seller, p.event_key, { api: api2, validate: vies });
  assert.equal(res.rectNumber, rect.number, 'the SAME credit note number was retried');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, rect.number).upload_status, 'submitted');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 1, 'no second credit note exists');
});
