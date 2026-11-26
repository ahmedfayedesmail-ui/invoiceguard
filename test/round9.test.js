// Round-9: independent-reviewer confirmation-pass findings on d3137f9.
// N1: /api/rectify double-click minted and auto-uploaded TWO identical correction documents
//     (recordKey-less path had no idempotency). Fix: dedupe fingerprint + check, number
//     allocation and insert in ONE IMMEDIATE transaction.
// N2: the round-8 partial unique index exempted ALL 'SHIPMENT:%' keys, silently uncovering
//     Amazon Correction:: events ('SHIPMENT:Correction::...'). Fix: widened predicate.
// N3: a UNIQUE collision (or a rule-pack refusal) after nextNumber committed burned a number
//     in a correlative series. Fix: allocateNumber inside the same transaction as the INSERT.
// N4: recoverUncertainUploads was the last unknown-outcome handler without a tx; a crash
//     between the status write and the hold proposal lost the visible hold.
// Scenarios N1/N2 are seeded from the reviewer's reproduction script (round8-repro.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrateAuth } from '../src/db.js';
import { issueRectificativa } from '../src/pipeline.js';
import { recoverUncertainUploads, listRepairs } from '../src/repair.js';

const seller = { id: 'selR9', name: 'Test S.L.', nif: 'B1', address: 'x', country: 'ES' };
const vies = async (v) => ({ status: 'valid', vat: v });

function seed(db) {
  migrateAuth(db);
  db.prepare('INSERT INTO sellers (id,name,nif,address,marketplace_ids,region,created_at,country) VALUES (?,?,?,?,?,?,?,?)')
    .run(seller.id, seller.name, seller.nif, seller.address, '["ES"]', 'EU', new Date().toISOString(), 'ES');
  const s = { key: 'SHIPMENT:SH1', orderId: 'O1', shippingId: 'SH1', marketplace: 'ES', transactionId: 'SH1',
    billing: { name: 'Buyer SA', lines: ['Calle 1'], city: 'Madrid', postal: '28001', country: 'ES' },
    buyerVat: null, buyerCompany: 'Buyer SA', shipCountry: 'ES', incl: 121, vat: 21, shipmentDate: '2026-11-20T00:00:00Z' };
  db.prepare(`INSERT INTO shipments (seller_id,key,order_id,shipping_id,buyer_vat,buyer,country,total,vat,shipment_date,due_at,status,reason,raw,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(seller.id, s.key, s.orderId, s.shippingId, null, s.buyerCompany, 'ES', 121, 21, s.shipmentDate, null, 'uploaded', null, JSON.stringify(s), new Date().toISOString());
  const inv = { number: 'A-2026-000001', type: 'invoice', series: 'A', issueDate: '2026-11-20', operationDate: '2026-11-20', orderId: 'O1',
    buyer: { name: 'Buyer SA', vat: null, address: ['Calle 1', '28001 Madrid', 'ES'] }, buyerCountry: 'ES',
    seller: { name: 'Test S.L.', nif: 'B1', address: 'x' }, currency: 'EUR', langs: ['es'],
    lines: [{ description: 'Widget', sku: 'SKU-A', qty: 1, unitExcl: 100, excl: 100, vat: 21, rate: 21 }],
    totals: { excl: 100, vat: 21, incl: 121 } };
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,json,feed_id,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(seller.id, inv.number, s.key, 'invoice', new Date().toISOString(), 121, 21, JSON.stringify(inv), 'f0', 'uploaded');
  return inv;
}
const mockApi = (uploads) => ({ uploadInvoice: async (a) => { uploads.push(a.number); return 'feed-' + uploads.length; }, feedStatus: async () => ({ status: 'DONE' }) });
const rectCount = (db) => db.prepare("SELECT number, upload_status FROM invoices WHERE seller_id=? AND kind='rectificativa' ORDER BY number").all(seller.id);
const subOpts = { mode: 'substitution', reason: 'billing fix', changes: { buyer: { name: 'New Name SA' } }, documentType: 'Invoice' };

test('N1: two interleaved recordKey-less corrections issue ONE document, ONE upload', async () => {
  const db = openDb(); const inv = seed(db); const uploads = [];
  const api = mockApi(uploads);
  const [r1, r2] = await Promise.allSettled([issueRectificativa(db, seller, inv.number, { ...subOpts }, { api, validate: vies }), issueRectificativa(db, seller, inv.number, { ...subOpts }, { api, validate: vies })]);
  const docs = rectCount(db);
  assert.equal(docs.length, 1, JSON.stringify(docs));
  assert.equal(uploads.length, 1, JSON.stringify(uploads));
  const loser = [r1, r2].find(r => r.status === 'rejected');
  assert.ok(loser, 'one call must be refused');
  assert.match(loser.reason.message, /already exists as R-/);
});

test('N1: sequential double-click is refused; a rejected first attempt may be re-issued', async () => {
  const db = openDb(); const inv = seed(db); const uploads = [];
  const api = mockApi(uploads);
  const first = await issueRectificativa(db, seller, inv.number, { ...subOpts }, { api, validate: vies });
  await assert.rejects(issueRectificativa(db, seller, inv.number, { ...subOpts }, { api, validate: vies }), /already exists as R-/);
  assert.equal(rectCount(db).length, 1);
  assert.equal(uploads.length, 1);
  // Amazon rejected the document: the same correction may be issued again (a NEW document).
  db.prepare("UPDATE invoices SET upload_status='rejected' WHERE seller_id=? AND number=?").run(seller.id, first.rect.number);
  const second = await issueRectificativa(db, seller, inv.number, { ...subOpts }, { api, validate: vies });
  assert.notEqual(second.rect.number, first.rect.number);
  assert.equal(rectCount(db).length, 2);
  // ...and a DIFFERENT correction of the same invoice is never blocked by the fingerprint.
  const third = await issueRectificativa(db, seller, inv.number, { ...subOpts, changes: { buyer: { name: 'Other Name SA' } } }, { api, validate: vies });
  assert.ok(third.rect.number);
});

test('N2: two interleaved issues for one Amazon Correction:: event yield ONE document', async () => {
  const db = openDb(); const inv = seed(db); const uploads = [];
  const api = mockApi(uploads);
  const opts = { ...subOpts, transactionId: 'Correction::X:2', recordKey: 'SHIPMENT:Correction::X:2' };
  const [r1, r2] = await Promise.allSettled([issueRectificativa(db, seller, inv.number, opts, { api, validate: vies }), issueRectificativa(db, seller, inv.number, opts, { api, validate: vies })]);
  const docs = rectCount(db);
  assert.equal(docs.length, 1, JSON.stringify(docs));
  assert.equal(uploads.length, 1, JSON.stringify(uploads));
  const loser = [r1, r2].find(r => r.status === 'rejected');
  assert.ok(loser, 'one call must lose the race');
  // the loser is refused either at the UNIQUE insert or at the atomic upload claim
  assert.match(loser.reason.message, /concurrent run|already exists|already being uploaded/);
});

test('N3: a refused issue burns NO number in the correlative R series', async () => {
  const db = openDb(); const inv = seed(db); const uploads = [];
  const api = mockApi(uploads);
  const first = await issueRectificativa(db, seller, inv.number, { ...subOpts }, { api, validate: vies });
  assert.equal(first.rect.number, 'R-2026-000001');
  // Both refusal kinds run BEFORE any committed write: the dedupe refusal and the
  // concurrent-run UNIQUE refusal (covered live in N2) roll the allocation back with them.
  await assert.rejects(issueRectificativa(db, seller, inv.number, { ...subOpts }, { api, validate: vies }), /already exists/);
  const next = await issueRectificativa(db, seller, inv.number, { ...subOpts, changes: { buyer: { name: 'Other Name SA' } } }, { api, validate: vies });
  assert.equal(next.rect.number, 'R-2026-000002', 'no number burned by the refused attempt');
});

test('N3: a rule-pack refusal (warnings) burns NO number either', async () => {
  const db = openDb(); const inv = seed(db); const uploads = [];
  const api = mockApi(uploads);
  // differences with a data-only change produces the warnings refusal before insert
  await assert.rejects(issueRectificativa(db, seller, inv.number, { mode: 'differences', reason: 'x', changes: { buyer: { name: 'New Name SA' } } }, { api, validate: vies }), /substitution/);
  const ok = await issueRectificativa(db, seller, inv.number, { ...subOpts }, { api, validate: vies });
  assert.equal(ok.rect.number, 'R-2026-000001');
});

test('N4: recoverUncertainUploads never loses the hold - status write and proposal are atomic', async () => {
  const db = openDb(); seed(db);
  db.prepare("UPDATE invoices SET upload_status='sending', sending_at=? WHERE seller_id=? AND number='A-2026-000001'").run(new Date().toISOString(), seller.id);
  recoverUncertainUploads(db); // no stuck rows here beyond the one above? it processes it - so reset
  db.prepare("UPDATE invoices SET upload_status='sending', sending_at=? WHERE seller_id=? AND number='A-2026-000001'").run(new Date().toISOString(), seller.id);
  db.prepare("DELETE FROM repairs").run();
  // Fault injection: crash inside the hold proposal. The status write must roll back with it.
  db.prepare("CREATE TRIGGER fail_repairs BEFORE INSERT ON repairs BEGIN SELECT RAISE(FAIL, 'injected crash'); END").run();
  assert.throws(() => recoverUncertainUploads(db), /injected crash/);
  const mid = db.prepare("SELECT upload_status FROM invoices WHERE seller_id=? AND number='A-2026-000001'").get(seller.id);
  assert.equal(mid.upload_status, 'sending', 'status write must roll back with the failed proposal');
  assert.equal(listRepairs(db, seller.id).length ?? 0, 0);
  db.prepare('DROP TRIGGER fail_repairs').run();
  // Clean run: document becomes 'unknown' AND the hold is visible.
  recoverUncertainUploads(db);
  const done = db.prepare("SELECT upload_status FROM invoices WHERE seller_id=? AND number='A-2026-000001'").get(seller.id);
  assert.equal(done.upload_status, 'unknown');
  assert.ok(listRepairs(db, seller.id).some(r => r.kind === 'unknown_outcome'), 'hold visible after recovery');
});
