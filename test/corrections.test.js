import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, verifyAudit } from '../src/db.js';
import { processReport, processCorrections, explain } from '../src/pipeline.js';

const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const calls = []; const api = { uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) };
const vies = async (v) => ({ status: 'valid', vat: v });

function correctionReport() {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const row = rows[0].split('\t');
  const rev = [...row]; rev[ix('transaction-type')] = 'REFUND'; rev[ix('transaction-id')] = 'CorrectionReversal:X:1';
  ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { rev[ix(n)] = '-' + rev[ix(n)]; });
  rev[ix('invoice-status')] = 'CreditNotePending';
  const fixed = [...row]; fixed[ix('transaction-id')] = 'Correction::X:2'; fixed[ix('billing-name')] = 'Mediterránea Logística Norte S.L.'; fixed[ix('is-invoice-corrected')] = undefined;
  return [head, rev.join('\t'), fixed.join('\t')].join('\n');
}

test('Amazon billing-data correction: credit note + new invoice, both with transaction IDs, no double processing', async () => {
  const db = openDb();
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const before = calls.length; const rep = correctionReport();
  const r = await processCorrections(db, seller, rep, { api, validate: vies });
  assert.deepEqual([r.creditNotes, r.invoices, r.errors.length], [1, 1, 0], JSON.stringify(r));
  const cn = calls[before], inv = calls[before + 1];
  assert.equal(cn.documentType, 'CreditNote'); assert.equal(cn.transactionId, 'CorrectionReversal:X:1'); assert.equal(cn.total, 54.45);
  assert.equal(inv.documentType, 'Invoice'); assert.equal(inv.transactionId, 'Correction::X:2'); assert.equal(inv.total, 54.45);
  const again = await processCorrections(db, seller, rep, { api, validate: vies }); assert.equal(calls.length, before + 2, 'idempotent');
  // the correction rows must not be treated as new normal invoices
  const out = await processReport(db, seller, rep, { api, validate: vies }); assert.equal(out.detected, 0);
});

test('audit chain verifies, and detects a tampered invoice', async () => {
  const db = openDb(); await processReport(db, seller, text, { api, validate: vies });
  assert.deepEqual(verifyAudit(db, 'sel1'), { ok: true });
  const j = JSON.parse(db.prepare('SELECT json FROM invoices LIMIT 1').get().json); j.totals.incl = 1;
  db.prepare('UPDATE invoices SET json=? WHERE number=?').run(JSON.stringify(j), 'A-2026-000001');
  assert.equal(verifyAudit(db, 'sel1').ok, false);
});

test('Amazon closed-beta error is explained in plain words', () => {
  assert.match(explain('SP-API ... FeatureNotAvailable 79509'), /I will upload my own VAT invoices/);
});
