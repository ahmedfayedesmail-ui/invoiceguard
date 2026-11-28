import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { processReport, processCorrections } from '../src/pipeline.js';
import { releaseIntegrity } from '../src/integrity.js';
import { CODE, approveAll } from './correction-helpers.js';

// Stage 1 round 2, decision 1 (Ahmed, Nov 28 2026): the snapshot the human approved must include the seller identity the document builder consumes and the VIES result used in the issuance decision. Failing first: audit/phase-b/pre-fix-run-17-snapshot-binding.spec.txt
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
const run = (db, api, rows, sel = seller, v = vies) => processCorrections(db, sel, [head, ...rows].join('\n'), { api, validate: v });
const accept = (db, api, rows) => processReport(db, seller, [head, ...rows].join('\n'), { api, validate: vies, now: NOW });
const KEY = 'CORRECTION:REFUND:CorrectionReversal:X:1';
const pair = (name = 'Name One SL', st = 'CreditNotePending') => [reversal('CorrectionReversal:X:1', null, st), replacement('Correction::X:2', name)];
const credits = (db) => db.prepare("SELECT number, total FROM invoices WHERE kind='rectificativa' AND shipment_key LIKE 'REFUND:CorrectionReversal%'").all();
const finding = (db, code = CODE) => db.prepare('SELECT * FROM integrity_findings WHERE code=?').all(code);


const approved = async () => { const { api, db } = await start(); await run(db, api, pair()); approveAll(db, seller.id); return { api, db }; };
for (const [label, patch] of [['legal name', { name: 'Other Name S.L.' }], ['VAT/NIF', { nif: 'B22222222' }], ['address', { address: 'Calle Otra 9, Sevilla' }], ['invoice language', { invoice_lang: 'en' }], ['seller country', { country: 'DE' }]]) {
  test(`S1 ${label}: a change of the seller's ${label} after approval voids the approval and nothing is issued`, async () => {
    const { api, db } = await approved();
    await run(db, api, pair(), { ...seller, ...patch });
    assert.equal(api.calls.length, 0, 'nothing may be issued on seller data nobody approved'); assert.equal(credits(db).length, 0);
    assert.equal(finding(db).filter(f => f.status === 'OPEN').length, 1, 'back to HOLD, a new decision is needed');
  });
}
test('S2: the VIES result used in the decision is part of the evidence: valid at approval, invalid later -> HOLD, nothing issued', async () => {
  const { api, db } = await approved();
  await run(db, api, pair(), seller, async (v) => ({ status: 'invalid', reason: 'not registered', vat: v }));
  assert.equal(api.calls.length, 0); assert.equal(credits(db).length, 0); assert.equal(finding(db).filter(f => f.status === 'OPEN').length, 1);
});
test('S3: VIES unavailable at the later pass is also a material difference (fails closed)', async () => {
  const { api, db } = await approved();
  await run(db, api, pair(), seller, async (v) => ({ status: 'unavailable', vat: v }));
  assert.equal(api.calls.length, 0); assert.equal(credits(db).length, 0);
});
test('S4: the evidence record holds canonical hashes of the seller snapshot, never the seller name, NIF or address', async () => {
  const { api, db } = await start(); await run(db, api, pair()); const raw = finding(db)[0].evidence;
  for (const pii of ['Tienda Demo', 'B11111111', 'Calle Falsa']) assert.ok(!raw.includes(pii), 'evidence must not carry ' + pii);
  const ev = JSON.parse(raw); assert.match(ev.sellerSnapshot?.sha256 ?? '', /^[0-9a-f]{64}$/, 'a seller snapshot hash is part of the evidence'); assert.ok(Array.isArray(ev.vies) && ev.vies.length >= 1 && 'status' in ev.vies[0], 'the VIES status per buyer VAT is part of the evidence');
});
test('S5 guard: nothing changed after approval -> exactly one credit note as before', async () => {
  const { api, db } = await approved(); await run(db, api, pair());
  assert.equal(credits(db).length, 1);
});
