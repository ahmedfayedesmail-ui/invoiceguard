import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { processReport, processCorrections } from '../src/pipeline.js';

// Night mission WP1: issuance path audit. Regression tests written BEFORE the fix (see audit/phase-b/pre-fix-run-7-wp1-correction-gate.spec.txt).
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const vies = async (v) => ({ status: 'valid', vat: v });
const mkApi = () => { const calls = []; return { calls, uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) }; };
function correctionReport(names) {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n); const row = rows[0].split('\t');
  const rev = [...row]; rev[ix('transaction-type')] = 'REFUND'; rev[ix('transaction-id')] = 'CorrectionReversal:X:1';
  ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { rev[ix(n)] = '-' + rev[ix(n)]; }); rev[ix('invoice-status')] = 'CreditNotePending';
  const mk = (name, item) => { const f = [...row]; f[ix('transaction-id')] = 'Correction::X:2'; f[ix('billing-name')] = name; if (item) f[ix('order-item-id')] = item; f[ix('is-invoice-corrected')] = undefined; return f.join('\t'); };
  return [head, rev.join('\t'), ...names.map((n, i) => mk(n, names.length > 1 ? String(9001 + i) : null))].join('\n');
}
async function flow(names) {
  const api = mkApi(), db = openDb(), rep = correctionReport(names);
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  await processCorrections(db, seller, rep, { api, validate: vies });
  await processReport(db, seller, rep.replace('CreditNotePending', 'CreditNoteUploaded'), { api, validate: vies });
  const r2 = await processCorrections(db, seller, rep, { api, validate: vies });
  return { api, db, r2, rep };
}
test('WP1: a correction whose rows contradict each other on the buyer name issues NO replacement invoice and writes the ledger', async () => {
  const { api, db, r2 } = await flow(['Name One SL', 'Name Two SL']);
  assert.equal(r2.invoices, 0, 'no replacement was issued'); assert.equal(api.calls.filter(c => c.transactionId === 'Correction::X:2').length, 0, 'nothing was uploaded for the replacement');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND shipment_key LIKE 'SHIPMENT:Correction%'").get().c, 0);
  const f = db.prepare("SELECT status, severity FROM integrity_findings WHERE code='SHIPMENT_FIELD_CONFLICT' AND field='billing-name'").all(); assert.equal(f.length, 1); assert.equal(f[0].severity, 'BLOCK');
  assert.ok(r2.skipped.some(x => /disagree on billing-name/.test(x.reason)));
  await processCorrections(db, seller, flowRep(), { api, validate: vies }); assert.equal(api.calls.filter(c => c.transactionId === 'Correction::X:2').length, 0, 'a second pass changes nothing');
  assert.equal(db.prepare("SELECT count(*) c FROM integrity_findings WHERE code='SHIPMENT_FIELD_CONFLICT'").get().c, 1, 'no duplicate ledger record');
});
function flowRep() { return correctionReport(['Name One SL', 'Name Two SL']); }
test('WP1: a consistent correction still issues exactly one replacement (guard: the gate does not block the normal path)', async () => {
  const { api, r2 } = await flow(['Name One SL']);
  assert.equal(r2.invoices, 1); assert.equal(api.calls.filter(c => c.transactionId === 'Correction::X:2').length, 1);
});
