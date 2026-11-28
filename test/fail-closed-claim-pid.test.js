// Fail-closed fixes round (Ahmed ruling B1/B2, Nov 28 2026): mandatory claim identity on the CorrectionReversal issuance path; a missing or invalid stored PID is never proof of process death. Written BEFORE the fix.
// 1 no auto-release ever. 2 time alone never proves abandonment. 3 no release with a document or an unsettled upload. 4 verify nothing active owns the claim. 5 every release is a documented HUMAN_DECISION (user, reason, time, fingerprint). 6 full history of claim creation and release.
import { procStart } from '../src/lease.js';
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { openDb } from '../src/db.js';
import { processReport, processCorrections, issueRectificativa, reviewAtomic } from '../src/pipeline.js'; import { parseVidr } from '../src/vidr.js'; import { approveAll } from './correction-helpers.js';
import { writeFileSync, rmSync, mkdtempSync, readlinkSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { spawn } from 'node:child_process';
import { listStuckClaims, openStuckClaimReview, releaseStuckClaim } from '../src/claims.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const vies = async (v) => ({ status: 'valid', vat: v }); const mkApi = () => ({ calls: [], uploadInvoice: async function (a) { this.calls.push(a); return 'f' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }) });
const [head, ...body] = text.trim().split('\n'); const cols = head.split('\t'); const ix = n => cols.indexOf(n); const base = body[0].split('\t');
const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const rev = (id) => { const r = [...base]; r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = id; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = 'CreditNotePending'; return r.join('\t'); };
const rep = (id) => { const f = [...base]; f[ix('transaction-id')] = id; f[ix('billing-name')] = 'Name One SL'; return f.join('\t'); };
const REPORT = [head, rev('CorrectionReversal:X:1'), rep('Correction::X:2')].join('\n'); const KEY = 'REFUND:CorrectionReversal:X:1';
const START = new Date('2026-11-24T12:00:00Z');
// a process that has really ended: its pid is free (waited for), so the lease it left behind names a dead owner
const deadPid = () => new Promise(res => { const p = spawn('node', ['-e', '0']); const pid = p.pid; p.on('close', () => res(pid)); });
async function crashed(db) { const pid = await deadPid(); try { db.prepare('UPDATE claim_leases SET pid=?').run(pid); } catch { /* before the lease exists (pre-fix run): nothing to mark */ } return pid; }
// a claim exactly as a crash between the claim and the document insert leaves it: approved pair, claim reserved, no document
async function stuck() {
  const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: START });
  await processCorrections(db, seller, REPORT, { api, validate: vies }); approveAll(db, seller.id);
  const list = parseVidr(REPORT).filter(s => s.isCorrectionReversal || s.isCorrectedTx); const r = list.find(s => s.isCorrectionReversal);
  const o = db.prepare("SELECT number, json FROM invoices WHERE shipment_key='SHIPMENT:S1001' AND kind='invoice'").get();
  const g = reviewAtomic(db, seller, r, o, list, true, { vies: [{ vat: r.buyerVat ?? list.find(s => s.isCorrectedTx)?.buyerVat, status: 'valid' }] }); assert.equal(g, null, 'setup: the approved pair reserved its claim');
  db.prepare('UPDATE credit_claims SET claimed_at=? WHERE reversal_key=?').run('2026-11-20T00:00:00.000Z', KEY); // old
  await crashed(db); // the process that reserved it ended (a crash between the claim and the document)
  return { api, db, o, list, r };
}
const claimCount = (db) => db.prepare('SELECT count(*) c FROM credit_claims').get().c;
const issueWith = (db, api, o, extra) => { const j = JSON.parse(o.json); return issueRectificativa(db, seller, o.number, { mode: 'differences', reason: 'x', changes: { lines: j.lines.map(l => ({ ...l, excl: 0, vat: 0 })) }, documentType: 'CreditNote', recordKey: KEY, ...extra }, { api, validate: vies }); };
const docs = (db) => db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa'").get().c;
const heldId = (db) => db.prepare('SELECT claim_id FROM credit_claims WHERE reversal_key=?').get(KEY).claim_id;
test('F1: a held claim and NO claimId (option absent) -> issuance refused, nothing written', async () => {
  const { api, db, o } = await stuck(); const n0 = api.calls.length; await assert.rejects(() => issueWith(db, api, o, {}), /claim/i); assert.equal(docs(db), 0); assert.equal(api.calls.length, n0, 'nothing uploaded'); assert.equal(claimCount(db), 1, 'the claim is untouched');
});
test('F2: a held claim and claimId = null -> refused', async () => { const { api, db, o } = await stuck(); const n0 = api.calls.length; await assert.rejects(() => issueWith(db, api, o, { claimId: null }), /claim/i); assert.equal(docs(db), 0); assert.equal(api.calls.length, n0); });
test('F2b: a held claim and claimId = undefined / empty string -> refused', async () => { const { api, db, o } = await stuck(); for (const v of [undefined, '']) await assert.rejects(() => issueWith(db, api, o, { claimId: v }), /claim/i, String(v)); assert.equal(docs(db), 0); });
test('F3: a held claim and a WRONG claimId -> refused', async () => { const { api, db, o } = await stuck(); await assert.rejects(() => issueWith(db, api, o, { claimId: 'not-the-claim' }), /claim/i); assert.equal(docs(db), 0); assert.equal(claimCount(db), 1); });
test('F3b: a claimId that differs from the held one only by case or a trailing space is refused (exact literal match)', async () => { const { api, db, o } = await stuck(); const id = heldId(db); for (const v of [id.toUpperCase(), id + ' ']) await assert.rejects(() => issueWith(db, api, o, { claimId: v }), /claim/i); assert.equal(docs(db), 0); });
test('F4: NO claim held at all and a claimId given -> refused', async () => { const { api, db, o } = await stuck(); db.prepare('DELETE FROM credit_claims WHERE reversal_key=?').run(KEY); await assert.rejects(() => issueWith(db, api, o, { claimId: 'x' }), /claim/i); assert.equal(docs(db), 0); });
test('F5 (guard): the EXACT held claimId issues exactly one credit note', async () => { const { api, db, o } = await stuck(); const n0 = api.calls.length; await issueWith(db, api, o, { claimId: heldId(db) }); assert.equal(docs(db), 1); assert.equal(api.calls.length, n0 + 1); });
test('F5b (guard): the normal approved path (processCorrections) still issues the pair with the claim identity it reserved', async () => {
  const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: START }); await processCorrections(db, seller, REPORT, { api, validate: vies }); approveAll(db, seller.id);
  await processCorrections(db, seller, REPORT, { api, validate: vies }); assert.equal(docs(db), 1, 'the credit note was issued by the normal path');
});
// ---- B2: stored PID validation ----
const leaseWith = (db, pid) => db.prepare('UPDATE claim_leases SET pid=?').run(pid);
const owner = (db) => listStuckClaims(db, seller.id)[0].activeIssuance;
for (const [label, v] of [['null', null], ['zero', 0], ['negative', -7], ['non-integer 1.5', 1.5], ['text', 'abc'], ['empty text', ''], ['NaN-like text', 'NaN'], ['huge', 2 ** 53]]) {
  test(`P1 (${label}): a stored PID that is not a positive integer is UNPROVEN, never gone; review and release refused`, async () => {
    const { db } = await stuck(); leaseWith(db, v); const s = owner(db); assert.equal(s.proven, false, 'proven must be false'); assert.notEqual(s.state, 'gone'); assert.equal(s.state, 'unproven');
    assert.throws(() => openStuckClaimReview(db, seller.id, KEY), /cannot prove|not proven|owner/i);
    assert.throws(() => releaseStuckClaim(db, seller.id, KEY, 'f'.repeat(64), { user: 'u', reason: 'a long enough reason' }), /./); assert.equal(claimCount(db), 1, 'the claim is still held');
  });
}
test('P2: the PID column is missing from the row (lease row removed) -> unproven', async () => { const { db } = await stuck(); db.prepare('DELETE FROM claim_leases').run(); const s = owner(db); assert.equal(s.proven, false); assert.equal(s.state, 'unproven'); });
test('P3 (guard): an absent PID with matching boot, host and namespace is proven gone (real ended process)', async () => { const { db } = await stuck(); const s = owner(db); assert.equal(s.state, 'gone'); assert.equal(s.proven, true); });
test('P4 (guard): an existing valid PID with matching identity (this process) is alive, not gone', async () => { const { db } = await stuck(); db.prepare('UPDATE claim_leases SET pid=?, proc_start=?').run(process.pid, procStart(process.pid)); const s = owner(db); assert.equal(s.state, 'alive'); assert.equal(s.proven, false); });
test('P5: a pid whose kill probe fails with an error other than "no such process" (e.g. invalid argument) is never proof of absence', async () => { const { db } = await stuck(); leaseWith(db, 2 ** 31); const s = owner(db); assert.equal(s.proven, false); assert.notEqual(s.state, 'gone'); });
