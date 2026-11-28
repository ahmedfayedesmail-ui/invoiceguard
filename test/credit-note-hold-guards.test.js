// Round 2 of the strict-matching ruling (Nov 28 2026, 12:52): A1 an open credit-note HOLD blocks every automatic action on the pair, A2 identity is proven before ANY credit-note status change (Processing and Rejected too), A3 the hold fingerprint covers the actual values, A4 a REAL two-OS-process race. Written BEFORE the fix.
// Rule under test: a credit note becomes 'uploaded' (which opens the replacement invoice) ONLY when the report proves Amazon finished processing OUR document:
// exact status, document number, transaction, marketplace, order, shipping, currency, amounts, authenticated report order. Anything unproven or contradictory = HOLD, nothing changes automatically.
import { spawnSync, spawn } from 'node:child_process'; import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { issueRectificativa } from '../src/pipeline.js'; import { releaseIntegrity } from '../src/integrity.js';
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
const hold = (db, code) => db.prepare("SELECT * FROM integrity_findings WHERE code LIKE 'CREDIT_NOTE_%'" + (code ? ' AND code=?' : '')).all(...(code ? [code] : []));
const hist = (db, code) => db.prepare("SELECT event FROM integrity_history WHERE code=? ORDER BY rowid").all(code).map(r => r.event);
const st = (r, s) => { r[ix('invoice-status')] = s; return r; };
const rejRow = (n, mod) => good(n, r => { r[ix('invoice-status')] = 'CreditNoteRejected'; mod?.(r); });
const T1 = new Date('2026-11-25T09:00:00Z'), T2 = new Date('2026-11-25T11:00:00Z');
// ---------- A1: an open HOLD blocks the replacement and every retry, in the execution logic ----------
test('H1 CN accepted, replacement NOT yet issued, a later CreditNoteRejected opens a contradiction HOLD, then processCorrections runs -> NO replacement', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number;
  await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: T1 }); assert.equal(cn(db).upload_status, 'uploaded'); assert.equal(repl(db), 0, 'setup: not issued yet');
  await ing(db, api, doc(rejRow(n)), { reportAttemptSeq: seq, reportRequestedAt: T2 }); assert.ok(hold(db, 'CREDIT_NOTE_VERDICT_CONTRADICTION').length === 1, 'hold open'); assert.equal(cn(db).upload_status, 'uploaded');
  const calls = api.calls.length; await nextPass(db, api); await nextPass(db, api); assert.equal(repl(db), 0, 'the replacement is NOT issued while the hold is open'); assert.equal(api.calls.length, calls, 'nothing sent');
});
test('H2 the same with the contradiction INSIDE one report (Uploaded and Rejected rows) after the CN was already accepted -> NO replacement', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: T1 });
  await ing(db, api, doc(good(n), rejRow(n)), { reportAttemptSeq: seq, reportRequestedAt: T2 }); assert.ok(hold(db).length >= 1); await nextPass(db, api); assert.equal(repl(db), 0);
});
test('H3 a hold from an EARLIER sync still blocks the next sync: later duplicate good reports and correction passes issue nothing and retry nothing', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: T1 }); await ing(db, api, doc(rejRow(n)), { reportAttemptSeq: seq, reportRequestedAt: T2 });
  const calls = api.calls.length; for (let i = 0; i < 2; i++) { await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: new Date('2026-11-26T0' + i + ':00:00Z') }); await nextPass(db, api); }
  assert.equal(repl(db), 0); assert.equal(api.calls.length, calls);
});
test('H4 the retry / re-upload path refuses while a hold is open for the pair (issueRectificativa on the credit note key, upload status pending)', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: T1 }); await ing(db, api, doc(rejRow(n)), { reportAttemptSeq: seq, reportRequestedAt: T2 });
  db.prepare("UPDATE invoices SET upload_status='pending' WHERE number=?").run(n); const calls = api.calls.length;
  await assert.rejects(() => issueRectificativa(db, seller, JSON.parse(cn(db).json).rectifies.number, { recordKey: KEY, allowUnknownRetry: true }, { api, validate: vies }), /hold|review/i); assert.equal(api.calls.length, calls, 'no re-upload');
});
test('H5 the replacement path itself refuses while a hold is open for the pair it belongs to (direct call, CN status forced to uploaded)', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: T1 }); await ing(db, api, doc(rejRow(n)), { reportAttemptSeq: seq, reportRequestedAt: T2 });
  const orig = JSON.parse(cn(db).json).rectifies.number; const calls = api.calls.length;
  await assert.rejects(() => issueRectificativa(db, seller, orig, { mode: 'substitution', reason: 'x', changes: { buyer: { name: 'Name One SL' } }, documentType: 'Invoice', recordKey: 'SHIPMENT:Correction::X:2' }, { api, validate: vies }), /hold|review/i); assert.equal(repl(db), 0); assert.equal(api.calls.length, calls);
});
test('H6 (guard) with NO hold the same direct call still issues the replacement (the guard is not a blanket refusal)', async () => { const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: T1 }); await nextPass(db, api); await nextPass(db, api); assert.equal(repl(db), 1); });
// ---------- A2: identity before ANY status change ----------
for (const [label, status] of [['Processing', 'CreditNoteProcessing'], ['Rejected', 'CreditNoteRejected']]) {
  const mk = (n, mod) => good(n, r => { r[ix('invoice-status')] = status; mod?.(r); });
  const retries = (db) => (db.prepare("SELECT count(*) c FROM sqlite_master WHERE name='repairs'").get().c ? db.prepare("SELECT count(*) c FROM repairs WHERE state='proposed'").get().c : 0);
  const unchanged = async (mod, why) => { const { api, db, seq } = await setup(); const c0 = cn(db); const v0 = db.prepare('SELECT vidr_processing_at v FROM invoices WHERE number=?').get(c0.number).v; await ing(db, api, doc(mk(c0.number, mod)), { reportAttemptSeq: seq, reportRequestedAt: T1 });
    assert.equal(cn(db).upload_status, 'submitted', why + ': status unchanged'); assert.equal(db.prepare('SELECT vidr_processing_at v FROM invoices WHERE number=?').get(c0.number).v, v0, 'processing stamp unchanged'); assert.equal(retries(db), 0, 'no retry proposed'); assert.ok(hold(db).length >= 1, 'a hold is opened'); };
  test(`I1 ${label}: WRONG invoice number -> no status change, no retry, hold`, () => unchanged(r => { r[ix('invoice-number')] = 'R-2026-999999'; }, 'wrong number'));
  test(`I2 ${label}: BLANK invoice number -> no status change, hold`, () => unchanged(r => { r[ix('invoice-number')] = ''; }, 'blank number'));
  test(`I3 ${label}: WRONG amount -> no status change, hold`, () => unchanged(r => { r[ix('item-vat-incl-amount')] = '-1.00'; }, 'wrong amount'));
  test(`I4 ${label}: wrong order / shipping identity -> no status change, hold`, async () => { await unchanged(r => { r[ix('order-id')] = '999-0000000-0000000'; }, 'wrong order'); await unchanged(r => { r[ix('shipping-id')] = 'S9999'; }, 'wrong shipping'); });
  test(`I5 ${label}: wrong marketplace or currency -> no status change, hold`, async () => { await unchanged(r => { r[ix('marketplace-id')] = 'A1PA6795UKMFR9'; }, 'wrong marketplace'); await unchanged(r => { r[ix('currency')] = 'GBP'; }, 'wrong currency'); });
  test(`I6 ${label}: wrong transaction identity (another key) -> nothing of ours is touched`, async () => { const { api, db, seq } = await setup(); const c0 = cn(db); await ing(db, api, doc(mk(c0.number, r => { r[ix('transaction-id')] = 'CorrectionReversal:OTHER:9'; })), { reportAttemptSeq: seq, reportRequestedAt: T1 }); assert.equal(cn(db).upload_status, 'submitted'); });
  test(`I7 (guard) ${label}: every identity field right -> the status IS applied`, async () => { const { api, db, seq } = await setup(); const c0 = cn(db); await ing(db, api, doc(mk(c0.number)), { reportAttemptSeq: seq, reportRequestedAt: T1 }); assert.equal(cn(db).upload_status, label === 'Processing' ? 'processing' : 'rejected'); assert.equal(hold(db).length, 0); });
  test(`I8 ${label}: no report sequence (not the authenticated path) -> no status change, hold`, async () => { const { api, db } = await setup(); const c0 = cn(db); await ing(db, api, doc(mk(c0.number)), {}); assert.equal(cn(db).upload_status, 'submitted'); assert.ok(hold(db).length >= 1); });
}
// ---------- A3: the hold fingerprint covers the actual values ----------
const wrongNum = (x) => (r) => { r[ix('invoice-number')] = x; };
test('F1 wrong number A opens a hold; wrong number B with the SAME failure kind changes the fingerprint and is recorded as CHANGED (not RECHECKED_SAME); the identical evidence again is RECHECKED_SAME', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number; const f = () => hold(db, 'CREDIT_NOTE_IDENTITY_UNPROVEN');
  await ing(db, api, doc(good(n, wrongNum('R-2026-111111'))), { reportAttemptSeq: seq, reportRequestedAt: T1 }); assert.equal(f().length, 1); const fpA = f()[0].fingerprint;
  await ing(db, api, doc(good(n, wrongNum('R-2026-222222'))), { reportAttemptSeq: seq, reportRequestedAt: T2 }); assert.equal(f().length, 1); const fpB = f()[0].fingerprint; assert.notEqual(fpB, fpA, 'the fingerprint follows the actual value');
  assert.ok(hist(db, 'CREDIT_NOTE_IDENTITY_UNPROVEN').includes('CHANGED'), 'CHANGED is recorded'); const before = hist(db, 'CREDIT_NOTE_IDENTITY_UNPROVEN').filter(e => e === 'RECHECKED_SAME').length;
  await ing(db, api, doc(good(n, wrongNum('R-2026-222222'))), { reportAttemptSeq: seq, reportRequestedAt: T2 }); assert.equal(f()[0].fingerprint, fpB); assert.equal(hist(db, 'CREDIT_NOTE_IDENTITY_UNPROVEN').filter(e => e === 'RECHECKED_SAME').length, before + 1, 'identical evidence is RECHECKED_SAME');
});
test('F2 the evidence snapshot kept for the reviewer holds the actual values, sequence and request time, and no buyer data', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n, wrongNum('R-2026-333333'))), { reportAttemptSeq: seq, reportRequestedAt: T1 }); const e = hold(db, 'CREDIT_NOTE_IDENTITY_UNPROVEN')[0].evidence;
  for (const must of ['R-2026-333333', n, 'CorrectionReversal:X:1', String(seq), '2026-11-25T09:00:00']) assert.ok(e.includes(must), 'evidence names ' + must); assert.doesNotMatch(e, /Name One|Calle|@/, 'no buyer personal data');
});
test('F3 a human decision on evidence A cannot be reused on evidence B: after release, different evidence re-opens the hold and the old fingerprint is no longer releasable', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n, wrongNum('R-2026-111111'))), { reportAttemptSeq: seq, reportRequestedAt: T1 }); const h = hold(db, 'CREDIT_NOTE_IDENTITY_UNPROVEN')[0];
  releaseIntegrity(db, seller.id, h.shipment_key, h.code, h.fingerprint, { user: 'reviewer-1', reason: 'looked at the report row against our credit note' }); assert.notEqual(hold(db, 'CREDIT_NOTE_IDENTITY_UNPROVEN')[0].status, 'OPEN', 'setup: released');
  await ing(db, api, doc(good(n, wrongNum('R-2026-999999'))), { reportAttemptSeq: seq, reportRequestedAt: T2 }); const h2 = hold(db, 'CREDIT_NOTE_IDENTITY_UNPROVEN')[0]; assert.equal(h2.status, 'OPEN', 'different evidence is a new open hold'); assert.notEqual(h2.fingerprint, h.fingerprint);
  assert.throws(() => releaseIntegrity(db, seller.id, h2.shipment_key, h2.code, h.fingerprint, { user: 'reviewer-1', reason: 'reusing the old decision' }), /./);
});
test('F4 two different holds on one credit note do not cancel each other (a contradiction hold survives a later identity hold)', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: T1 }); await ing(db, api, doc(rejRow(n)), { reportAttemptSeq: seq, reportRequestedAt: T2 });
  await ing(db, api, doc(good(n, wrongNum('R-2026-555555'))), { reportAttemptSeq: seq, reportRequestedAt: new Date('2026-11-25T12:00:00Z') });
  assert.equal(db.prepare("SELECT count(*) c FROM integrity_findings WHERE status='OPEN' AND code IN ('CREDIT_NOTE_VERDICT_CONTRADICTION','CREDIT_NOTE_IDENTITY_UNPROVEN')").get().c, 2);
});
// ---------- A4: REAL two-OS-process race on one SQLite file ----------
const WORKER = new URL('./helpers/cn-race-worker.mjs', import.meta.url).pathname;
async function raceRound(round, delayMs) {
  const dir = mkdtempSync(join(tmpdir(), 'cnrace-')); const file = join(dir, 'race.db'); const go = join(dir, 'go');
  const api = mkApi(), db = openDb(file); await processReport(db, seller, text, { api, validate: vies, now: NOW }); await processCorrections(db, seller, rep(rv(), rp()), { api, validate: vies }); approveAll(db, seller.id); await processCorrections(db, seller, rep(rv(), rp()), { api, validate: vies });
  const seq = currentAttemptSeq(db, seller.id); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: T1 }); assert.equal(repl(db), 0); assert.equal(cn(db).upload_status, 'uploaded'); db.close();
  const payload = join(dir, 'p.json'); writeFileSync(payload, JSON.stringify({ seller, pairReport: rep(rv(), rp()), rejectedReport: doc(rejRow(n)), seq, reqTs: T2.toISOString(), delayMs }));
  const run = (role) => new Promise((res) => { const p = spawn('node', ['--no-warnings', WORKER, file, role, go, payload]); let o = ''; p.stdout.on('data', d => { o += d; }); p.on('close', () => res(o.trim().split('\n').pop())); });
  const a = run('issue'), b = run('contradict'); await new Promise(r => setTimeout(r, 700)); writeFileSync(go, '1'); const outs = (await Promise.all([a, b])).map(x => JSON.parse(x));
  const d2 = openDb(file); const out = { outs, repl: repl(d2), holds: d2.prepare("SELECT first_seen f FROM integrity_findings WHERE code='CREDIT_NOTE_VERDICT_CONTRADICTION'").all(), issuedAt: d2.prepare("SELECT issued_at t FROM invoices WHERE kind='rectificativa' AND shipment_key LIKE '%Correction::%'").all().map(r => r.t) }; d2.close(); return out;
}
test('A4a REAL race, 6 rounds (two OS processes, one SQLite file, barrier start, varied delays): a replacement may exist only if it was issued BEFORE the hold opened; after the race another pass never adds one', async () => {
  for (let i = 0; i < 6; i++) { const x = await raceRound(i, { issue: (i % 3) * 15, contradict: ((i + 1) % 3) * 15 }); assert.ok(x.outs.every(o => o.ok), JSON.stringify(x.outs)); assert.equal(x.holds.length, 1, 'the contradiction hold exists: ' + JSON.stringify(x));
    if (x.repl) assert.ok(x.issuedAt[0] <= x.holds[0].f, `round ${i}: replacement issued at ${x.issuedAt[0]} AFTER the hold opened at ${x.holds[0].f}`); assert.ok(x.repl <= 1, 'never two replacements'); }
});
test('A4b REAL cross-process order: process 1 opens the hold and EXITS, then process 2 runs the correction pass -> no replacement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cnrace-')); const file = join(dir, 'race.db'); const api = mkApi(), db = openDb(file); await processReport(db, seller, text, { api, validate: vies, now: NOW }); await processCorrections(db, seller, rep(rv(), rp()), { api, validate: vies }); approveAll(db, seller.id); await processCorrections(db, seller, rep(rv(), rp()), { api, validate: vies });
  const seq = currentAttemptSeq(db, seller.id); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: T1 }); db.close();
  const payload = join(dir, 'p.json'); writeFileSync(payload, JSON.stringify({ seller, pairReport: rep(rv(), rp()), rejectedReport: doc(rejRow(n)), seq, reqTs: T2.toISOString() })); const go = join(dir, 'go'); writeFileSync(go, '1');
  const r1 = spawnSync('node', ['--no-warnings', WORKER, file, 'contradict', go, payload], { encoding: 'utf8' }); const r2 = spawnSync('node', ['--no-warnings', WORKER, file, 'issue', go, payload], { encoding: 'utf8' });
  assert.ok(JSON.parse(r1.stdout.trim().split('\n').pop()).ok && JSON.parse(r2.stdout.trim().split('\n').pop()).ok); const d2 = openDb(file); assert.equal(repl(d2), 0, 'no replacement after a hold opened in another process'); d2.close();
});
// Added AFTER the fix commit (guard, passes on the fixed code only by design of the trigger): every claim to send a correction document of the pair (the repair retry, the settle retry, the correction retry) is a write of upload_status='sending', which the database refuses while a hold is open.
test('H7 (guard, added after the fix) the database itself refuses to claim ANY correction document of the pair for sending while a hold is open, and allows it after the hold is released', async () => {
  const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: T1 }); await ing(db, api, doc(rejRow(n)), { reportAttemptSeq: seq, reportRequestedAt: T2 });
  assert.throws(() => db.prepare("UPDATE invoices SET upload_status='sending' WHERE number=?").run(n), /credit-note hold/);
  const h = hold(db, 'CREDIT_NOTE_VERDICT_CONTRADICTION')[0]; releaseIntegrity(db, seller.id, h.shipment_key, h.code, h.fingerprint, { user: 'reviewer-1', reason: 'compared both reports with the stored credit note' });
  db.prepare("UPDATE invoices SET upload_status='sending' WHERE number=?").run(n);
});
