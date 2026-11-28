import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { processReport, processCorrections } from '../src/pipeline.js';
import { releaseIntegrity } from '../src/integrity.js';
import { CODE, approveAll } from './correction-helpers.js';

// Owner decision (Ahmed, Nov 28 2026) on CorrectionReversal: tests written BEFORE the fix, see audit/phase-b/pre-fix-run-13-correction-approval.spec.txt.
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const vies = async (v) => ({ status: 'valid', vat: v });
const mkApi = () => { const calls = []; return { calls, uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) }; };
const [head, ...body] = text.trim().split('\n'); const cols = head.split('\t'); const ix = (n) => cols.indexOf(n); const base = body[0].split('\t');
const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const reversal = (id, over = null, status = 'CreditNotePending') => { const r = [...base]; r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = id; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = status; if (over) for (const [k, v] of Object.entries(over)) r[ix(k)] = v; return r.join('\t'); };
const replacement = (id, name) => { const f = [...base]; f[ix('transaction-id')] = id; f[ix('billing-name')] = name; f[ix('is-invoice-corrected')] = undefined; return f.join('\t'); };
const NOW = new Date('2026-11-24T12:00:00Z');
const start = async () => { const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: NOW }); api.calls.length = 0; return { api, db }; };
const run = (db, api, rows) => processCorrections(db, seller, [head, ...rows].join('\n'), { api, validate: vies });
const accept = (db, api, rows) => processReport(db, seller, [head, ...rows].join('\n'), { api, validate: vies, now: NOW });
const KEY = 'CORRECTION:REFUND:CorrectionReversal:X:1';
const pair = (name = 'Name One SL', st = 'CreditNotePending') => [reversal('CorrectionReversal:X:1', null, st), replacement('Correction::X:2', name)];
const credits = (db) => db.prepare("SELECT number, total FROM invoices WHERE kind='rectificativa' AND shipment_key LIKE 'REFUND:CorrectionReversal%'").all();
const finding = (db, code = CODE) => db.prepare('SELECT * FROM integrity_findings WHERE code=?').all(code);

test('R1: a fully matching correction issues NOTHING before approval, and the hold is a durable reviewable finding', async () => {
  const { api, db } = await start(); const r = await run(db, api, pair());
  assert.equal(api.calls.length, 0, 'nothing uploaded'); assert.equal(r.creditNotes, 0); assert.equal(credits(db).length, 0);
  const f = finding(db); assert.equal(f.length, 1); assert.equal(f[0].status, 'OPEN'); assert.equal(f[0].severity, 'HOLD'); assert.equal(f[0].resolution, 'HUMAN_DECISION'); assert.equal(f[0].shipment_key, KEY);
  const ev = JSON.parse(f[0].evidence); assert.ok(ev.original?.number && ev.reversalRows?.length && ev.replacementRows?.length, 'the review shows the original, every reversal row and the replacement');
  assert.ok(ev.amounts && 'cumulativeCredited' in ev.amounts && 'creditableBalance' in ev.amounts, 'amounts and the cumulative difference are shown');
  await run(db, api, pair()); assert.equal(api.calls.length, 0, 'a second pass still issues nothing'); assert.equal(finding(db).length, 1, 'no duplicate record');
});
test('R2: a correct approval issues exactly one credit note, and the decision is documented (user, reason, time, fingerprint)', async () => {
  const { api, db } = await start(); await run(db, api, pair()); const f = finding(db)[0];
  assert.throws(() => releaseIntegrity(db, seller.id, KEY, CODE, f.fingerprint, { user: 'u', reason: 'short' }), /10 characters/); assert.throws(() => releaseIntegrity(db, seller.id, KEY, CODE, f.fingerprint, { reason: 'long enough reason' }), /user/);
  releaseIntegrity(db, seller.id, KEY, CODE, f.fingerprint, { user: 'reviewer-1', reason: 'compared with the original invoice' });
  const d = db.prepare('SELECT * FROM integrity_decisions WHERE code=?').all(CODE); assert.equal(d.length, 1); assert.equal(d[0].decided_by, 'reviewer-1'); assert.equal(d[0].fingerprint, f.fingerprint); assert.ok(d[0].decided_at);
  assert.ok(db.prepare("SELECT 1 FROM integrity_history WHERE code=? AND event='RELEASED'").get(CODE));
  assert.equal(api.calls.length, 0, 'the decision itself issues nothing');
  const r = await run(db, api, pair()); assert.equal(r.creditNotes, 1); assert.equal(api.calls.filter(c => c.documentType === 'CreditNote').length, 1); assert.equal(api.calls.filter(c => c.documentType === 'Invoice').length, 0, 'no replacement yet');
  await run(db, api, pair()); assert.equal(credits(db).length, 1, 'a repeated pass adds nothing');
});
test('R3: changed evidence voids the approval and returns the state to HOLD', async () => {
  const { api, db } = await start(); await run(db, api, pair()); const f1 = finding(db)[0]; approveAll(db, seller.id);
  const r = await run(db, api, pair('Another Name SL')); // the replacement data changed after approval
  assert.equal(api.calls.length, 0, 'nothing issued on changed evidence'); assert.equal(r.creditNotes, 0);
  const f2 = finding(db)[0]; assert.equal(f2.status, 'OPEN'); assert.notEqual(f2.fingerprint, f1.fingerprint);
  assert.ok(db.prepare("SELECT 1 FROM integrity_history WHERE code=? AND event='CHANGED'").get(CODE));
  assert.throws(() => releaseIntegrity(db, seller.id, KEY, CODE, f1.fingerprint, { user: 'u', reason: 'old fingerprint reused' }), /fingerprint|evidence/i);
});
test('R4: a partial reversal stays HOLD and no decision can release it', async () => {
  const { api, db } = await start();
  const half = reversal('CorrectionReversal:X:1', { 'item-vat-incl-amount': '-10.00', 'item-vat-amount': '-1.74', 'item-vat-excl-amount': '-8.26', 'shipping-vat-incl-amount': '', 'shipping-vat-amount': '', 'shipping-vat-excl-amount': '' });
  const r = await run(db, api, [half, replacement('Correction::X:2', 'Name One SL')]);
  assert.equal(api.calls.length, 0); assert.equal(r.creditNotes, 0); assert.ok(r.skipped.some(x => /differ/i.test(x.reason)));
  const f = finding(db, 'CORRECTION_PARTIAL_REVERSAL'); assert.equal(f.length, 1); assert.equal(f[0].status, 'OPEN'); assert.equal(f[0].severity, 'HOLD'); assert.equal(f[0].resolution, 'NEW_EVIDENCE');
  assert.throws(() => releaseIntegrity(db, seller.id, KEY, 'CORRECTION_PARTIAL_REVERSAL', f[0].fingerprint, { user: 'u', reason: 'trying to force it through' }), /new evidence|cannot/i);
  assert.equal(approveAllSafe(db), 0);
});
const approveAllSafe = (db) => db.prepare("SELECT count(*) c FROM integrity_findings WHERE status='RELEASED'").get().c;
test('R5: a repeated CorrectionReversal produces no additional credit note; credits never exceed the creditable balance (cumulative)', async () => {
  const { api, db } = await start(); await run(db, api, pair()); approveAll(db, seller.id); await run(db, api, pair());
  assert.equal(credits(db).length, 1);
  const again = [reversal('CorrectionReversal:X:3'), replacement('Correction::X:4', 'Name Two SL')];
  const r = await run(db, api, again); approveAllSafe(db);
  assert.equal(credits(db).length, 1, 'no second credit note'); assert.equal(api.calls.filter(c => c.documentType === 'CreditNote').length, 1);
  const f = finding(db, 'CORRECTION_EXCEEDS_BALANCE'); assert.equal(f.length, 1); assert.equal(f[0].resolution, 'NEW_EVIDENCE'); assert.equal(f[0].status, 'OPEN'); assert.ok(r.skipped.length >= 1);
  const total = credits(db).reduce((a, c) => a + Math.abs(c.total), 0); const orig = db.prepare("SELECT total FROM invoices WHERE kind='invoice'").get().total; assert.ok(total <= Math.abs(orig) + 0.005);
});
test('R6: the replacement waits for Amazon to accept the credit note (CreditNoteUploaded), and the same approval then covers it', async () => {
  const { api, db } = await start(); await run(db, api, pair()); approveAll(db, seller.id); await run(db, api, pair());
  const r1 = await run(db, api, pair()); assert.equal(r1.invoices, 0); assert.equal(api.calls.filter(c => c.documentType === 'Invoice').length, 0, 'credit note not yet accepted: no replacement');
  await accept(db, api, pair('Name One SL', 'CreditNoteUploaded'));
  const r2 = await run(db, api, pair('Name One SL', 'CreditNoteUploaded')); assert.equal(r2.invoices, 1); assert.equal(api.calls.filter(c => c.documentType === 'Invoice').length, 1, 'one replacement, no second approval needed');
  await run(db, api, pair('Name One SL', 'CreditNoteUploaded')); assert.equal(api.calls.filter(c => c.documentType === 'Invoice').length, 1);
});
test('R7: the approval is for the PAIR: replacement data changed after the credit note was issued is held, not issued', async () => {
  const { api, db } = await start(); await run(db, api, pair()); approveAll(db, seller.id); await run(db, api, pair());
  await accept(db, api, pair('Name One SL', 'CreditNoteUploaded'));
  const r = await run(db, api, pair('Changed After Approval SL', 'CreditNoteUploaded'));
  assert.equal(r.invoices, 0); assert.equal(api.calls.filter(c => c.documentType === 'Invoice').length, 0); assert.equal(finding(db)[0].status, 'OPEN');
});
