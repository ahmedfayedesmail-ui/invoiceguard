// Owner decisions 1 and 2 (Ahmed, WhatsApp 2026-11-28 13:51, forwarded verbatim by Main): replacement invoice acceptance needs exact proof; a REFUND row with an Invoice* status is a HOLD. Synthetic fixtures only.
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { openDb, currentAttemptSeq } from '../src/db.js';
import { openCreditNoteHold } from '../src/cn-gate.js'; import { releaseIntegrity } from '../src/integrity.js'; import { processReport, processCorrections } from '../src/pipeline.js'; import { approveAll } from './correction-helpers.js';
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
const hold = (db, code) => db.prepare("SELECT * FROM integrity_findings WHERE code LIKE 'CREDIT_NOTE_%'" + (code ? ' AND code=?' : '')).all(...(code ? [code] : []));
const hist = (db, code) => db.prepare("SELECT event FROM integrity_history WHERE code=? ORDER BY rowid").all(code).map(r => r.event);
const st = (r, s) => { r[ix('invoice-status')] = s; return r; };
const T1 = new Date('2026-11-25T09:00:00Z'), T2 = new Date('2026-11-25T11:00:00Z');
const replRow = (db) => db.prepare("SELECT number, upload_status, json FROM invoices WHERE kind='rectificativa' AND shipment_key LIKE '%Correction::%'").get();
const orig = (db) => db.prepare("SELECT number, upload_status FROM invoices WHERE kind='invoice'").get();
async function withReplacement() { const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: T1 }); await nextPass(db, api); const r = replRow(db); assert.ok(r, 'setup: replacement exists'); return { api, db, seq, r, n }; }
const accept = (num, mod) => { const r = rp(); r[ix('invoice-status')] = 'InvoiceUploaded'; r[ix('invoice-number')] = num; mod?.(r); return r; };
const feed = (db, api, seq, row, extra = {}) => ing(db, api, doc(row), { reportAttemptSeq: currentAttemptSeq(db, seller.id), reportRequestedAt: T2, ...extra });
const cnHolds = (db) => db.prepare("SELECT code FROM integrity_findings WHERE status='OPEN' AND code LIKE 'CREDIT_NOTE_%'").all().map(r => r.code);
test('D1 (guard) a replacement row that matches our document exactly is accepted', async () => {
  const { api, db, seq, r } = await withReplacement(); await feed(db, api, seq, accept(r.number)); assert.equal(replRow(db).upload_status, 'uploaded'); assert.deepEqual(cnHolds(db), []);
});
test('D2 a replacement row with another document number is a HOLD, the replacement is not accepted', async () => {
  const { api, db, seq, r } = await withReplacement(); await feed(db, api, seq, accept('R-2026-999999')); assert.notEqual(replRow(db).upload_status, 'uploaded'); assert.ok(cnHolds(db).includes('CREDIT_NOTE_IDENTITY_UNPROVEN'));
});
test('D3 a replacement row whose amount differs by one cent is a HOLD', async () => {
  const { api, db, seq, r } = await withReplacement(); await feed(db, api, seq, accept(r.number, x => { x[ix('item-vat-incl-amount')] = String(Number(x[ix('item-vat-incl-amount')]) + 0.01); })); assert.notEqual(replRow(db).upload_status, 'uploaded'); assert.ok(cnHolds(db).length >= 1);
});
test('D4 a replacement row with the sign flipped is a HOLD (no absolute values)', async () => {
  const { api, db, seq, r } = await withReplacement(); await feed(db, api, seq, accept(r.number, x => { AMT.forEach(n => { x[ix(n)] = x[ix(n)] ? '-' + x[ix(n)] : ''; }); })); assert.notEqual(replRow(db).upload_status, 'uploaded'); assert.ok(cnHolds(db).length >= 1);
});
test('D5 a report without the invoice-number column cannot accept a replacement', async () => {
  const { api, db, seq, r } = await withReplacement(); const row = accept(r.number); const t = [head0, row.slice(0, cols.length).join('\t')].join('\n'); await ing(db, api, t, { reportAttemptSeq: currentAttemptSeq(db, seller.id), reportRequestedAt: T2 }); assert.notEqual(replRow(db).upload_status, 'uploaded'); assert.ok(cnHolds(db).length >= 1);
});
test('D6 a replacement row with another currency or marketplace is a HOLD', async () => {
  for (const [col, val] of [['currency', 'USD'], ['marketplace-id', 'A1PA6795UKMFR9X']]) { const { api, db, seq, r } = await withReplacement(); await feed(db, api, seq, accept(r.number, x => { x[ix(col)] = val; })); assert.notEqual(replRow(db).upload_status, 'uploaded', col); }
});
test('D7 a REFUND row carrying InvoiceUploaded is a HOLD that needs new evidence; the original invoice and the credit note are unchanged and nothing is accepted or rejected', async () => {
  const { api, db, seq } = await setup(); const before = { o: orig(db), c: cn(db).upload_status };
  const row = rv('InvoiceUploaded'); row[ix('invoice-number')] = before.o.number; await ing(db, api, doc(row), { reportAttemptSeq: seq, reportRequestedAt: T1 });
  assert.deepEqual(orig(db), before.o); assert.equal(cn(db).upload_status, before.c);
  const f = db.prepare("SELECT code, status, resolution FROM integrity_findings WHERE code='REFUND_ROW_INVOICE_STATUS'").all(); assert.equal(f.length, 1); assert.equal(f[0].status, 'OPEN'); assert.equal(f[0].resolution, 'NEW_EVIDENCE');
});
test('D8 (guard) a REFUND hold cannot be released by a human decision (only new evidence resolves it)', async () => {
  const { api, db, seq } = await setup(); const row = rv('InvoiceUploaded'); row[ix('invoice-number')] = 'X'; await ing(db, api, doc(row), { reportAttemptSeq: seq, reportRequestedAt: T1 });
  const f = db.prepare("SELECT shipment_key k, fingerprint fp FROM integrity_findings WHERE code='REFUND_ROW_INVOICE_STATUS'").get(); assert.throws(() => releaseIntegrity(db, seller.id, f.k, 'REFUND_ROW_INVOICE_STATUS', f.fp, { user: 'a@b.es', reason: 'long enough reason' }), /new evidence/i);
});
// Re-review verdict (Main 13:57, reviewer agent-01M8GZVRMZ3Q8PVCHRNQ8MM2RA): a boot sweep that flips an in-flight 'sending' document to 'unknown' must not let the SAME document be resubmitted when the late upload result arrives.
import { recoverUncertainUploads } from '../src/repair.js'; import { settleUnknownDocuments } from '../src/pipeline.js';
test('D9 a late upload result after a boot sweep keeps the document blocked: the settle path never resubmits it', async () => {
  const db = openDb(); let open; const gate = new Promise(r => { open = r; }); const slow = { calls: [], uploadInvoice: async function (a) { this.calls.push(a); await gate; return 'late-feed-' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }) };
  const p = processReport(db, seller, text, { api: slow, validate: vies, now: NOW }); for (let i = 0; i < 200 && !slow.calls.length; i++) await new Promise(r => setTimeout(r, 10)); assert.ok(slow.calls.length, 'an upload is in flight');
  const first = slow.calls[0].number; assert.ok(recoverUncertainUploads(db) >= 1); open(); await p;
  const row = db.prepare("SELECT upload_status, feed_id, blocked_feed_id FROM invoices WHERE number=?").get(first); assert.equal(row.upload_status, 'unknown'); assert.ok(row.feed_id, 'the late result was recorded'); assert.equal(row.blocked_feed_id, row.feed_id, 'and that feed blocks a resend');
  const api2 = mkApi(); await settleUnknownDocuments(db, seller, text, { api: api2, validate: vies }); assert.ok(api2.calls.every(c => c.number !== first), 'the same document is never submitted twice');
});
test('D10 the boot sweep only recovers a row that is still sending', () => {
  const db = openDb(); db.prepare("INSERT OR IGNORE INTO sellers (id) VALUES ('s1')").run(); db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,json,upload_status,sending_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('s1', 'N1', 'SHIPMENT:S1', 'invoice', '2026-01-01', 1, 0, '{}', 'submitted', '2020-01-01T00:00:00Z');
  assert.equal(recoverUncertainUploads(db), 0); assert.equal(db.prepare("SELECT upload_status s FROM invoices WHERE number='N1'").get().s, 'submitted');
});
// Second re-reviewer F1 (P1): writing a new ledger finding must never silently resolve other open findings (a credit-note hold) on the same key.
test('D11 an Invoice Rejected row for an uploaded replacement while a credit-note hold is OPEN leaves that hold OPEN and the pair blocked', async () => {
  const { api, db, seq, r } = await withReplacement(); await feed(db, api, seq, accept(r.number)); assert.equal(replRow(db).upload_status, 'uploaded');
  openCreditNoteHold(db, seller.id, replRow(db).shipment_key ?? 'SHIPMENT:Correction::X:2', 'CREDIT_NOTE_VERDICT_CONTRADICTION', [{ c: 'verdict-contradiction', why: 'contradiction' }], {});
  const rej = accept(r.number); rej[ix('invoice-status')] = 'InvoiceRejected'; await feed(db, api, seq, rej);
  assert.ok(cnHolds(db).includes('CREDIT_NOTE_VERDICT_CONTRADICTION'), 'the credit-note hold is still OPEN'); assert.equal(replRow(db).upload_status, 'uploaded');
});
test('D12 a REFUND row with an Invoice status on the credit note key leaves an open credit-note hold OPEN', async () => {
  const { api, db, seq } = await setup(); openCreditNoteHold(db, seller.id, KEY, 'CREDIT_NOTE_IDENTITY_UNPROVEN', [{ c: 'invoice-number', why: 'x' }], {});
  const row = rv('InvoiceUploaded'); row[ix('invoice-number')] = 'Z'; await ing(db, api, doc(row), { reportAttemptSeq: seq, reportRequestedAt: T1 });
  assert.ok(cnHolds(db).includes('CREDIT_NOTE_IDENTITY_UNPROVEN')); assert.equal(db.prepare("SELECT count(*) n FROM integrity_findings WHERE code='REFUND_ROW_INVOICE_STATUS' AND status='OPEN'").get().n, 1);
});
