// Row integrity, the known limit (Ahmed, WhatsApp 2026-11-27 20:42). Synthetic data only. Local.
// A newline inside the LAST required cell (buyer-tax-registration-type) or inside citation-es leaves a first piece whose cell count already looks complete (37 or 38 of 38).
// A cell count alone cannot see that. What the format does show: the second piece is a short line that cannot start a row. Rule (deterministic, no guessing): when an unreadable short line directly follows an accepted row,
// and joining the two (last cell of the row + newline + first cell of the line, then the rest) gives EXACTLY a complete row, that is one row split by a newline, so BOTH are quarantined. The row is never repaired.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVidr } from '../src/vidr.js';
import { parseTable, planUpload } from '../src/manual.js';
import { openDb } from '../src/db.js';
import { processReport } from '../src/pipeline.js';

const FX = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8').trim().split('\n');
const H = FX[0].split('\t'); const ix = (k) => H.indexOf(k);
const mk = (n) => { const rows = []; for (let i = 0; i < n; i++) { const c = FX[1].split('\t'); while (c.length < H.length) c.push(''); c[ix('shipping-id')] = 'S' + (1001 + i); c[ix('transaction-id')] = 'S' + (1001 + i); c[ix('order-id')] = `405-33188${i}2-7710365`; c[ix('is-business-order')] = 'TRUE'; c[ix('is-amazon-invoiced')] = 'FALSE'; c[ix('invoice-status')] = 'InvoicePending'; rows.push(c); } return rows; };
const text = (rows, trimTail = false) => [FX[0], ...rows.map(c => c.join('\t'))].join('\n') + '\n';
const split = (rows, k, col) => rows.map((c, i) => i === k ? c.map((v, j) => j === ix(col) ? 'AB\nCD' : v) : c);
const SELLER = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const api = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }) };
const vies = async (v) => ({ status: 'valid', vat: v });
const keys = (v) => v.map(s => s.shippingId).sort();

for (const col of ['buyer-tax-registration-type', 'citation-es']) {
  test(`newline inside ${col}: the row and its fragment are both quarantined, the rows around it are untouched`, async () => {
    const t = text(split(mk(3), 1, col));
    const v = parseVidr(t);
    assert.deepEqual(keys(v), ['S1001', 'S1003']);
    assert.equal(v.invalidRows.length, 2, JSON.stringify(v.invalidRows));
    assert.ok(v.invalidRows.some(r => /split by a newline/.test(r.reason)), JSON.stringify(v.invalidRows));
    const db = openDb(); const out = await processReport(db, SELLER, t, { api, validate: vies, now: new Date('2026-11-25T13:00:00Z') });
    assert.equal(out.errors.length, 0); assert.equal(out.uploaded, 2); assert.equal(out.held.length, 0); assert.equal(out.invalidRows.length, 2);
    assert.equal(db.prepare("SELECT count(*) c FROM shipments WHERE key LIKE '%S1002%'").get().c, 0, 'the split row is not stored');
  });
}
test('the split row is the first data row and the last: still quarantined', () => {
  for (const k of [0, 2]) { const v = parseVidr(text(split(mk(3), k, 'buyer-tax-registration-type'))); assert.equal(v.length, 2); assert.equal(v.invalidRows.length, 2); }
});
test('no harm: healthy rows, and a row whose trailing optional cell was removed, are never quarantined', () => {
  const rows = mk(3); const t = text(rows); assert.equal(parseVidr(t).invalidRows.length, 0); assert.equal(parseVidr(t).length, 3);
  const trimmed = [FX[0], rows[0].join('\t'), rows[1].slice(0, -1).join('\t'), rows[2].join('\t')].join('\n') + '\n';
  const v = parseVidr(trimmed); assert.equal(v.length, 3); assert.equal(v.invalidRows.length, 0);
});
test('no harm: a split in an EARLIER cell (billing-name) does not take down the healthy row before it', () => {
  const v = parseVidr(text(split(mk(3), 1, 'billing-name')));
  assert.deepEqual(keys(v), ['S1001', 'S1003']);
  assert.ok(v.invalidRows.length >= 2);
});
test('DOCUMENTED COST: a complete row followed by a stray short line that would exactly complete it is quarantined with that line (a valid row can be rejected here)', () => {
  const rows = mk(2); const t = [FX[0], rows[0].join('\t'), 'x', rows[1].join('\t')].join('\n') + '\n';
  const v = parseVidr(t);
  assert.deepEqual(keys(v), ['S1002'], 'the row before the stray line is held back, not trusted');
  assert.equal(v.invalidRows.length, 2);
});
test('loop path (parseTable): the same files are flagged as ragged by its own reader, so the import is shown as incomplete', () => {
  for (const col of ['buyer-tax-registration-type', 'citation-es']) assert.ok(parseTable(text(split(mk(3), 1, col))).raggedRows >= 1, col);
});
test('entry paths: processReport is called with a ready-made shipments list from one place only (src/manual-jobs.js background issue worker), and that list carries the parser invalidRows', async () => {
  const { readdirSync } = await import('node:fs');
  const hits = [];
  for (const f of readdirSync(new URL('../src/', import.meta.url))) if (f.endsWith('.js')) { const s = readFileSync(new URL('../src/' + f, import.meta.url), 'utf8'); for (const l of s.split('\n')) if (/processReport\(/.test(l) && /shipments\s*:/.test(l) && !/export async function/.test(l)) hits.push(f); }
  assert.deepEqual(hits, ['manual-jobs.js']);
  const plan = planUpload(text(split(mk(3), 1, 'buyer-tax-registration-type')));
  assert.equal(plan.ok, true); assert.equal(plan.shipments.length, 2); assert.equal(plan.shipments.invalidRows.length, 2, 'invalid rows travel with the list into processReport');
  const db = openDb(); const out = await processReport(db, SELLER, '', { api, validate: vies, shipments: plan.shipments, now: new Date('2026-11-25T13:00:00Z') });
  assert.equal(out.invalidRows.length, 2);
});
// ---- OPTION B (not wired into the product): rejoin the pieces. Shown here only to evidence what it would recover and what it could mis-join. ----
const rejoin = (t) => { const L = t.split('\n'); const out = []; for (const l of L) { const prev = out[out.length - 1]; const c = l.split('\t'); if (prev !== undefined && l.trim() && c.length < H.length - 1 && prev.split('\t').length + c.length - 1 === H.length) out[out.length - 1] = prev + '\n' + l; else out.push(l); } return out.join('\n'); };
test('option B rejoin: recovers the split row exactly (newline kept in the cell) when the join is exact', () => {
  const t = rejoin(text(split(mk(3), 1, 'buyer-tax-registration-type')));
  assert.ok(t.includes('AB\nCD'));
});
test('option B rejoin: would also mis-join a valid row with a stray short line (garbled last cell, no warning)', () => {
  const rows = mk(2); const joined = rejoin([FX[0], rows[0].join('\t'), 'x', rows[1].join('\t')].join('\n') + '\n');
  assert.ok(joined.includes('\nx'), 'the stray text was glued into the last cell of a valid row');
});
