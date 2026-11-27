// Row integrity (Ahmed, WhatsApp 2026-11-27 20:21, after CI found 139 campaign failures from dc24429). Synthetic data only. Local.
// A raw newline inside a text cell (billing-name, buyer-company-name, ...) splits one report row into physical lines. Each piece must be rejected as an invalid row:
// it is never a shipment, never produces an invoice or a HOLD card, and processing does not throw. The check is derived from the file's own header:
// a row is complete when it has exactly the header's cell count, or fewer cells where every missing cell is a trailing optional column (citation-en, citation-es), for example a trailing tab removed by an editor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVidr } from '../src/vidr.js';
import { openDb } from '../src/db.js';
import { processReport } from '../src/pipeline.js';
import { planUpload } from '../src/manual.js';

const FX = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8').trim().split('\n');
// n data rows of the committed 38-column fixture, one shipment each (distinct shipping and transaction ids), every row a business order not invoiced by Amazon, status InvoicePending.
const mk = (n = 1) => { const h = FX[0].split('\t'); const ix = (k) => h.indexOf(k); const rows = [];
  for (let i = 0; i < n; i++) { const c = FX[1].split('\t'); while (c.length < h.length) c.push(''); c[ix('shipping-id')] = 'S' + (1001 + i); c[ix('transaction-id')] = 'S' + (1001 + i); c[ix('order-id')] = `405-33188${i}2-7710365`; c[ix('is-business-order')] = 'TRUE'; c[ix('is-amazon-invoiced')] = 'FALSE'; c[ix('invoice-status')] = 'InvoicePending'; rows.push(c.join('\t')); }
  return [FX[0], ...rows].join('\n') + '\n'; };
const head = () => mk().split('\n')[0].split('\t');
const col = (name) => head().indexOf(name);
const setCols = (text, o, line = 1) => text.split('\n').map((l, k) => { if (k !== line) return l; const c = l.split('\t'); for (const [n, v] of Object.entries(o)) c[col(n)] = v; return c.join('\t'); }).join('\n');
const SELLER = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const api = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }) };
const vies = async (v) => ({ status: 'valid', vat: v });
const run = async (text) => { const db = openDb(); const out = await processReport(db, SELLER, text, { api, validate: vies, now: new Date('2026-11-25T13:00:00Z') }); return { db, out }; };
const count = (db, sql) => db.prepare(sql).get().c;

for (const colName of ['billing-name', 'buyer-company-name', 'buyer-name', 'recipient-name']) {
  test(`newline inside ${colName}: both pieces are invalid rows, no shipment, no hold card, no invoice, no throw`, async () => {
    const text = setCols(mk(), { [colName]: 'Empresa\nConSalto' });
    const v = parseVidr(text);
    assert.equal(v.length, 0, 'no shipment is built from either piece');
    assert.equal(v.invalidRows.length, 2, JSON.stringify(v.invalidRows));
    for (const r of v.invalidRows) { assert.equal(typeof r.line, 'number'); assert.ok(r.cells < head().length); assert.ok(r.missing.length > 0); }
    const { db, out } = await run(text);
    assert.equal(out.errors.length, 0); assert.equal(out.uploaded, 0); assert.equal(out.held.length, 0, 'no phantom HOLD'); assert.equal(out.detected, 0);
    assert.equal(out.invalidRows.length, 2);
    assert.equal(count(db, 'SELECT count(*) c FROM shipments'), 0); assert.equal(count(db, 'SELECT count(*) c FROM invoices'), 0);
    const p = planUpload(text);
    assert.equal(p.shipments.length, 0); assert.equal(p.held.length, 0);
  });
}
test('the first piece keeps order-id, shipping-id and shipment-date (billing-name is column after them) and is STILL rejected: the check is on missing required cells, not on IDs or dates', () => {
  const text = setCols(mk(), { 'billing-name': 'Empresa\nConSalto' });
  const first = text.split('\n')[1].split('\t');
  assert.ok(first[col('order-id')] && first[col('shipping-id')] && first[col('shipment-date')], 'IDs and date are intact in the first piece');
  assert.ok(first.length < head().length);
  assert.equal(parseVidr(text).length, 0);
});
test('garbage input: no shipment, no throw, no stored row', async () => {
  const { db, out } = await run('this is not a report at all\nrandom text\n');
  assert.equal(out.errors.length, 0); assert.equal(out.held.length, 0); assert.equal(out.uploaded, 0);
  assert.equal(count(db, 'SELECT count(*) c FROM shipments'), 0);
});
test('a healthy row with an unknown flag is still HELD, next to broken rows and a healthy issuable row', async () => {
  let text = mk(3);
  text = setCols(text, { 'is-business-order': '', 'is-amazon-invoiced': '' }, 1); // healthy, unknown flags
  text = setCols(text, { 'billing-name': 'Empresa\nConSalto' }, 2);              // broken
  const { db, out } = await run(text);
  assert.equal(out.errors.length, 0);
  assert.equal(out.held.length, 1, JSON.stringify(out.held)); assert.match(out.held[0].reason, /is-business-order/);
  assert.equal(out.invalidRows.length, 2);
  assert.equal(count(db, "SELECT count(*) c FROM shipments WHERE status='held'"), 1);
});
test('tolerance: a trailing empty optional cell removed by an editor (citation-es) is NOT rejected', () => {
  const t = mk();
  const lines = t.trim().split('\n'); // trim() removes the trailing tab of the last line
  const fixture = lines.join('\n') + '\n';
  const v = parseVidr(fixture);
  assert.equal(v.length, 1); assert.equal(v.invalidRows.length, 0);
});
test('rejected: a row missing a required cell at the end (buyer-tax-registration-type) or with an extra cell', () => {
  const t = mk(); const c = t.split('\n')[1].split('\t');
  const short = [t.split('\n')[0], c.slice(0, col('buyer-tax-registration-type')).join('\t')].join('\n');
  assert.equal(parseVidr(short).length, 0); assert.equal(parseVidr(short).invalidRows.length, 1);
  const long = [t.split('\n')[0], c.join('\t') + '\textra'].join('\n');
  assert.equal(parseVidr(long).length, 0); assert.equal(parseVidr(long).invalidRows.length, 1);
});
test('a healthy report has no invalid rows and its shipments are unchanged', () => {
  const v = parseVidr(mk(3)); assert.equal(v.length, 3); assert.equal(v.invalidRows.length, 0);
});
