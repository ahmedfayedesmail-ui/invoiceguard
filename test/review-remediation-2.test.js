// Expedition re-review 2: neighbouring silent-resolve paths and the trigger migration.
import test from 'node:test'; import assert from 'node:assert/strict'; import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { openDb } from '../src/db.js'; import { writeLedger } from '../src/integrity.js'; import { openCreditNoteHold } from '../src/cn-gate.js';
const open = (db, code, key = 'K1') => db.prepare("SELECT status FROM integrity_findings WHERE shipment_key=? AND code=?").get(key, code)?.status;
const seed = (db, code, key = 'K1') => writeLedger(db, 's', key, [{ code, severity: 'HOLD', resolution: 'HUMAN_DECISION', evidence: { field: 'f' }, fingerprint: 'fp-' + code, explanation: 'x', action: 'y' }]);
test('R5-1 a credit-note hold opening on a key never resolves an open UPLOADED_THEN_REJECTED on it', () => {
  const db = openDb(); seed(db, 'UPLOADED_THEN_REJECTED'); assert.equal(open(db, 'UPLOADED_THEN_REJECTED'), 'OPEN');
  openCreditNoteHold(db, 's', 'K1', 'CREDIT_NOTE_IDENTITY_UNPROVEN', [{ c: 'invoice-number', why: 'w' }]);
  assert.equal(open(db, 'UPLOADED_THEN_REJECTED'), 'OPEN'); assert.equal(open(db, 'CREDIT_NOTE_IDENTITY_UNPROVEN'), 'OPEN');
});
test('R5-2 a plain ledger write that does not evaluate a gate-owned code (the shipment gate) never resolves it', () => {
  const db = openDb(); for (const c of ['UPLOADED_THEN_REJECTED', 'REFUND_ROW_INVOICE_STATUS', 'CREDIT_NOTE_ROWS_CONFLICT']) seed(db, c);
  writeLedger(db, 's', 'K1', []); for (const c of ['UPLOADED_THEN_REJECTED', 'REFUND_ROW_INVOICE_STATUS', 'CREDIT_NOTE_ROWS_CONFLICT']) assert.equal(open(db, c), 'OPEN', c);
});
test('R5-3 a database created with the OLD uploaded-is-terminal trigger is upgraded on open (seller-declared rejection works), concurrent opens do not crash', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mig-')), 'm.db'); let db = openDb(file);
  db.exec('DROP TRIGGER invoice_uploaded_is_terminal'); db.exec("CREATE TRIGGER invoice_uploaded_is_terminal BEFORE UPDATE OF upload_status ON invoices WHEN OLD.upload_status='uploaded' AND (NEW.upload_status IS NULL OR NEW.upload_status NOT IN ('uploaded')) BEGIN SELECT RAISE(ABORT,'old rule'); END");
  db.prepare("INSERT INTO invoices (seller_id, number, kind, upload_status, shipment_key) VALUES ('s','N1','invoice','uploaded','SHIPMENT:A')").run();
  assert.throws(() => db.prepare("UPDATE invoices SET upload_status='rejected' WHERE number='N1'").run(), /old rule/); db.close();
  const a = openDb(file), b = openDb(file); a.prepare("UPDATE invoices SET upload_status='rejected' WHERE number='N1'").run();
  assert.throws(() => b.prepare("UPDATE invoices SET upload_status='submitted' WHERE number='N1'").run && b.prepare("UPDATE invoices SET upload_status='uploaded' WHERE number='N1'").run() && b.prepare("UPDATE invoices SET upload_status='submitted' WHERE number='N1'").run(), /state machine/);
});
test('R5-4 a credit-note hold opening on a key never resolves a BLOCK finding on it (writeLedger-level, partial writes)', () => {
  const db = openDb(); writeLedger(db, 's', 'K1', [{ code: 'TOTALS_CONTRADICT', severity: 'BLOCK', resolution: 'NEW_EVIDENCE', evidence: { field: 'totals' }, fingerprint: 'fpb', explanation: 'x', action: 'y' }]);
  openCreditNoteHold(db, 's', 'K1', 'CREDIT_NOTE_ROWS_CONFLICT', [{ c: 'rows-agree-on-status', why: 'w' }]);
  assert.equal(open(db, 'TOTALS_CONTRADICT'), 'OPEN'); assert.equal(open(db, 'CREDIT_NOTE_ROWS_CONFLICT'), 'OPEN');
  writeLedger(db, 's', 'K1', []); assert.equal(open(db, 'TOTALS_CONTRADICT'), 'RESOLVED', 'a full evaluator that stops reporting its own finding still resolves it (guard)');
});
