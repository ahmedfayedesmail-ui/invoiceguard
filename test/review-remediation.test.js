// Wave 3 review remediation (reviewer 4 F1-F3). R-tests are written against the behaviour the reviewers showed to be missing.
import test from 'node:test'; import assert from 'node:assert/strict'; import { openDb } from '../src/db.js'; import { reconcileInvoice } from '../src/pipeline.js';
function seed(db, status) { db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,json,upload_status) VALUES (?,?,?,?,?,?,?,?,?)').run('s1', 'N1', 'SHIPMENT:S1', 'invoice', '2026-01-01', 10, 1, '{}', status); }
const st = (db) => db.prepare("SELECT upload_status s FROM invoices WHERE number='N1'").get().s;
test('R1 uploaded -> rejected is allowed only as an explicit declaration; every other way back is still blocked', () => {
  const db = openDb(); seed(db, 'uploaded'); db.prepare("UPDATE invoices SET upload_status='rejected' WHERE number='N1'").run(); assert.equal(st(db), 'rejected');
  for (const to of ['pending', 'ready', 'sending', 'submitted', 'processing', 'unknown']) { const d = openDb(); seed(d, 'uploaded'); assert.throws(() => d.prepare('UPDATE invoices SET upload_status=? WHERE number=?').run(to, 'N1'), /never changes status again/); }
});
test('R2 a Rejected verdict for an uploaded document opens a HOLD, does not throw, does not change the status', () => {
  const db = openDb(); db.prepare("INSERT OR IGNORE INTO sellers (id) VALUES ('s1')").run(); seed(db, 'uploaded');
  assert.doesNotThrow(() => reconcileInvoice(db, { id: 's1' }, { shippingId: 'S1', key: 'S1', invoiceStatus: 'InvoiceRejected', invoiceStatusDesc: 'bad' }));
  assert.equal(st(db), 'uploaded');
  const f = db.prepare("SELECT code,status,severity FROM integrity_findings WHERE seller_id='s1'").all(); assert.deepEqual(f.map(x => ({ ...x })), [{ code: 'UPLOADED_THEN_REJECTED', status: 'OPEN', severity: 'HOLD' }]);
});
