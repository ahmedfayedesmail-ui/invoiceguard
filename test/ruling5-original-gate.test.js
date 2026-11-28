// Ruling 5 (Ahmed, WhatsApp 2026-11-28 15:27, forwarded verbatim by Main), decisions 1 and 2: an original SHIPMENT invoice verdict needs an identity proof built for originals; a RETURN row carrying an Invoice* status is a HOLD with zero effect.
// Synthetic fixtures only. Every case: the status is applied ONLY on a full match; anything else is a HOLD and changes nothing.
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { openDb, currentAttemptSeq } from '../src/db.js'; import { processReport } from '../src/pipeline.js'; import { proved } from './helpers/prove-verdict.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', country: 'ES', invoice_lang: 'auto' };
const vies = async (v) => ({ status: 'valid', vat: v }); const NOW = new Date('2026-11-24T12:00:00Z');
const okApi = () => ({ calls: [], uploadInvoice: async function (a) { this.calls.push(a); return 'f' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] });
const cols = text.trim().split('\n')[0].split('\t'); const ix = (n) => cols.indexOf(n);
async function setup() { const api = okApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: NOW }); return { api, db }; }
const inv = (db) => db.prepare("SELECT number, upload_status FROM invoices WHERE kind='invoice' AND shipment_key='SHIPMENT:S1001'").get();
/** a one-row verdict report for S1001: status set, invoice-number = our stored number; mod(cellsByName) breaks one thing */
function verdict(db, status, mod, { dropNumberColumn = false, num } = {}) {
  const [head, ...rows] = text.trim().split('\n'); const row = rows.find(r => r.split('\t')[ix('shipping-id')] === 'S1001').split('\t'); row[ix('invoice-status')] = status; mod?.(row);
  if (dropNumberColumn) return [head, row.join('\t')].join('\n');
  const number = num !== undefined ? num : (db.prepare("SELECT number FROM invoices WHERE kind='invoice' AND shipment_key='SHIPMENT:S1001'").get()?.number ?? '');
  return [head + '\tinvoice-number', row.join('\t') + '\t' + number].join('\n');
}
const feedIt = (db, api, t, over = {}) => processReport(db, seller, t, { api, validate: vies, reportAttemptSeq: currentAttemptSeq(db, seller.id), ...over });
const holdOpen = (db, code = 'ORIGINAL_INVOICE_VERDICT_UNPROVEN') => db.prepare("SELECT 1 FROM integrity_findings WHERE status='OPEN' AND code=?").get(code);
const heldCase = (name, status, mod, opts, over) => test(`O-${name}: ${status} on an original is a HOLD and applies nothing`, async () => {
  const { api, db } = await setup(); const before = inv(db).upload_status; await feedIt(db, api, verdict(db, status, mod, opts), over);
  assert.equal(inv(db).upload_status, before, 'the status was not applied'); assert.ok(holdOpen(db), 'a HOLD is open'); assert.equal(db.prepare("SELECT count(*) c FROM events WHERE type='confirmed_uploaded'").get().c, 0);
});
test('O-match: a full match applies the status (guard: the product still accepts a proven original)', async () => {
  const { api, db } = await setup(); await feedIt(db, api, verdict(db, 'InvoiceUploaded')); assert.equal(inv(db).upload_status, 'uploaded'); assert.ok(!holdOpen(db));
});
test('O-match-rejected/processing: proven Rejected and Processing verdicts are applied', async () => {
  let x = await setup(); await feedIt(x.db, x.api, verdict(x.db, 'InvoiceProcessing')); assert.equal(inv(x.db).upload_status, 'processing');
  x = await setup(); await feedIt(x.db, x.api, verdict(x.db, 'InvoiceRejected', (r) => { r[ix('invoice-status-description')] = 'Internal processing error'; })); assert.equal(inv(x.db).upload_status, 'rejected');
});
heldCase('number-mismatch', 'InvoiceUploaded', undefined, { num: 'A-2026-999999' });
heldCase('number-blank', 'InvoiceUploaded', undefined, { num: '' });
heldCase('no-number-column', 'InvoiceUploaded', undefined, { dropNumberColumn: true });
heldCase('amount-mismatch', 'InvoiceUploaded', (r) => { r[ix('item-vat-incl-amount')] = '54.46'; });
heldCase('sign-mismatch', 'InvoiceUploaded', (r) => { for (const n of ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount']) r[ix(n)] = '-' + r[ix(n)]; });
heldCase('vat-mismatch', 'InvoiceUploaded', (r) => { r[ix('item-vat-amount')] = '9.46'; });
heldCase('shipping-id-mismatch', 'InvoiceUploaded', (r) => { r[ix('order-id')] = '405-0000000-0000000'; });
heldCase('currency-mismatch', 'InvoiceUploaded', (r) => { r[ix('currency')] = 'GBP'; });
heldCase('marketplace-mismatch', 'InvoiceUploaded', (r) => { r[ix('marketplace-id')] = 'DE'; });
test('O-not-a-shipment-row: a REFUND row with InvoiceUploaded stays the REFUND hold and never touches the original', async () => {
  const { api, db } = await setup(); const before = inv(db).upload_status; await feedIt(db, api, verdict(db, 'InvoiceUploaded', (r) => { r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = 'RF-1'; }));
  assert.equal(inv(db).upload_status, before); assert.ok(holdOpen(db, 'REFUND_ROW_INVOICE_STATUS'));
});
test('O-old-report: a report older than our current attempt cannot describe it (no status, no new hold)', async () => {
  const { api, db } = await setup(); const before = inv(db).upload_status; await feedIt(db, api, verdict(db, 'InvoiceUploaded'), { reportAttemptSeq: 0 });
  assert.equal(inv(db).upload_status, before);
});
test('O-no-sequence: a report without the authenticated download sequence applies nothing', async () => {
  const { api, db } = await setup(); const before = inv(db).upload_status; await processReport(db, seller, verdict(db, 'InvoiceUploaded'), { api, validate: vies });
  assert.equal(inv(db).upload_status, before); assert.ok(holdOpen(db));
});
test('O-row-disagreement: two rows of one shipment with different statuses pick no row', async () => {
  const { api, db } = await setup(); const [head, ...rows] = text.trim().split('\n'); const r1 = rows.find(r => r.split('\t')[ix('shipping-id')] === 'S1001').split('\t'), r2 = [...r1]; r1[ix('invoice-status')] = 'InvoiceUploaded'; r2[ix('invoice-status')] = 'InvoiceRejected';
  const before = inv(db).upload_status; await feedIt(db, api, proved(db, seller.id, [head, r1.join('\t'), r2.join('\t')].join('\n'))); assert.equal(inv(db).upload_status, before); assert.ok(holdOpen(db));
});
test('O-hold-resolves: a later PROVEN report resolves the hold and applies the status', async () => {
  const { api, db } = await setup(); await feedIt(db, api, verdict(db, 'InvoiceUploaded', (r) => { r[ix('item-vat-incl-amount')] = '54.46'; })); assert.ok(holdOpen(db));
  await feedIt(db, api, verdict(db, 'InvoiceUploaded')); assert.equal(inv(db).upload_status, 'uploaded'); assert.ok(!holdOpen(db));
});
test('O-contradiction: a PROVEN Rejected after an accepted upload is still the UPLOADED_THEN_REJECTED hold, never a flip', async () => {
  const { api, db } = await setup(); await feedIt(db, api, verdict(db, 'InvoiceUploaded')); await feedIt(db, api, verdict(db, 'InvoiceRejected'));
  assert.equal(inv(db).upload_status, 'uploaded'); assert.ok(db.prepare("SELECT 1 FROM integrity_findings WHERE status='OPEN' AND code='UPLOADED_THEN_REJECTED'").get());
});
// ---- RETURN rows ----
const returnRow = (db, status) => verdict(db, status, (r) => { r[ix('transaction-type')] = 'RETURN'; r[ix('transaction-id')] = 'RT-1'; });
for (const st of ['InvoiceUploaded', 'InvoiceRejected', 'InvoiceProcessing']) test(`RT-${st}: a RETURN row with ${st} is a HOLD with zero effect on the original invoice`, async () => {
  const { api, db } = await setup(); const snap = () => JSON.stringify([db.prepare('SELECT number, upload_status FROM invoices ORDER BY number').all(), db.prepare('SELECT key, status FROM shipments ORDER BY key').all()]); const before = snap(); const calls = api.calls.length;
  await feedIt(db, api, returnRow(db, st)); assert.equal(snap(), before, 'no invoice or shipment changed'); assert.ok(holdOpen(db, 'RETURN_ROW_INVOICE_STATUS')); assert.equal(api.calls.length, calls, 'nothing was uploaded because of it');
  assert.ok(!db.prepare("SELECT name FROM sqlite_master WHERE name='repairs'").get() || db.prepare('SELECT count(*) c FROM repairs').get().c === 0, 'no retry proposal either');
});
test('RT-match-cannot-launder: even a RETURN row that names our exact invoice number and amounts never changes the original', async () => {
  const { api, db } = await setup(); await feedIt(db, api, returnRow(db, 'InvoiceUploaded')); assert.equal(inv(db).upload_status, 'submitted'); assert.notEqual(inv(db).upload_status, 'uploaded');
});
test('RT-pending-guard: a RETURN row with CreditNotePending keeps its current path (no RETURN hold)', async () => {
  const { api, db } = await setup(); await feedIt(db, api, verdict(db, 'InvoiceUploaded')); await feedIt(db, api, returnRow(db, 'CreditNotePending')); assert.ok(!holdOpen(db, 'RETURN_ROW_INVOICE_STATUS'));
});
// ---- decision 1: REFUND + InvoiceUploaded, no human release; notes only ----
import { decideHold, addHoldNote, listHolds } from '../src/holds.js';
test('RF-no-release: a human decision can NOT release the REFUND+InvoiceUploaded hold; a note records and changes nothing', async () => {
  const { api, db } = await setup(); await feedIt(db, api, verdict(db, 'InvoiceUploaded', (r) => { r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = 'RF-1'; }));
  const f = db.prepare("SELECT shipment_key k, code, fingerprint f FROM integrity_findings WHERE code='REFUND_ROW_INVOICE_STATUS' AND status='OPEN'").get(); assert.ok(f);
  assert.throws(() => decideHold(db, seller.id, { key: f.k, code: f.code, fingerprint: f.f, reason: 'I checked Seller Central, it is fine' }, 'ahmed'), /new evidence/i);
  const snap = () => JSON.stringify([db.prepare('SELECT number, upload_status FROM invoices ORDER BY number').all(), db.prepare('SELECT key, status FROM shipments ORDER BY key').all(), db.prepare('SELECT code, status FROM integrity_findings ORDER BY code').all()]); const before = snap();
  const r = addHoldNote(db, seller.id, { key: f.k, code: f.code, note: 'Asked Amazon support, waiting for an answer' }, 'ahmed'); assert.equal(r.stateChanged, false);
  assert.equal(snap(), before, 'the note changed no document, shipment or finding'); assert.equal(db.prepare("SELECT count(*) c FROM events WHERE type='hold_note'").get().c, 1);
  assert.ok(db.prepare("SELECT 1 FROM integrity_findings WHERE code='REFUND_ROW_INVOICE_STATUS' AND status='OPEN'").get(), 'still open');
  assert.throws(() => addHoldNote(db, seller.id, { key: 'nope', code: f.code, note: 'something' }, 'ahmed'), /no such item/);
});
