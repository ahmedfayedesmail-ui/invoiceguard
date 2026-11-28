import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { processReport, processCorrections } from '../src/pipeline.js';

// Night mission follow-up B (owner list, Nov 28): independent review of the REFUND / CorrectionReversal path. The SHIPMENT rules are NOT assumed to apply. Each test states the invariant, and was run against the unfixed code first (audit/phase-b/pre-fix-run-12-refund-path.spec.txt).
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const vies = async (v) => ({ status: 'valid', vat: v });
const mkApi = () => { const calls = []; return { calls, uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) }; };
const [head, ...body] = text.trim().split('\n'); const cols = head.split('\t'); const ix = (n) => cols.indexOf(n); const base = body[0].split('\t');
const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const reversal = (id, over = null) => { const r = [...base]; r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = id; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = 'CreditNotePending'; if (over) for (const [k, v] of Object.entries(over)) r[ix(k)] = v; return r.join('\t'); };
const replacement = (id, name) => { const f = [...base]; f[ix('transaction-id')] = id; f[ix('billing-name')] = name; f[ix('is-invoice-corrected')] = undefined; return f.join('\t'); };
const NOW = new Date('2026-11-24T12:00:00Z');
const start = async () => { const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: NOW }); api.calls.length = 0; return { api, db }; };
const pass = (db, api, rows) => processCorrections(db, seller, [head, ...rows].join('\n'), { api, validate: vies });
const credits = (db) => db.prepare("SELECT number, total FROM invoices WHERE kind='rectificativa' AND shipment_key LIKE 'REFUND:CorrectionReversal%'").all();

test('B1: a CorrectionReversal whose amounts differ from the invoice it reverses is held, never issued as a full credit note', async () => {
  const { api, db } = await start(); const orig = db.prepare("SELECT total FROM invoices WHERE kind='invoice'").get().total;
  const half = reversal('CorrectionReversal:X:1', { 'item-vat-incl-amount': '-10.00', 'item-vat-amount': '-1.74', 'item-vat-excl-amount': '-8.26', 'shipping-vat-incl-amount': '', 'shipping-vat-amount': '', 'shipping-vat-excl-amount': '' });
  const r = await pass(db, api, [half]);
  assert.ok(orig > 10, 'the fixture invoice is larger than the reversal row');
  assert.equal(api.calls.length, 0, 'nothing uploaded: the row says 10.00, the credit note would say ' + orig); assert.equal(credits(db).length, 0); assert.equal(r.creditNotes, 0);
  assert.ok(r.skipped.some(x => /differ|amount/i.test(x.reason)), JSON.stringify(r.skipped));
});
test('B2: a second correction event for an invoice that already has an accepted credit note does not issue a second full credit note against the same original', async () => {
  const { api, db } = await start();
  const r1 = [reversal('CorrectionReversal:X:1'), replacement('Correction::X:2', 'Name One SL')];
  await pass(db, api, r1); await processReport(db, seller, [head, reversal('CorrectionReversal:X:1').replace('CreditNotePending', 'CreditNoteUploaded'), replacement('Correction::X:2', 'Name One SL')].join('\n'), { api, validate: vies, now: NOW }); await pass(db, api, r1);
  assert.equal(credits(db).length, 1, 'the first pair produced one credit note');
  const r2 = [reversal('CorrectionReversal:X:3'), replacement('Correction::X:4', 'Name Two SL')];
  const out = await pass(db, api, r2);
  assert.equal(credits(db).length, 1, 'a second event must not credit the same original again'); assert.equal(api.calls.filter(c => c.documentType === 'CreditNote').length, 1, 'one credit note uploaded in total'); assert.ok(out.skipped.length >= 1);
});
test('B3 guard: one normal correction pair still issues exactly one credit note and one replacement, and a repeated pass issues nothing more', async () => {
  const { api, db } = await start(); const rows = [reversal('CorrectionReversal:X:1'), replacement('Correction::X:2', 'Name One SL')];
  await pass(db, api, rows); await processReport(db, seller, [head, reversal('CorrectionReversal:X:1').replace('CreditNotePending', 'CreditNoteUploaded'), replacement('Correction::X:2', 'Name One SL')].join('\n'), { api, validate: vies, now: NOW });
  const o = await pass(db, api, rows); await pass(db, api, rows);
  assert.equal(credits(db).length, 1); assert.equal(api.calls.filter(c => c.documentType === 'CreditNote').length, 1); assert.equal(api.calls.filter(c => c.documentType === 'Invoice').length, 1); void o;
});
