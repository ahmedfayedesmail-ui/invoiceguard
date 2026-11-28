// Stage 1 final review (Nov 28 2026), questions 4 and 5: the credit cap must hold across EVERY path that can issue a credit note (correction pair, repair proposal, manual /api/rectify), not only inside processCorrections. Failing first: audit/phase-b/pre-fix-run-15-global-credit-cap.spec.txt
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { processReport, processCorrections, issueRectificativa } from '../src/pipeline.js';
import { approveAll } from './correction-helpers.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const vies = async (v) => ({ status: 'valid', vat: v });
const mkApi = () => { const calls = []; return { calls, uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) }; };
const [head, ...body] = text.trim().split('\n'); const cols = head.split('\t'); const ix = (n) => cols.indexOf(n); const base = body[0].split('\t');
const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const rev = () => { const r = [...base]; r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = 'CorrectionReversal:X:1'; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = 'CreditNotePending'; return r.join('\t'); };
test('G1: an already fully credited original (manual credit note) cannot receive a correction credit note on top', async () => {
  const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const o = db.prepare("SELECT number, json FROM invoices WHERE kind='invoice'").get(); const j = JSON.parse(o.json);
  await issueRectificativa(db, seller, o.number, { mode: 'differences', reason: 'manual credit', changes: { lines: j.lines.map(l => ({ ...l, excl: 0, vat: 0 })) }, documentType: 'CreditNote' }, { api, validate: vies });
  const n0 = api.calls.length;
  const rep = [head, rev()].join('\n');
  await processCorrections(db, seller, rep, { api, validate: vies }); approveAll(db, seller.id); await processCorrections(db, seller, rep, { api, validate: vies });
  const notes = db.prepare("SELECT number,total,shipment_key FROM invoices WHERE kind='rectificativa'").all();
  assert.ok(api.calls.length - n0 === 0, 'second full credit note issued on an already fully credited original');
});
test('G2: a manual credit note on an original that the correction pair already credited in full is refused', async () => {
  const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const rep = [head, rev()].join('\n'); await processCorrections(db, seller, rep, { api, validate: vies }); approveAll(db, seller.id); await processCorrections(db, seller, rep, { api, validate: vies });
  const o = db.prepare("SELECT number, json FROM invoices WHERE kind='invoice'").get(); const j = JSON.parse(o.json); const n0 = api.calls.length; let err = null;
  try { await issueRectificativa(db, seller, o.number, { mode: 'differences', reason: 'manual credit', changes: { lines: j.lines.map(l => ({ ...l, excl: 0, vat: 0 })) }, documentType: 'CreditNote' }, { api, validate: vies }); } catch (e) { err = e.message; }
  assert.ok(err || api.calls.length - n0 === 0, 'second full credit note issued manually');
});

test('G3: partial credit notes from different paths add up: the sum can never exceed the original', async () => {
  const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const o = db.prepare("SELECT number, json FROM invoices WHERE kind='invoice'").get(); const j = JSON.parse(o.json);
  const half = (f) => j.lines.map(l => ({ ...l, excl: Math.round(l.excl * f * 100) / 100, vat: Math.round(l.vat * f * 100) / 100 }));
  const issue = (lines, reason) => issueRectificativa(db, seller, o.number, { mode: 'differences', reason, changes: { lines }, documentType: 'CreditNote' }, { api, validate: vies });
  await issue(half(0.5), 'first partial manual credit'); // credits half the original
  await assert.rejects(() => issue(j.lines.map(l => ({ ...l, excl: 0, vat: 0 })), 'then a full one'), /more than|exceed/i, 'half + full is more than the invoice');
  const sum = db.prepare("SELECT total FROM invoices WHERE kind='rectificativa'").all().reduce((a, r) => a + Math.abs(r.total), 0);
  assert.ok(sum <= Math.abs(JSON.parse(o.json).totals.incl) + 0.005, 'credited ' + sum);
});
