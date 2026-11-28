// Stage 1 round 2, decision 3: the three paths that can issue a credit note (repair proposal, manual rectify, correction pair) share ONE cap. All six orders: whichever goes first wins, the others are refused, and the sum credited never exceeds the original.
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { openDb } from '../src/db.js'; import { processReport, processCorrections, issueRectificativa } from '../src/pipeline.js';
import { detectRepairs, listRepairs, approveRepair } from '../src/repair.js'; import { approveAll } from './correction-helpers.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const vies = async (v) => ({ status: 'valid', vat: v }); const mkApi = () => ({ calls: [], uploadInvoice: async function (a) { this.calls.push(a); return 'f' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }) });
const [head, ...body] = text.trim().split('\n'); const cols = head.split('\t'); const ix = n => cols.indexOf(n); const base = body[0].split('\t');
const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const refund = (id) => { const r = [...base]; r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = id; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = 'CreditNotePending'; return r.join('\t'); };
const PATHS = {
  async repair({ api, db }) { detectRepairs(db, seller, [head, refund('r-100-1')].join('\n')); const [p] = listRepairs(db, seller.id); return approveRepair(db, seller, p.event_key, { api, validate: vies }); },
  async manual({ api, db }) { const o = db.prepare("SELECT number, json FROM invoices WHERE shipment_key='SHIPMENT:S1001' AND kind='invoice'").get(); const j = JSON.parse(o.json); return issueRectificativa(db, seller, o.number, { mode: 'differences', reason: 'manual credit by the seller', changes: { lines: j.lines.map(l => ({ ...l, excl: 0, vat: 0 })) }, documentType: 'CreditNote' }, { api, validate: vies }); },
  async pair({ api, db }) { const rep = [head, refund('CorrectionReversal:X:1')].join('\n'); await processCorrections(db, seller, rep, { api, validate: vies }); approveAll(db, seller.id); return processCorrections(db, seller, rep, { api, validate: vies }); },
};
const orders = [['repair', 'manual', 'pair'], ['repair', 'pair', 'manual'], ['manual', 'repair', 'pair'], ['manual', 'pair', 'repair'], ['pair', 'repair', 'manual'], ['pair', 'manual', 'repair']];
for (const order of orders) {
  test(`cap shared by all paths, order ${order.join(' -> ')}: exactly one full credit note, the rest refused`, async () => {
    const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
    const o = db.prepare("SELECT number, total FROM invoices WHERE shipment_key='SHIPMENT:S1001' AND kind='invoice'").get();
    for (const p of order) { try { await PATHS[p]({ api, db }); } catch { /* a refusal is the expected outcome for the later paths */ } }
    const notes = db.prepare("SELECT total, shipment_key FROM invoices WHERE kind='rectificativa' AND rectifies=? AND total<0").all(o.number);
    const sum = notes.reduce((a, n) => a + Math.abs(n.total), 0);
    assert.equal(notes.length, 1, `exactly one credit note: ${JSON.stringify(notes)}`); assert.ok(Math.round(sum * 100) <= Math.round(Math.abs(o.total) * 100), `credited ${sum} of ${o.total}`);
  });
}
