// PROTOTYPE (own branch, tests only, no production change): adversarial mutation generator.
// For an APPROVED correction pair it mutates, one at a time, every report column of the reversal row and of the replacement row, every live seller field, the VIES answer and the DB state the document builder reads, then runs the next pass.
// Expectation: nothing is issued after a material mutation. It prints every mutation that did NOT void the approval, so a person classifies it as non-material (with a reason) or as a gap.
// Run: node --test prototype/adversarial/mutate-after-approval.test.js
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { openDb } from '../../src/db.js'; import { processReport, processCorrections } from '../../src/pipeline.js'; import { approveAll } from '../../test/correction-helpers.js';
const text = readFileSync(new URL('../../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', country: 'ES', invoice_lang: 'auto' };
const vies = async (v) => ({ status: 'valid', vat: v }); const NOW = new Date('2026-11-24T12:00:00Z');
const [head0, ...body] = text.trim().split('\n'); const cols = head0.split('\t'); const ix = n => cols.indexOf(n); const base = body[0].split('\t');
const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const mkApi = () => ({ calls: [], uploadInvoice: async function (a) { this.calls.push(a); return 'f' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }) });
const reversal = () => { const r = [...base]; r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = 'CorrectionReversal:X:1'; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = 'CreditNotePending'; return r; };
const replacement = () => { const f = [...base]; f[ix('transaction-id')] = 'Correction::X:2'; f[ix('billing-name')] = 'Name One SL'; return f; };
const head = head0 + '\tinvoice-correction-details';
const report = (rv, rp) => [head, rv.join('\t') + '\tReason A', rp.join('\t') + '\tReason A'].join('\n');
// only documents the CORRECTION flow created count as issued (a row the mutation itself inserted must not count)
const nCredits = (db) => db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND (shipment_key LIKE 'REFUND:CorrectionReversal%' OR shipment_key LIKE 'Correction%' OR shipment_key LIKE 'SHIPMENT:Correction%')").get().c;
const fresh = async () => { const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: NOW }); await processCorrections(db, seller, report(reversal(), replacement()), { api, validate: vies }); approveAll(db, seller.id); return { api, db }; };
const mutate = (v) => /^-?\d+(\.\d+)?$/.test(v) ? String(Number(v) + 0.01) : (v === '' ? 'MUT' : v + ' MUT');
const unvoided = [];
async function attempt(label, fn) { const { api, db } = await fresh(); const n0 = api.calls.length; await fn({ api, db }); const issued = nCredits(db) > 0 || api.calls.length > n0; if (issued) unvoided.push(label); return issued; }
test('control: nothing mutated -> the approved pair issues', async () => { assert.equal(await attempt('control', async ({ api, db }) => processCorrections(db, seller, report(reversal(), replacement()), { api, validate: vies })), true); unvoided.pop(); });
test('mutating any report column of the reversal row or the replacement row after approval', { timeout: 100000 }, async () => {
  for (const c of cols) for (const which of ['reversal', 'replacement']) {
    await attempt(`${which} row column "${c}"`, async ({ api, db }) => { const rv = reversal(), rp = replacement(); const t = which === 'reversal' ? rv : rp; t[ix(c)] = mutate(t[ix(c)] ?? ''); await processCorrections(db, seller, report(rv, rp), { api, validate: vies }); });
  }
});
test('mutating each live seller field, the VIES answer and the correction reason', async () => {
  for (const [k, v] of [['name', 'Other S.L.'], ['nif', 'B22222222'], ['address', 'Other 1'], ['country', 'DE'], ['invoice_lang', 'en']]) await attempt(`seller.${k}`, async ({ api, db }) => processCorrections(db, { ...seller, [k]: v }, report(reversal(), replacement()), { api, validate: vies }));
  await attempt('VIES invalid', async ({ api, db }) => processCorrections(db, seller, report(reversal(), replacement()), { api, validate: async (x) => ({ status: 'invalid', vat: x }) }));
  await attempt('VIES unavailable', async ({ api, db }) => processCorrections(db, seller, report(reversal(), replacement()), { api, validate: async (x) => ({ status: 'unavailable', vat: x }) }));
  await attempt('correction reason text', async ({ api, db }) => processCorrections(db, seller, report(reversal(), replacement()).replaceAll('Reason A', 'Reason B'), { api, validate: vies }));
});
test('mutating the database state the builder reads: stored original, extra credit note, extra claim', async () => {
  await attempt('stored original json (a line amount)', async ({ api, db }) => { const o = db.prepare("SELECT number, json FROM invoices WHERE kind='invoice' AND shipment_key='SHIPMENT:S1001'").get(); const j = JSON.parse(o.json); j.lines[0].unitExcl += 1; db.prepare('UPDATE invoices SET json=? WHERE number=?').run(JSON.stringify(j), o.number); await processCorrections(db, seller, report(reversal(), replacement()), { api, validate: vies }); });
  await attempt('stored original json (seller block)', async ({ api, db }) => { const o = db.prepare("SELECT number, json FROM invoices WHERE kind='invoice' AND shipment_key='SHIPMENT:S1001'").get(); const j = JSON.parse(o.json); j.seller.name = 'Changed'; db.prepare('UPDATE invoices SET json=? WHERE number=?').run(JSON.stringify(j), o.number); await processCorrections(db, seller, report(reversal(), replacement()), { api, validate: vies }); });
  await attempt('another credit note on the original', async ({ api, db }) => { const o = db.prepare("SELECT number FROM invoices WHERE kind='invoice' AND shipment_key='SHIPMENT:S1001'").get(); db.prepare("INSERT INTO invoices (seller_id,number,shipment_key,kind,rectifies,issued_at,total,vat,json,feed_id,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(seller.id, 'R-2026-000500', 'SHIPMENT:S1001', 'rectificativa', o.number, new Date().toISOString(), -5, -0.9, '{}', null, 'submitted'); await processCorrections(db, seller, report(reversal(), replacement()), { api, validate: vies }); });
  await attempt('an open claim of another event', async ({ api, db }) => { const o = db.prepare("SELECT number FROM invoices WHERE kind='invoice' AND shipment_key='SHIPMENT:S1001'").get(); db.prepare('INSERT INTO credit_claims (seller_id, original_number, reversal_key, amount, claimed_at) VALUES (?,?,?,?,?)').run(seller.id, o.number, 'REFUND:CorrectionReversal:OTHER:1', 10, new Date().toISOString()); await processCorrections(db, seller, report(reversal(), replacement()), { api, validate: vies }); });
});
test('REPORT: every mutation that did NOT void the approval (classify each: non-material with a reason, or a gap)', () => {
  console.log('ADVERSARIAL unvoided=' + unvoided.length + '\n' + unvoided.map(x => '  - ' + x).join('\n'));
  assert.ok(true);
});
