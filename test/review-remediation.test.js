// Wave 3 review remediation (reviewer 4 F1-F3). R-tests are written against the behaviour the reviewers showed to be missing.
import test from 'node:test'; import assert from 'node:assert/strict'; import { openDb } from '../src/db.js'; import { reconcileInvoice } from '../src/pipeline.js';
function seed(db, status) { db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,json,upload_status) VALUES (?,?,?,?,?,?,?,?,?)').run('s1', 'N1', 'SHIPMENT:S1', 'invoice', '2026-01-01', 10, 1, '{}', status); }
const st = (db) => db.prepare("SELECT upload_status s FROM invoices WHERE number='N1'").get().s;
test('R1 uploaded -> rejected is allowed only as an explicit declaration; every other way back is still blocked', () => {
  const db = openDb(); seed(db, 'uploaded'); db.prepare("UPDATE invoices SET upload_status='rejected' WHERE number='N1'").run(); assert.equal(st(db), 'rejected');
  for (const to of ['pending', 'ready', 'sending', 'submitted', 'processing', 'unknown']) { const d = openDb(); seed(d, 'uploaded'); assert.throws(() => d.prepare('UPDATE invoices SET upload_status=? WHERE number=?').run(to, 'N1'), /never changes status again/); }
});
test('R2 a Rejected verdict for an uploaded document opens a HOLD, does not throw, does not change the status (ruling 5: an UNPROVEN row now holds as ORIGINAL_INVOICE_VERDICT_UNPROVEN; the proven contradiction is covered in ruling5-original-gate.test.js)', () => {
  const db = openDb(); db.prepare("INSERT OR IGNORE INTO sellers (id) VALUES ('s1')").run(); seed(db, 'uploaded');
  assert.doesNotThrow(() => reconcileInvoice(db, { id: 's1' }, { shippingId: 'S1', key: 'S1', invoiceStatus: 'InvoiceRejected', invoiceStatusDesc: 'bad' }));
  assert.equal(st(db), 'uploaded');
  const f = db.prepare("SELECT code,status,severity FROM integrity_findings WHERE seller_id='s1'").all(); assert.deepEqual(f.map(x => ({ ...x })), [{ code: 'ORIGINAL_INVOICE_VERDICT_UNPROVEN', status: 'OPEN', severity: 'HOLD' }]);
});
import { recoverUncertainUploads } from '../src/repair.js'; import { openCreditNoteHold } from '../src/cn-gate.js';
test('R3 boot recovery leaves a young claim alone (another process may be uploading) and recovers an old one; minAgeMs 0 keeps the old behaviour', () => {
  const mk = (at) => { const db = openDb(); db.prepare("INSERT OR IGNORE INTO sellers (id) VALUES ('s1')").run(); seed(db, 'sending'); db.prepare("UPDATE invoices SET sending_at=? WHERE number='N1'").run(at); return db; };
  const young = mk(new Date().toISOString()); assert.equal(recoverUncertainUploads(young, { minAgeMs: 600000 }), 0); assert.equal(st(young), 'sending');
  const old = mk(new Date(Date.now() - 3600000).toISOString()); assert.equal(recoverUncertainUploads(old, { minAgeMs: 600000 }), 1); assert.equal(st(old), 'unknown');
  const legacy = mk(new Date().toISOString()); assert.equal(recoverUncertainUploads(legacy), 1);
});
test('R4 an Invoice* verdict never moves a correction document while a credit-note hold on its pair is OPEN', () => {
  const db = openDb(); db.prepare("INSERT OR IGNORE INTO sellers (id) VALUES ('s1')").run();
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,rectifies,issued_at,total,vat,json,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?)').run('s1', 'R1', 'CorrectionReversal:X:1', 'rectificativa', 'N0', '2026-01-02', -10, -1, '{}', 'submitted');
  openCreditNoteHold(db, 's1', 'CorrectionReversal:X:1', 'CREDIT_NOTE_VERDICT_CONTRADICTION', [{ c: 'verdict', why: 'contradiction' }], {});
  reconcileInvoice(db, { id: 's1' }, { shippingId: 'S9', key: 'CorrectionReversal:X:1', isCorrectedTx: true, invoiceStatus: 'InvoiceUploaded' });
  assert.equal(db.prepare("SELECT upload_status s FROM invoices WHERE number='R1'").get().s, 'submitted');
});
