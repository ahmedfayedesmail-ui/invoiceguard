// Usable HOLD flow (owner decision Nov 28 16:30): one inbox, plain reasons, the action that resolves each hold, notes with history. Seller-experience only: no financial rule changes.
import test from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { writeLedger } from '../src/integrity.js';
import { openCreditNoteHold } from '../src/cn-gate.js';
import { openOriginalHold, openReturnHold } from '../src/orig-gate.js';
import { listHolds, explainFinding, decideHold, addHoldNote, HOLD_GUIDE, holdSummary } from '../src/holds.js';
import { processReport } from '../src/pipeline.js';
import { listRepairs, authorizeUnknownRetry } from '../src/repair.js';
import { authorizeRetry } from './helpers/prove-verdict.js';

const SID = 'selH';
const full = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const one = (([h, r]) => [h, r].join('\n'))(full.trim().split('\n'));
const vies = async (v) => ({ status: 'valid', vat: v });
const seller = { id: SID, name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const BAD = /undefined|\bnull\b|NaN|\[object|\b[A-Z]{3,}(?:_[A-Z0-9]+)+\b|\d{4}-\d\d-\d\dT\d\d:\d\d[^ ]*Z/;
const visible = (x) => JSON.stringify({ title: x.title, happened: x.happened, why: x.why, known: x.known, unknown: x.unknown, allowed: x.allowed, blocked: x.blocked, next: x.next, resolutions: (x.resolutions ?? []).map(r => r.text), held: x.held?.text, residualRisk: x.residualRisk });

// ---- HF1: coverage. Every code the source can emit as HOLD or BLOCK has plain guidance ----
test('HF1 every HOLD/BLOCK code emitted anywhere in src/ has a plain title and at least one resolution', () => {
  const codes = new Set(); const files = readdirSync(new URL('../src/', import.meta.url)).filter(f => f.endsWith('.js'));
  for (const f of files) { const s = readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
    for (const m of s.matchAll(/add\('([A-Z_]+)', '(?:HOLD|BLOCK)'/g)) codes.add(m[1]);
    for (const m of s.matchAll(/code: '([A-Z_]+)', severity: '(?:HOLD|BLOCK)'/g)) codes.add(m[1]);
    for (const m of s.matchAll(/openCreditNoteHold\([^)]*?'([A-Z_]+)'/g)) codes.add(m[1]);
    for (const m of s.matchAll(/ok: false, code: '(CREDIT_NOTE_[A-Z_]+)'/g)) codes.add(m[1]);
    for (const m of s.matchAll(/(?:ORIG_HOLD|RETURN_HOLD) = '([A-Z_]+)'/g)) codes.add(m[1]);
    for (const m of s.matchAll(/code: '(CORRECTION_[A-Z_]+)'/g)) codes.add(m[1]);
    for (const m of s.matchAll(/export const [A-Z_]+ = '([A-Z][A-Z_]+)';/g)) if (/^(CORRECTION_|CREDIT_NOTE_|ORIGINAL_|RETURN_|REFUND_)/.test(m[1])) codes.add(m[1]); }  // review P1-1: codes emitted through exported constants
  assert.ok(codes.size >= 20, 'the scan found the codes: ' + codes.size);
  for (const c of codes) { const g = HOLD_GUIDE[c]; assert.ok(g, `${c} has guidance`); assert.ok(g.title && !BAD.test(g.title), `${c} title is plain: ${g.title}`); assert.ok(g.resolutions?.length >= 1, `${c} has a resolution`); }
  for (const [c, g] of Object.entries(HOLD_GUIDE)) for (const r of g.resolutions) { assert.ok(['NEW_EVIDENCE', 'MANUAL', 'NONE'].includes(r.type), c + ' type'); assert.ok(['you', 'amazon', 'nobody'].includes(r.who), c + ' who'); assert.ok(r.text.length > 15 && !BAD.test(r.text), `${c} resolution text is plain: ${r.text}`); }
});

// ---- HF2: rendering. No "undefined", raw codes or UTC times for any code, even with empty or hostile evidence ----
test('HF2 every code renders plain text from empty, missing and hostile evidence', () => {
  for (const code of Object.keys(HOLD_GUIDE)) for (const ev of [null, '{}', 'not json', JSON.stringify({ documentNumber: '<img src=x onerror=1>', snapshot: { documentNumbers: ['<b>'], statuses: [] }, failed: [] }), JSON.stringify({ number: 'A'.repeat(5000) })]) {
    const x = explainFinding({ shipment_key: 'SHIPMENT:K1', code, severity: 'HOLD', resolution: 'NEW_EVIDENCE', status: 'OPEN', fingerprint: 'f'.repeat(64), evidence: ev, explanation: null, first_seen: '2026-11-28T10:00:00.000Z', last_seen: '2026-11-28T10:00:00.000Z', seen_count: 1 });
    const v = visible(x); assert.ok(!BAD.test(v), `${code}: ${v.match(BAD)?.[0]}`); assert.ok(v.length < 12000, code + ' length bounded'); assert.ok(x.title && x.resolutions.length >= 1, code);
  }
});

// ---- HF3: the three ruling-5 / credit note holds from the REAL gate functions ----
function ledgerDb() { const db = openDb(); return db; }
test('HF3a original verdict hold: plain reason, new-evidence resolution, held summary, no decision form', () => {
  const db = ledgerDb(); openOriginalHold(db, SID, 'SHIPMENT:S1', [{ c: 'invoice-number', why: 'The report does not name our invoice number.' }], { number: 'A-2026-000001', status: 'InvoiceUploaded', reportSeq: 3 });
  const [x] = listHolds(db, SID); assert.equal(x.code, 'ORIGINAL_INVOICE_VERDICT_UNPROVEN'); assert.match(x.title, /could not be confirmed/i);
  assert.equal(x.kind, 'WAITING_ON_EVIDENCE'); assert.ok(x.resolutions.some(r => r.type === 'NEW_EVIDENCE' && r.who === 'you')); assert.equal(x.releasable, false);
  assert.match(x.held.text, /A-2026-000001/); assert.ok(!BAD.test(visible(x)), visible(x).match(BAD)?.[0]);
  assert.throws(() => decideHold(db, SID, { key: 'SHIPMENT:S1', code: x.code, fingerprint: x.fingerprint, reason: 'I looked at it and it is fine' }, 'u'), /new evidence/i);
});
test('HF3b return row hold and REFUND row hold: nobody can release; the card says so', () => {
  const db = ledgerDb(); openReturnHold(db, SID, { key: 'RETURN:T1', invoiceStatus: 'InvoiceUploaded', rowMeta: [{ transactionId: 'T1', orderId: 'O1' }] }, { reportSeq: 1 });
  writeLedger(db, SID, 'REFUND:T2', [{ code: 'REFUND_ROW_INVOICE_STATUS', severity: 'HOLD', resolution: 'NEW_EVIDENCE', evidence: { field: 'refund-row-invoice-status', reportStatus: 'InvoiceUploaded' }, fingerprint: 'a'.repeat(64), explanation: 'A refund row carries an invoice status.', action: 'x' }], { partial: true });
  const hs = listHolds(db, SID); assert.equal(hs.length, 2);
  const ref = hs.find(h => h.code === 'REFUND_ROW_INVOICE_STATUS'), ret = hs.find(h => h.code === 'RETURN_ROW_INVOICE_STATUS');
  assert.equal(ref.kind, 'NO_RELEASE'); assert.ok(ref.resolutions.some(r => r.type === 'NONE' && r.who === 'nobody' && /no one can release/i.test(r.text)));
  assert.equal(ret.kind, 'WAITING_ON_EVIDENCE'); for (const h of hs) { assert.equal(h.releasable, false); assert.ok(!BAD.test(visible(h)), visible(h).match(BAD)?.[0]); }
  assert.throws(() => decideHold(db, SID, { key: 'REFUND:T2', code: 'REFUND_ROW_INVOICE_STATUS', fingerprint: 'a'.repeat(64), reason: 'please release this one' }, 'u'));
});
test('HF3c credit note identity hold stays decidable by a person (existing rule), and the card says what a decision does and does not do', () => {
  const db = ledgerDb(); openCreditNoteHold(db, SID, 'REFUND:CorrectionReversal:X:1', 'CREDIT_NOTE_IDENTITY_UNPROVEN', [{ c: 'invoice-number', why: 'The report names another document.' }]);
  const [x] = listHolds(db, SID); assert.equal(x.kind, 'WAITING_ON_YOU'); assert.equal(x.releasable, true); assert.ok(x.resolutions.some(r => r.type === 'MANUAL' && r.who === 'you'));
  assert.match(x.next, /Nothing is applied by the decision itself/);
});
test('HF3d a BLOCK (rows contradict each other) offers only a corrected file', () => {
  const db = ledgerDb(); writeLedger(db, SID, 'SHIPMENT:B1', [{ code: 'SHIPMENT_FIELD_CONFLICT', severity: 'BLOCK', resolution: null, evidence: { field: 'buyer-vat', lines: [2, 3] }, fingerprint: 'b'.repeat(64), explanation: 'The rows of this shipment disagree on the buyer VAT number.', action: 'x' }]);
  const [x] = listHolds(db, SID); assert.equal(x.kind, 'WAITING_ON_EVIDENCE'); assert.equal(x.releasable, false); assert.ok(x.resolutions.every(r => r.type !== 'MANUAL'));
  assert.throws(() => decideHold(db, SID, { key: 'SHIPMENT:B1', code: 'SHIPMENT_FIELD_CONFLICT', fingerprint: 'b'.repeat(64), reason: 'ten characters at least' }, 'u'), /BLOCK/);
});

// ---- HF4: notes and note history ----
function snap(db) { const t = (q) => JSON.stringify(db.prepare(q).all()); return ['SELECT * FROM integrity_findings ORDER BY 1,2,3', 'SELECT * FROM invoices ORDER BY 1,2', 'SELECT * FROM shipments ORDER BY 1,2', 'SELECT * FROM repairs ORDER BY 1,2', 'SELECT * FROM integrity_decisions'].map(q => { try { return t(q); } catch { return ''; } }).join('|'); }
test('HF4 a note is recorded, shown in the note history, and changes no state at all; empty, unknown and anonymous notes are refused', () => {
  const db = ledgerDb(); openOriginalHold(db, SID, 'SHIPMENT:S1', [{ c: 'amounts', why: 'The amounts differ.' }], { number: 'A-2026-000001', status: 'InvoiceUploaded', reportSeq: 3 });
  const [x] = listHolds(db, SID); const before = snap(db);
  const r = addHoldNote(db, SID, { key: x.key, code: x.code, note: 'Asked the seller for the All view report.' }, 'seller@example.test'); assert.equal(r.stateChanged, false);
  addHoldNote(db, SID, { key: x.key, code: x.code, note: '<script>alert(1)</script>' }, 'seller@example.test');
  assert.equal(snap(db), before, 'findings, invoices, shipments, repairs and decisions are unchanged');
  const [y] = listHolds(db, SID); assert.equal(y.notes.length, 2); assert.equal(y.notes[0].by, 'seller@example.test'); assert.equal(y.notes[0].note, '<script>alert(1)</script>', 'stored as plain text, newest first'); assert.match(y.notes[1].at, /^\d{4}-/);
  assert.equal(y.status, 'OPEN'); assert.equal(y.kind, 'WAITING_ON_EVIDENCE');
  assert.throws(() => addHoldNote(db, SID, { key: x.key, code: x.code, note: '  ' }, 'u'), /Write the note/); assert.throws(() => addHoldNote(db, SID, { key: 'NOPE', code: x.code, note: 'text' }, 'u'), /no such item/); assert.throws(() => addHoldNote(db, SID, { key: x.key, code: x.code, note: 'text' }, ''), /user/);
  assert.equal(listHolds(db, 'otherSeller').length, 0, 'notes and holds never cross sellers');
});

// ---- HF5: one inbox: unknown-outcome and LATE_FEED items live in the same list with their forms ----
async function unknownDoc() {
  const db = openDb(); let calls = 0, fail = true;
  const api = { uploadInvoice: async () => { calls++; if (fail) { const e = new Error('socket hang up'); e.unknownOutcome = true; throw e; } return 'f' + calls; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, one, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') }); fail = false;
  const inv = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(SID);
  return { db, api, inv, hold: listRepairs(db, SID).find(r => r.kind === 'unknown_outcome'), sync: () => processReport(db, seller, one, { api, validate: vies }), calls: () => calls };
}
test('HF5a an unknown upload outcome is in the Holds inbox with the authorize-one-retry form, the residual risk, and leaves when authorized', async () => {
  const d = await unknownDoc(); const hs = listHolds(d.db, SID); const x = hs.find(h => h.source === 'repair'); assert.ok(x, 'the repair hold is listed');
  assert.equal(x.kind, 'WAITING_ON_YOU'); assert.equal(x.form, 'authorize_retry'); assert.equal(x.key, d.hold.event_key); assert.match(x.residualRisk, /two submissions/); assert.ok(x.resolutions.some(r => r.type === 'MANUAL' && r.who === 'you'));
  assert.match(x.held.text, new RegExp(d.inv.number)); assert.ok(!BAD.test(visible(x)), visible(x).match(BAD)?.[0]); assert.equal(x.releasable, false, 'no generic release');
  await d.sync(); assert.equal(d.calls(), 1, 'listing never resends');
  await authorizeRetry(d.db, SID, x.key); assert.equal(listHolds(d.db, SID).filter(h => h.source === 'repair').length, 0, 'the authorized hold is no longer waiting');
  assert.equal(listHolds(d.db, SID, { includeClosed: true }).filter(h => h.source === 'repair').length, 1, 'but it stays in the closed list');
});
test('HF5b a LATE_FEED item shows the confirm-this-feed form; notes work on repair items too and change nothing', async () => {
  const d = await unknownDoc(); const row = d.db.prepare("SELECT shipment_key sk FROM invoices WHERE seller_id=? AND number=?").get(SID, d.inv.number); const fk = `LATE_FEED:${row.sk}:feedZZ`;
  d.db.prepare("INSERT INTO repairs (seller_id, event_key, kind, original_number, shipment_key, reason, suggestion, state, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(SID, fk, 'unknown_outcome', d.inv.number, row.sk, 'A feed landed after the request was abandoned.', JSON.stringify({ number: d.inv.number, action: 'hold' }), 'proposed', new Date().toISOString());
  const x = listHolds(d.db, SID).find(h => h.key === fk); assert.ok(x); assert.equal(x.form, 'confirm_late_feed'); assert.match(x.title, /arrived late/i); assert.ok(!BAD.test(visible(x)), visible(x).match(BAD)?.[0]);
  const before = snap(d.db); addHoldNote(d.db, SID, { key: fk, code: x.code, note: 'Feed ZZ checked in Seller Central, still processing.' }, 'u@example.test'); assert.equal(snap(d.db), before);
  assert.equal(listHolds(d.db, SID).find(h => h.key === fk).notes.length, 1);
});

// ---- HF6: summary ----
test('HF6 the summary counts items by who must act', async () => {
  const d = await unknownDoc(); openOriginalHold(d.db, SID, 'SHIPMENT:S1', [{ c: 'amounts', why: 'x' }], { number: d.inv.number, status: 'InvoiceUploaded', reportSeq: 1 });
  writeLedger(d.db, SID, 'REFUND:T2', [{ code: 'REFUND_ROW_INVOICE_STATUS', severity: 'HOLD', resolution: 'NEW_EVIDENCE', evidence: { field: 'refund-row-invoice-status' }, fingerprint: 'a'.repeat(64), explanation: 'e', action: 'x' }], { partial: true });
  const s = holdSummary(listHolds(d.db, SID)); assert.deepEqual(s, { waitingOnYou: 1, waitingOnEvidence: 1, noRelease: 1, total: 3 });
});

test('HF3e review P1-2: a credit-note hold whose snapshot carries a request time and failed checks shows no UTC time and no raw check ids', () => {
  const db = ledgerDb(); openCreditNoteHold(db, SID, 'REFUND:CorrectionReversal:Y:1', 'CREDIT_NOTE_IDENTITY_UNPROVEN', [{ c: 'invoice-number', why: 'The report names another document.' }], { snapshot: { documentNumbers: ['R-1'], statuses: ['CreditNoteUploaded'], reportRequestedAt: '2026-11-28T10:00:00.000Z' }, number: 'R-2026-000001' });
  const [x] = listHolds(db, SID); assert.ok(!BAD.test(visible(x)), visible(x).match(BAD)?.[0]); assert.ok(!/invoice-number/.test(visible(x).replace(/The report names another document\./g, '')), 'no raw check id');
});
test('HF3f review P1-1: CORRECTION_PAIR_REVIEW has its own title, and its decision form matches the guidance', () => {
  const g = HOLD_GUIDE.CORRECTION_PAIR_REVIEW; assert.ok(g, 'guidance exists'); assert.match(g.title, /return and its replacement/i);
  assert.ok(g.resolutions.some(r => r.type === 'MANUAL' && r.who === 'you' && r.onlyFor === 'HUMAN_DECISION')); assert.ok(g.resolutions.some(r => r.type === 'NEW_EVIDENCE'));
});
