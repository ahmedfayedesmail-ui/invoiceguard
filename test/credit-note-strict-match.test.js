// Strict CreditNoteUploaded matching, failure cases FIRST (owner ruling A, Nov 28 2026). Written before the fix; see audit/phase-b/pre-fix-run-27-*.txt.
// Rule under test: a credit note becomes 'uploaded' (which opens the replacement invoice) ONLY when the report proves Amazon finished processing OUR document:
// exact status, document number, transaction, marketplace, order, shipping, currency, amounts, authenticated report order. Anything unproven or contradictory = HOLD, nothing changes automatically.
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { openDb, currentAttemptSeq } from '../src/db.js';
import { processReport, processCorrections } from '../src/pipeline.js'; import { approveAll } from './correction-helpers.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', country: 'ES', invoice_lang: 'auto' };
const vies = async (v) => ({ status: 'valid', vat: v }); const NOW = new Date('2026-11-24T12:00:00Z');
const [head0, ...body] = text.trim().split('\n'); const cols = head0.split('\t'); const X = ['invoice-number', 'original-vat-invoice-number']; const ix = n => cols.includes(n) ? cols.indexOf(n) : cols.length + X.indexOf(n);
const H = head0 + '\t' + X.join('\t'); const base = body[0].split('\t'); const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const mkApi = () => ({ calls: [], uploadInvoice: async function (a) { this.calls.push(a); return 'f' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }) });
const pad = (r) => { while (r.length < cols.length + X.length) r.push(''); return r; };
const rv = (status = 'CreditNotePending') => { const r = pad([...base]); r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = 'CorrectionReversal:X:1'; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = status; return r; };
const rp = () => { const f = pad([...base]); f[ix('transaction-id')] = 'Correction::X:2'; f[ix('billing-name')] = 'Name One SL'; return f; };
const rep = (a, b) => [H + '\tinvoice-correction-details', a.join('\t') + '\tReason A', b.join('\t') + '\tReason A'].join('\n');
const KEY = 'REFUND:CorrectionReversal:X:1';
async function setup() { const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: NOW }); await processCorrections(db, seller, rep(rv(), rp()), { api, validate: vies }); approveAll(db, seller.id); await processCorrections(db, seller, rep(rv(), rp()), { api, validate: vies }); return { api, db, seq: currentAttemptSeq(db, seller.id) }; }
const cn = (db) => db.prepare("SELECT number, upload_status, json FROM invoices WHERE kind='rectificativa' AND shipment_key=?").get(KEY);
const repl = (db) => db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND shipment_key LIKE '%Correction::%'").get().c;
const holds = (db, code) => db.prepare("SELECT code FROM integrity_findings WHERE status='OPEN' AND code LIKE 'CREDIT_NOTE_%'" + (code ? ' AND code=?' : ''), ).all(...(code ? [code] : []));
// the exactly-right acceptance row for our credit note; mod() breaks one thing
const good = (n, mod) => { const r = rv('CreditNoteUploaded'); r[ix('invoice-number')] = n; mod?.(r); return r; };
const doc = (...rows) => [H, ...rows.map(r => r.join('\t'))].join('\n');
const ing = (db, api, t, extra = {}, sl = seller) => processReport(db, sl, t, { api, validate: vies, ...extra });
const nextPass = (db, api) => processCorrections(db, seller, rep(rv(), rp()), { api, validate: vies });
/** feed one report, then the next correction pass; return the credit note state, whether the replacement exists, and open holds */
async function run(mod, { extra, sl, n2, rows } = {}) { const { api, db, seq } = await setup(); const c = cn(db); const t = doc(...(rows ? rows(c.number) : [good(c.number, mod)])); await ing(db, api, t, { reportAttemptSeq: seq, ...(extra ?? {}) }, sl); await nextPass(db, api); await nextPass(db, api); return { db, api, seq, c, after: cn(db), repl: repl(db), holds: holds(db) }; }
const closed = (x) => { assert.equal(x.after.upload_status, 'submitted', 'the credit note is NOT marked uploaded'); assert.equal(x.repl, 0, 'no replacement invoice'); };

test('S0 control: every identity field right + CreditNoteUploaded + authenticated report sequence -> uploaded, replacement issues, no hold', async () => { const x = await run(); assert.equal(x.after.upload_status, 'uploaded'); assert.equal(x.repl, 1); assert.equal(x.holds.length, 0); });
test('S1 right transaction key + WRONG document number -> held, closed', async () => { const x = await run(r => { r[ix('invoice-number')] = 'R-2026-999999'; }); closed(x); assert.ok(x.holds.length >= 1, 'a hold is opened for a person'); });
test('S2 right key + document number BLANK -> held, closed (a blank number is never a match)', async () => { const x = await run(r => { r[ix('invoice-number')] = ''; }); closed(x); assert.ok(x.holds.length >= 1); });
test('S2b report with NO invoice-number column at all (not the All view) -> held, closed', async () => { const { api, db, seq } = await setup(); const [h0, ...b] = [head0, (() => { const r = [...base]; r[cols.indexOf('transaction-type')] = 'REFUND'; r[cols.indexOf('transaction-id')] = 'CorrectionReversal:X:1'; AMT.forEach(n => { r[cols.indexOf(n)] = r[cols.indexOf(n)] ? '-' + r[cols.indexOf(n)] : ''; }); r[cols.indexOf('invoice-status')] = 'CreditNoteUploaded'; return r.join('\t'); })()]; await ing(db, api, [h0, ...b].join('\n'), { reportAttemptSeq: seq }); await nextPass(db, api); assert.equal(cn(db).upload_status, 'submitted'); assert.equal(repl(db), 0); });
test('S3 right document number + WRONG transaction key -> nothing matches, closed', async () => { const x = await run(r => { r[ix('transaction-id')] = 'CorrectionReversal:OTHER:9'; }); closed(x); });
test('S4 right key + WRONG seller (report processed for another seller) -> closed, our credit note untouched', async () => { const x = await run(undefined, { sl: { ...seller, id: 'sel2' } }); closed(x); });
test('S5 right key + wrong MARKETPLACE -> held, closed', async () => { const x = await run(r => { r[ix('marketplace-id')] = 'A1PA6795UKMFR9'; }); closed(x); assert.ok(x.holds.length >= 1); });
test('S6 right key + wrong ORIGINAL invoice number in the row -> held, closed', async () => { const x = await run(r => { r[ix('original-vat-invoice-number')] = 'A-2026-999999'; }); closed(x); assert.ok(x.holds.length >= 1); });
test('S7a right key + wrong ORDER id -> held, closed', async () => { const x = await run(r => { r[ix('order-id')] = '999-0000000-0000000'; }); closed(x); assert.ok(x.holds.length >= 1); });
test('S7b right key + wrong SHIPPING id -> held, closed', async () => { const x = await run(r => { r[ix('shipping-id')] = 'S9999'; }); closed(x); assert.ok(x.holds.length >= 1); });
test('S8 right key + wrong CURRENCY -> held, closed', async () => { const x = await run(r => { r[ix('currency')] = 'GBP'; }); closed(x); assert.ok(x.holds.length >= 1); });
test('S9a AMOUNT mismatch (item incl differs) -> held, closed', async () => { const x = await run(r => { r[ix('item-vat-incl-amount')] = '-1.00'; }); closed(x); assert.ok(x.holds.length >= 1); });
test('S9b VAT amount mismatch -> held, closed', async () => { const x = await run(r => { r[ix('item-vat-amount')] = '-0.01'; }); closed(x); assert.ok(x.holds.length >= 1); });
test('S9c SIGN flipped (positive amounts where our credit note is negative) -> held, never silently accepted with an absolute value', async () => { const x = await run(r => { AMT.forEach(n => { r[ix(n)] = r[ix(n)].replace('-', ''); }); }); closed(x); assert.ok(x.holds.length >= 1); });
test('S10 MULTIPLE line items of one transaction whose amounts add up to our credit note -> accepted', async () => {
  const x = await run(undefined, { rows: (n) => { const a = good(n), b = good(n); b[ix('order-item-id')] = 'ITEM-2'; AMT.forEach(c => { const v = Math.round(Number(a[ix(c)] || 0) * 100); const h1 = Math.trunc(v / 2); a[ix(c)] = a[ix(c)] === '' ? '' : (h1 / 100).toFixed(2); b[ix(c)] = b[ix(c)] === '' ? '' : ((v - h1) / 100).toFixed(2); }); return [a, b]; } }); assert.equal(x.after.upload_status, 'uploaded'); assert.equal(x.holds.length, 0);
});
test('S10b multiple line items where the parts do NOT add up to our credit note -> held, closed', async () => { const x = await run(undefined, { rows: (n) => { const a = good(n), b = good(n); b[ix('order-item-id')] = 'ITEM-2'; return [a, b]; } }); closed(x); assert.ok(x.holds.length >= 1); });
test('S11 conflicting statuses of one transaction in ONE report, Uploaded first -> held, nothing picked, closed', async () => { const x = await run(undefined, { rows: (n) => [good(n), good(n, r => { r[ix('invoice-status')] = 'CreditNoteRejected'; })] }); closed(x); assert.ok(holds(x.db, 'CREDIT_NOTE_ROWS_CONFLICT').length === 1); });
test('S11b same conflict with the rows in REVERSE order -> same outcome (row order never matters)', async () => { const x = await run(undefined, { rows: (n) => [good(n, r => { r[ix('invoice-status')] = 'CreditNoteRejected'; }), good(n)] }); closed(x); assert.ok(holds(x.db, 'CREDIT_NOTE_ROWS_CONFLICT').length === 1); });
test('S11c rows that agree on status but DISAGREE on the document number -> held, closed (both orders)', async () => { for (const flip of [false, true]) { const x = await run(undefined, { rows: (n) => { const a = good(n), b = good(n, r => { r[ix('invoice-number')] = 'R-2026-777777'; }); return flip ? [b, a] : [a, b]; } }); closed(x); assert.ok(x.holds.length >= 1); } });
test('S11d Pending in one row and Uploaded in another -> held (any difference between rows)', async () => { const x = await run(undefined, { rows: (n) => [good(n, r => { r[ix('invoice-status')] = 'CreditNotePending'; }), good(n)] }); closed(x); assert.ok(x.holds.length >= 1); });
test('S12 duplicate reports (the same acceptance twice) -> idempotent: uploaded once, one replacement, no hold', async () => { const { api, db, seq } = await setup(); const n = cn(db).number; const t = doc(good(n)); await ing(db, api, t, { reportAttemptSeq: seq }); await ing(db, api, t, { reportAttemptSeq: seq }); await nextPass(db, api); await nextPass(db, api); assert.equal(cn(db).upload_status, 'uploaded'); assert.equal(repl(db), 1); assert.equal(holds(db).length, 0); });
test('S13 STALE report (older than our upload attempt) saying Uploaded -> ignored, closed', async () => { const x = await run(undefined, { extra: { reportAttemptSeq: 0 } }); closed(x); });
test('S13b a report that arrives AFTER a newer one cannot undo it: newer Uploaded applied, then an OLDER report (earlier request time) saying Rejected -> ignored', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: new Date('2026-11-25T10:00:00Z') });
  await ing(db, api, doc(good(n, r => { r[ix('invoice-status')] = 'CreditNoteRejected'; })), { reportAttemptSeq: seq, reportRequestedAt: new Date('2026-11-25T09:00:00Z') }); assert.equal(cn(db).upload_status, 'uploaded'); assert.equal(holds(db).length, 0, 'a stale report is skipped, not a contradiction');
});
test('S14 NO report sequence (not the authenticated download path) with an otherwise perfect row -> held, closed', async () => { const { api, db } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n))); await nextPass(db, api); await nextPass(db, api); assert.equal(cn(db).upload_status, 'submitted'); assert.equal(repl(db), 0); assert.ok(holds(db).length >= 1); });
test('S15 Uploaded in one report, Rejected in a LATER report -> contradiction HOLD; the credit note stays uploaded, nothing cancelled, no retry proposed', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: new Date('2026-11-25T09:00:00Z') });
  await ing(db, api, doc(good(n, r => { r[ix('invoice-status')] = 'CreditNoteRejected'; })), { reportAttemptSeq: seq, reportRequestedAt: new Date('2026-11-25T11:00:00Z') });
  assert.equal(cn(db).upload_status, 'uploaded', 'not flipped'); assert.equal(holds(db, 'CREDIT_NOTE_VERDICT_CONTRADICTION').length, 1); const pr = db.prepare("SELECT count(*) c FROM sqlite_master WHERE name='repairs'").get().c ? db.prepare("SELECT count(*) c FROM repairs WHERE state='proposed'").get().c : 0; assert.equal(pr, 0, 'no automatic retry proposal');
});
test('S16 Rejected AFTER the replacement was issued -> HOLD; both documents stay exactly as they are; no further automatic action while the hold is open', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: new Date('2026-11-25T09:00:00Z') }); await nextPass(db, api); await nextPass(db, api); assert.equal(repl(db), 1, 'setup: replacement issued');
  const before = db.prepare("SELECT number, upload_status FROM invoices ORDER BY number").all(); await ing(db, api, doc(good(n, r => { r[ix('invoice-status')] = 'CreditNoteRejected'; })), { reportAttemptSeq: seq, reportRequestedAt: new Date('2026-11-25T11:00:00Z') });
  assert.deepEqual(db.prepare("SELECT number, upload_status FROM invoices ORDER BY number").all(), before, 'no document changed state'); assert.equal(holds(db, 'CREDIT_NOTE_VERDICT_CONTRADICTION').length, 1);
  const calls = api.calls.length; await nextPass(db, api); assert.equal(api.calls.length, calls, 'nothing is sent while the hold is open');
});
for (const st of ['CreditNoteAccepted', 'creditnoteuploaded', 'Uploaded', '', 'CreditNoteUploaded;']) test(`S17 unknown status ${JSON.stringify(st)} -> no state change, closed`, async () => { const x = await run(r => { r[ix('invoice-status')] = st; }); closed(x); });
test('S18 CreditNoteProcessing is not acceptance: it records processing only, replacement stays closed', async () => { const x = await run(r => { r[ix('invoice-status')] = 'CreditNoteProcessing'; }); assert.notEqual(x.after.upload_status, 'uploaded'); assert.equal(x.repl, 0); });
// ---- race: report ingestion against the approval state ----
const rpChanged = () => { const f = rp(); f[ix('billing-name')] = 'Somebody Else SL'; return f; };
test('R1 race, order 1: the pair\'s approval is voided (the replacement data changed) BEFORE the acceptance report is ingested -> uploaded, but no replacement without a new approval', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number; await processCorrections(db, seller, rep(rv(), rpChanged()), { api, validate: vies }); await ing(db, api, doc(good(n)), { reportAttemptSeq: seq }); await processCorrections(db, seller, rep(rv(), rpChanged()), { api, validate: vies }); assert.equal(repl(db), 0, 'no replacement on a voided approval');
});
test('R2 race, order 2: the acceptance report is ingested FIRST, then the approval is voided before the next pass -> still no replacement', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq }); await processCorrections(db, seller, rep(rv(), rpChanged()), { api, validate: vies }); assert.equal(repl(db), 0, 'a changed pair needs a new approval even though the credit note is accepted');
});
