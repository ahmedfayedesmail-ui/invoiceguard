// Found by the adversarial generator (prototype/adversarial): the review balance and the approved evidence only saw credit notes of CorrectionReversal events. A manual or repair credit note on the same original was invisible on the card (the issue-time cap still refused later). The person must see every credit note on the original. Failing first: audit/phase-b/pre-fix-run-19-balance-visibility.spec.txt
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { openDb } from '../src/db.js'; import { processReport, processCorrections, issueRectificativa } from '../src/pipeline.js'; import { approveAll } from './correction-helpers.js'; import { detectRepairs, listRepairs, approveRepair } from '../src/repair.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const vies = async (v) => ({ status: 'valid', vat: v }); const mkApi = () => ({ calls: [], uploadInvoice: async function (a) { this.calls.push(a); return 'f' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }) });
const [head, ...body] = text.trim().split('\n'); const cols = head.split('\t'); const ix = n => cols.indexOf(n); const base = body[0].split('\t');
const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const rv = (() => { const r = [...base]; r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = 'CorrectionReversal:X:1'; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = 'CreditNotePending'; return r.join('\t'); })();
const rp = (() => { const f = [...base]; f[ix('transaction-id')] = 'Correction::X:2'; f[ix('billing-name')] = 'Name One SL'; return f.join('\t'); })();
const REPORT = [head, rv, rp].join('\n');
test('B1: a manual credit note on the original is part of the review evidence and voids an earlier approval', async () => {
  const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  await processCorrections(db, seller, REPORT, { api, validate: vies }); approveAll(db, seller.id);
  const o = db.prepare("SELECT number, json FROM invoices WHERE shipment_key='SHIPMENT:S1001' AND kind='invoice'").get(); const j = JSON.parse(o.json);
  await issueRectificativa(db, seller, o.number, { mode: 'differences', reason: 'manual partial credit', changes: { lines: j.lines.map(l => ({ ...l, excl: Math.round(l.excl * 50) / 100, vat: Math.round(l.vat * 50) / 100 })) }, documentType: 'CreditNote' }, { api, validate: vies });
  const n0 = api.calls.length; await processCorrections(db, seller, REPORT, { api, validate: vies });
  assert.equal(api.calls.length - n0, 0, 'nothing issued');
  const f = db.prepare("SELECT code, status, evidence FROM integrity_findings WHERE shipment_key='CORRECTION:REFUND:CorrectionReversal:X:1' AND status='OPEN'").all();
  assert.equal(f.length, 1, 'back to an open finding'); const ev = JSON.parse(f[0].evidence); assert.ok(ev.amounts.cumulativeCredited > 0, 'the card shows the manual credit as already credited'); assert.equal(f[0].code, 'CORRECTION_EXCEEDS_BALANCE', 'a full reversal no longer fits the balance: new evidence needed, not approvable');
  assert.equal(db.prepare('SELECT count(*) c FROM credit_claims').get().c, 0, 'no claim was reserved for a reversal that cannot be issued');
});

// Round 3, decision 4 (owner ruling Nov 28 2026): the repair path too. B1 above stays as the manual-path case.
test('B2: a credit note issued by the REPAIR path on the original is part of the review evidence, shown as credited, and voids an earlier approval (nothing issued, no claim reserved)', async () => {
  const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  await processCorrections(db, seller, REPORT, { api, validate: vies }); approveAll(db, seller.id);
  const o = db.prepare("SELECT number, total FROM invoices WHERE shipment_key='SHIPMENT:S1001' AND kind='invoice'").get();
  const refund = (() => { const r = [...base]; r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = 'r-100-1'; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = 'CreditNotePending'; return r.join('\t'); })();
  detectRepairs(db, seller, [head, refund].join('\n')); const [p] = listRepairs(db, seller.id); await approveRepair(db, seller, p.event_key, { api, validate: vies });
  const repairNote = db.prepare("SELECT number, total, shipment_key FROM invoices WHERE kind='rectificativa' AND rectifies=? AND total<0").all(o.number); assert.equal(repairNote.length, 1, 'the repair issued its credit note'); assert.ok(!repairNote[0].shipment_key.includes('CorrectionReversal'), 'it is not a correction-pair document');
  const n0 = api.calls.length; await processCorrections(db, seller, REPORT, { api, validate: vies });
  assert.equal(api.calls.length - n0, 0, 'nothing issued');
  const f = db.prepare("SELECT code, evidence FROM integrity_findings WHERE shipment_key='CORRECTION:REFUND:CorrectionReversal:X:1' AND status='OPEN'").all(); assert.equal(f.length, 1, 'back to an open finding');
  const ev = JSON.parse(f[0].evidence); assert.equal(Math.round(ev.amounts.cumulativeCredited * 100), Math.round(Math.abs(o.total) * 100), 'the card shows the repair credit note as already credited'); assert.ok(ev.otherCreditNotes.includes(repairNote[0].number), 'and names it');
  assert.equal(f[0].code, 'CORRECTION_EXCEEDS_BALANCE', 'the full approval is refused when the balance is gone'); assert.equal(db.prepare('SELECT count(*) c FROM credit_claims').get().c, 0);
});
