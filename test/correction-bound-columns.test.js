// Round 3, decision 1 (owner ruling Nov 28 2026): nine report columns are bound into the decision fingerprint, so changing any of them after approval voids the approval:
// fulfilled-by, order-date, recipient-name, buyer-name, sku, product-name, is-amazon-invoiced, is-business-order, citation-es.
// invoice-status is NOT bound (a lifecycle field: CreditNotePending -> CreditNoteUploaded is normal), and it must never open the Amazon-acceptance gate.
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js'; import { processReport, processCorrections } from '../src/pipeline.js'; import { approveAll } from './correction-helpers.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', country: 'ES', invoice_lang: 'auto' };
const vies = async (v) => ({ status: 'valid', vat: v }); const NOW = new Date('2026-11-24T12:00:00Z');
const [head0, ...body] = text.trim().split('\n'); const cols = head0.split('\t'); const ix = n => cols.indexOf(n); const base = body[0].split('\t');
const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const mkApi = () => ({ calls: [], uploadInvoice: async function (a) { this.calls.push(a); return 'f' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }) });
const reversal = () => { const r = [...base]; r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = 'CorrectionReversal:X:1'; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = 'CreditNotePending'; return r; };
const replacement = () => { const f = [...base]; f[ix('transaction-id')] = 'Correction::X:2'; f[ix('billing-name')] = 'Name One SL'; return f; };
const head = head0 + '\tinvoice-correction-details';
const report = (rv, rp) => [head, rv.join('\t') + '\tReason A', rp.join('\t') + '\tReason A'].join('\n');
const credits = (db) => db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND shipment_key LIKE 'REFUND:CorrectionReversal%'").get().c;
const fresh = async () => { const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: NOW }); await processCorrections(db, seller, report(reversal(), replacement()), { api, validate: vies }); assert.equal(approveAll(db, seller.id), 1); api.n0 = api.calls.length; return { api, db }; };
const mutate = (v) => /^-?\d+(\.\d+)?$/.test(v) ? String(Number(v) + 0.01) : (v === '' ? 'MUT' : v + ' MUT');
const BOUND = ['fulfilled-by', 'order-date', 'recipient-name', 'buyer-name', 'sku', 'product-name', 'is-amazon-invoiced', 'is-business-order', 'citation-es'];

test('control: an unchanged report issues the approved credit note', async () => {
  const { api, db } = await fresh(); const r = await processCorrections(db, seller, report(reversal(), replacement()), { api, validate: vies }); assert.equal(credits(db), 1); assert.equal(r.creditNotes, 1);
});
for (const c of BOUND) for (const which of ['reversal', 'replacement']) {
  test(`changing ${c} on the ${which} row after approval voids it (nothing issued, held for a new review)`, async () => {
    const { api, db } = await fresh(); const rv = reversal(), rp = replacement(), t = which === 'reversal' ? rv : rp; t[ix(c)] = mutate(t[ix(c)] ?? '');
    const r = await processCorrections(db, seller, report(rv, rp), { api, validate: vies });
    assert.equal(credits(db), 0, 'no credit note'); assert.equal(api.calls.length, api.n0, 'nothing uploaded after the approval'); assert.equal(r.creditNotes + r.invoices, 0);
    assert.ok(r.skipped.some(s => /review/i.test(s.reason)), 'the hold names the review: ' + JSON.stringify(r.skipped));
  });
}
test('invoice-status alone (both rows, any value) does not void the approval', async () => {
  const { api, db } = await fresh(); const rv = reversal(), rp = replacement(); rv[ix('invoice-status')] = 'CreditNoteUploaded'; rp[ix('invoice-status')] = 'CreditNoteUploaded';
  const r = await processCorrections(db, seller, report(rv, rp), { api, validate: vies }); assert.equal(credits(db), 1, 'the approved credit note issues'); assert.equal(r.creditNotes, 1);
});
test('invoice-status never opens the Amazon-acceptance gate: a report saying CreditNoteUploaded does not release the replacement before our credit note is confirmed uploaded', async () => {
  const { api, db } = await fresh(); const rv = reversal(), rp = replacement(); rv[ix('invoice-status')] = 'CreditNoteUploaded'; rp[ix('invoice-status')] = 'CreditNoteUploaded';
  const r = await processCorrections(db, seller, report(rv, rp), { api, validate: vies });
  assert.equal(r.invoices, 0, 'no replacement yet'); assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND shipment_key LIKE 'Correction%'").get().c, 0);
  assert.ok(r.skipped.some(s => /not yet confirmed accepted/.test(s.reason)), JSON.stringify(r.skipped));
  const again = await processCorrections(db, seller, report(rv, rp), { api, validate: vies }); assert.equal(again.invoices, 0, 'still no replacement while our credit note is not marked uploaded');
});
