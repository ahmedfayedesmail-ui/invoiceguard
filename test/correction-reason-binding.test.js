// Stage 1 final review Q3: the correction reason printed on the credit note / replacement (invoice-correction-details) must be part of the evidence the human approved. Changing it after approval voids the approval.
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { openDb } from '../src/db.js'; import { processReport, processCorrections } from '../src/pipeline.js'; import { approveAll } from './correction-helpers.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const [head0, ...body] = text.trim().split('\n'); const head = head0 + '\tinvoice-correction-details'; const cols = head0.split('\t'); const ix = n => cols.indexOf(n); const base = body[0].split('\t');
const AMT = ['item-vat-incl-amount','item-vat-amount','item-vat-excl-amount','shipping-vat-incl-amount','shipping-vat-amount','shipping-vat-excl-amount'];
const mk = (details) => { const r = [...base]; r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = 'CorrectionReversal:X:1'; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = 'CreditNotePending'; return [head, r.join('\t') + '\t' + details].join('\n'); };
test('Q3: changing the correction reason after approval voids the approval', async () => {
  const api = { calls: [], uploadInvoice: async function (a) { api.calls.push(a); return 'f'; }, feedStatus: async () => ({ status: 'DONE' }) }; const validate = async v => ({ status: 'valid', vat: v });
  const db = openDb(); await processReport(db, seller, text, { api, validate, now: new Date('2026-11-24T12:00:00Z') });
  await processCorrections(db, seller, mk('Reason A'), { api, validate }); approveAll(db, seller.id);
  const n0 = api.calls.length;
  await processCorrections(db, seller, mk('Reason B changed after approval'), { api, validate });
  assert.equal(api.calls.length - n0, 0, 'nothing may be issued with a reason nobody approved');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa'").get().c, 0);
});
test('Q3 guard: the same reason after approval still issues', async () => {
  const api = { calls: [], uploadInvoice: async function (a) { api.calls.push(a); return 'f'; }, feedStatus: async () => ({ status: 'DONE' }) }; const validate = async v => ({ status: 'valid', vat: v });
  const db = openDb(); await processReport(db, seller, text, { api, validate, now: new Date('2026-11-24T12:00:00Z') });
  await processCorrections(db, seller, mk('Reason A'), { api, validate }); approveAll(db, seller.id);
  await processCorrections(db, seller, mk('Reason A'), { api, validate });
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa'").get().c >= 1, true);
});
