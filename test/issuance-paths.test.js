import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { processReport, processCorrections as processCorrectionsRaw } from '../src/pipeline.js';
import { withApproval, acceptReport } from './correction-helpers.js';
const processCorrections = withApproval(processCorrectionsRaw); // owner decision Nov 28: a person approves the pair first (older tests, assertions unchanged)

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
  await acceptReport(db, seller, rep.replace('CreditNotePending', 'CreditNoteUploaded'), { api, validate: vies });
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

// ---- WP1 continued: paths that change a status must not become a way around the gate ----
const bad = () => { const [h, ...r] = text.trim().split('\n'); const c = h.split('\t'); const row = r[0].split('\t'); row[c.indexOf('item-vat-incl-amount')] = '1,234'; return [h, row.join('\t')].join('\n'); };
test('WP1: /api/retry and /api/release only reset the status; the next evaluation holds an integrity-held shipment again and nothing is issued', async () => {
  const api = mkApi(), db = openDb(), rep = bad(); const o1 = await processReport(db, seller, rep, { api, validate: vies });
  assert.equal(o1.held.length, 1); const key = o1.held[0].key;
  db.prepare("UPDATE shipments SET status='detected', reason=NULL WHERE seller_id=? AND key=?").run(seller.id, key); // exactly what /api/retry and /api/release do
  const o2 = await processReport(db, seller, rep, { api, validate: vies }); assert.equal(o2.held.length, 1); assert.equal(api.calls.length, 0, 'nothing uploaded');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices").get().c, 0, 'no invoice number was used');
  assert.equal(db.prepare("SELECT count(*) c FROM integrity_findings WHERE code='AMOUNT_UNREADABLE' OR code LIKE 'AMOUNT_%'").get().c >= 1, true);
});
test('WP1: two evaluations of the same good report running at the same time create exactly what one evaluation creates', async () => {
  const api = mkApi(); let release; const gateOpen = new Promise(r => { release = r; }); const slow = { ...api, uploadInvoice: async (a) => { api.calls.push(a); await gateOpen; return 'f' + api.calls.length; } };
  const baseApi = mkApi(), baseDb = openDb(); await processReport(baseDb, seller, text, { api: baseApi, validate: vies }); const N = baseApi.calls.length; assert.ok(N >= 1);
  const db = openDb(); const p1 = processReport(db, seller, text, { api: slow, validate: vies }), p2 = processReport(db, seller, text, { api: slow, validate: vies });
  await new Promise(r => setTimeout(r, 50)); release(); await Promise.all([p1, p2]);
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='invoice'").get().c, N, 'same invoices as one evaluation'); assert.equal(api.calls.length, N, 'same uploads as one evaluation');
});
