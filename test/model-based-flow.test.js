// Expedition W3-0: model-based (randomized, seeded) test of the credit-note journey. Random sequences of reports, correction passes and human decisions are applied; after EVERY step the invariants are checked against the database.
import { processReport, processCorrections } from '../src/pipeline.js'; import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { openDb, currentAttemptSeq } from '../src/db.js';
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
import { listHolds, decideHold } from '../src/holds.js'; import { approveAll } from './correction-helpers.js';
const rng = (seed) => { seed = Math.imul(seed + 12345, 2654435761) >>> 0; return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; };
const OPS = ['good', 'wrongNumber', 'wrongAmount', 'rejected', 'processing', 'pending', 'pass', 'decide', 'dupGood'];
async function walk(seedN, steps) {
  const R = rng(seedN); const { api, db, seq } = await setup(); const n = cn(db).number; let t = Date.parse('2026-11-25T09:00:00Z'); const log = []; let replAtHoldOpen = null; let everUploaded = false; let provenGoodSeen = false;
  for (let i = 0; i < steps; i++) {
    const op = OPS[Math.floor(R() * OPS.length)]; t += 3600e3; log.push(op); const ts = new Date(t); const x = { reportAttemptSeq: seq, reportRequestedAt: ts };
    const before = { repl: repl(db), status: cn(db).upload_status, holds: holds(db).length };
    if (op === 'good' || op === 'dupGood') { await ing(db, api, doc(good(n)), x); provenGoodSeen = true; }
    else if (op === 'wrongNumber') await ing(db, api, doc(good(n, r => { r[ix('invoice-number')] = 'R-2026-' + String(900000 + Math.floor(R() * 99)); })), x);
    else if (op === 'wrongAmount') await ing(db, api, doc(good(n, r => { r[ix('item-vat-incl-amount')] = '-' + (1 + Math.floor(R() * 9)) + '.00'; })), x);
    else if (op === 'rejected') await ing(db, api, doc(good(n, r => { r[ix('invoice-status')] = 'CreditNoteRejected'; })), x);
    else if (op === 'processing') await ing(db, api, doc(good(n, r => { r[ix('invoice-status')] = 'CreditNoteProcessing'; })), x);
    else if (op === 'pending') await ing(db, api, doc(good(n, r => { r[ix('invoice-status')] = 'CreditNotePending'; })), x);
    else if (op === 'pass') await nextPass(db, api);
    else if (op === 'decide') { const h = listHolds(db, seller.id)[0]; if (h?.releasable) decideHold(db, seller.id, { key: h.key, code: h.code, fingerprint: h.fingerprint, reason: 'model-based test decision on this evidence' }, 'model'); }
    const after = { repl: repl(db), status: cn(db).upload_status, holds: holds(db).length };
    const ctx = `seed ${seedN} steps ${log.join(',')}`;
    // I1: a replacement never exists unless a fully proven acceptance report was ingested at some point
    if (after.repl > 0) assert.ok(provenGoodSeen, 'I1 replacement without proven acceptance: ' + ctx);
    // I2: never more than one replacement, never a duplicate credit note
    assert.ok(after.repl <= 1, 'I2 duplicate replacement: ' + ctx); assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND shipment_key=?").get(KEY).c, 1, 'I2 credit note count: ' + ctx);
    // I3: an uploaded credit note never leaves uploaded
    if (before.status === 'uploaded') assert.equal(after.status, 'uploaded', 'I3 accepted document changed: ' + ctx);
    // I4: no replacement appears in a step that starts with an open hold
    if (before.holds > 0 && op !== 'decide') assert.equal(after.repl, before.repl, 'I4 replacement issued through an open hold: ' + ctx);
    // I5: a status other than the verified ones never appears from a wrongNumber or wrongAmount step alone
    if (op === 'wrongNumber' || op === 'wrongAmount') assert.equal(after.status, before.status, 'I5 unproven row changed status: ' + ctx);
    // I6: submitted credit note + no hold + only unproven rows: still no replacement
    if (!provenGoodSeen) assert.equal(after.repl, 0, 'I6: ' + ctx);
  }
  return log;
}
test('MB1 600 seeded random walks of 8 steps: every invariant holds after every step (I1 to I6)', async () => { let steps = 0; for (let s = 1; s <= 600; s++) { await walk(s, 8); steps += 8; } assert.equal(steps, 4800); });
test('MB2 the walks really exercise the dangerous orders: a hold opens after acceptance in some walk, and a replacement is issued in some walk', async () => {
  let holdAfterAccept = 0, issued = 0; for (let s = 1; s <= 200; s++) { const R = rng(s); const { api, db, seq } = await setup(); const n = cn(db).number; await ing(db, api, doc(good(n)), { reportAttemptSeq: seq, reportRequestedAt: new Date('2026-11-25T09:00:00Z') }); if (R() < 0.5) { await nextPass(db, api); } await ing(db, api, doc(good(n, r => { r[ix('invoice-status')] = 'CreditNoteRejected'; })), { reportAttemptSeq: seq, reportRequestedAt: new Date('2026-11-25T11:00:00Z') }); if (holds(db).length) holdAfterAccept++; if (repl(db)) issued++; }
  assert.ok(holdAfterAccept === 200); assert.ok(issued > 40 && issued < 160, 'both orders covered: ' + issued);
});
