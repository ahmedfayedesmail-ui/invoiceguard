import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { processReport } from '../src/pipeline.js';
import { detectRepairs, listRepairs, decideRepair, approveRepair } from '../src/repair.js';

const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'selR', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const api = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }) };
const vies = async (v) => ({ status: 'valid', vat: v });

function refundReport() {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const row = rows[0].split('\t');
  const ref = [...row]; ref[ix('transaction-type')] = 'REFUND'; ref[ix('transaction-id')] = 'r-100-1';
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
  const ref = [...rows[0].split('\t')]; ref[ix('transaction-type')] = 'REFUND'; ref[ix('transaction-id')] = 'r-100-1';
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
