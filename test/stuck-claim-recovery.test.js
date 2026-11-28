// Stuck-claim recovery, failure cases FIRST (Ahmed's six non-negotiables, Nov 28 2026). Written against a stub; see audit/phase-b/pre-fix-run-18-stuck-claims.spec.txt.
// 1 no auto-release ever. 2 time alone never proves abandonment. 3 no release with a document or an unsettled upload. 4 verify nothing active owns the claim. 5 every release is a documented HUMAN_DECISION (user, reason, time, fingerprint). 6 full history of claim creation and release.
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { openDb } from '../src/db.js';
import { processReport, processCorrections, issueRectificativa, reviewAtomic } from '../src/pipeline.js'; import { parseVidr } from '../src/vidr.js'; import { approveAll } from './correction-helpers.js';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { spawn } from 'node:child_process';
import { listStuckClaims, openStuckClaimReview, releaseStuckClaim } from '../src/claims.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const vies = async (v) => ({ status: 'valid', vat: v }); const mkApi = () => ({ calls: [], uploadInvoice: async function (a) { this.calls.push(a); return 'f' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }) });
const [head, ...body] = text.trim().split('\n'); const cols = head.split('\t'); const ix = n => cols.indexOf(n); const base = body[0].split('\t');
const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const rev = (id) => { const r = [...base]; r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = id; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = 'CreditNotePending'; return r.join('\t'); };
const rep = (id) => { const f = [...base]; f[ix('transaction-id')] = id; f[ix('billing-name')] = 'Name One SL'; return f.join('\t'); };
const REPORT = [head, rev('CorrectionReversal:X:1'), rep('Correction::X:2')].join('\n'); const KEY = 'REFUND:CorrectionReversal:X:1';
const START = new Date('2026-11-24T12:00:00Z');
// a claim exactly as a crash between the claim and the document insert leaves it: approved pair, claim reserved, no document
async function stuck() {
  const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: START });
  await processCorrections(db, seller, REPORT, { api, validate: vies }); approveAll(db, seller.id);
  const list = parseVidr(REPORT).filter(s => s.isCorrectionReversal || s.isCorrectedTx); const r = list.find(s => s.isCorrectionReversal);
  const o = db.prepare("SELECT number, json FROM invoices WHERE shipment_key='SHIPMENT:S1001' AND kind='invoice'").get();
  const g = reviewAtomic(db, seller, r, o, list, true, { vies: [{ vat: r.buyerVat ?? list.find(s => s.isCorrectedTx)?.buyerVat, status: 'valid' }] }); assert.equal(g, null, 'setup: the approved pair reserved its claim');
  db.prepare('UPDATE credit_claims SET claimed_at=? WHERE reversal_key=?').run('2026-11-20T00:00:00.000Z', KEY); // old
  return { api, db, o, list, r };
}
const claimCount = (db) => db.prepare('SELECT count(*) c FROM credit_claims').get().c;
const OPTS = { minAgeMs: 0 };
test('K1: time alone never releases: a ten-day-old claim stays after every pass (no auto-release)', async () => {
  const { api, db } = await stuck(); const other = [head, rev('CorrectionReversal:Y:1'), rep('Correction::Y:2')].join('\n');
  for (let i = 0; i < 3; i++) await processCorrections(db, seller, other, { api, validate: vies });
  assert.equal(claimCount(db), 1, 'the claim is still there'); assert.equal(listStuckClaims(db, seller.id, { minAgeMs: 0 }).length, 1, 'it is only LISTED as stuck for a person');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa'").get().c, 0);
});
test('K2: release without an open review finding is refused', async () => { const { db } = await stuck(); assert.throws(() => releaseStuckClaim(db, seller.id, KEY, 'x'.repeat(64), { user: 'reviewer-1', reason: 'the process crashed before the document', ...OPTS }), /no open review|no open finding/i); assert.equal(claimCount(db), 1); });
test('K3: release needs user, reason >= 10 characters and the exact fingerprint', async () => {
  const { db } = await stuck(); const f = openStuckClaimReview(db, seller.id, KEY, OPTS);
  assert.throws(() => releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { reason: 'the process crashed before the document', ...OPTS }), /needs the user/i);
  assert.throws(() => releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'u', reason: 'short', ...OPTS }), /10 characters/i);
  assert.throws(() => releaseStuckClaim(db, seller.id, KEY, 'f'.repeat(64), { user: 'u', reason: 'the process crashed before the document', ...OPTS }), /fingerprint/i);
  assert.equal(claimCount(db), 1);
});
for (const st of ['pending', 'sending', 'unknown', 'submitted', 'ready']) {
  test(`K4 ${st}: a document row for the event (upload ${st}) makes the claim NOT stuck and the release refused`, async () => {
    const { db, o } = await stuck(); const f = openStuckClaimReview(db, seller.id, KEY, OPTS);
    db.prepare("INSERT INTO invoices (seller_id,number,shipment_key,kind,rectifies,issued_at,total,vat,json,feed_id,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(seller.id, 'R-2026-000099', KEY, 'rectificativa', o.number, new Date().toISOString(), -54.45, -9.45, '{}', null, st);
    assert.equal(listStuckClaims(db, seller.id, OPTS).length, 0, 'a claim with a document is never listed as stuck');
    assert.throws(() => releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'u', reason: 'the process crashed before the document', ...OPTS }), /document|upload/i); assert.equal(claimCount(db), 1);
  });
}
test('K5: a claim younger than the quiet period is not listed and cannot be released (an issuance may still own it)', async () => {
  const { db } = await stuck(); db.prepare('UPDATE credit_claims SET claimed_at=? WHERE reversal_key=?').run(new Date().toISOString(), KEY);
  assert.equal(listStuckClaims(db, seller.id).length, 0); assert.throws(() => openStuckClaimReview(db, seller.id, KEY), /too recent|still be in progress|quiet period/i);
});
test('K6: the fingerprint binds the evidence: anything that changes after the review voids the decision', async () => {
  const { db, o } = await stuck(); const f = openStuckClaimReview(db, seller.id, KEY, OPTS);
  db.prepare("INSERT INTO invoices (seller_id,number,shipment_key,kind,rectifies,issued_at,total,vat,json,feed_id,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(seller.id, 'R-2026-000098', 'SHIPMENT:S1001', 'rectificativa', o.number, new Date().toISOString(), -10, -1.7, '{}', null, 'submitted');
  assert.throws(() => releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'u', reason: 'the process crashed before the document', ...OPTS }), /evidence changed|fingerprint/i); assert.equal(claimCount(db), 1);
});
test('K7: a correct release is a documented HUMAN_DECISION with a full history, and the pair needs a NEW approval before anything issues', async () => {
  const { api, db } = await stuck(); const f = openStuckClaimReview(db, seller.id, KEY, OPTS);
  releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'reviewer-1', reason: 'the process crashed before the document existed; nothing was uploaded', ...OPTS });
  assert.equal(claimCount(db), 0);
  const h = db.prepare('SELECT * FROM credit_claim_history WHERE reversal_key=? ORDER BY id').all(KEY); assert.deepEqual(h.map(x => x.event), ['CLAIMED', 'RELEASED']);
  assert.equal(h[1].actor, 'reviewer-1'); assert.match(h[1].reason, /crashed/); assert.ok(h[1].at); assert.equal(h[1].fingerprint, f.fingerprint);
  const d = db.prepare("SELECT * FROM integrity_decisions WHERE code='CLAIM_STUCK_REVIEW'").all(); assert.equal(d.length, 1); assert.equal(d[0].decided_by, 'reviewer-1');
  const n0 = api.calls.length; await processCorrections(db, seller, REPORT, { api, validate: vies });
  assert.equal(api.calls.length - n0, 0, 'the old pair approval does not carry over a released claim'); assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa'").get().c, 0);
  approveAll(db, seller.id); await processCorrections(db, seller, REPORT, { api, validate: vies });
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND total<0").get().c, 1, 'after a new approval exactly one credit note');
});
test('K8 (double-issue proof, order 1): release BEFORE the issuance writes its document -> the issuance refuses, no document, then a fresh approval issues once', async () => {
  const { api, db, o } = await stuck(); const f = openStuckClaimReview(db, seller.id, KEY, OPTS);
  releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'reviewer-1', reason: 'the process crashed before the document existed', ...OPTS });
  const j = JSON.parse(o.json);
  await assert.rejects(() => issueRectificativa(db, seller, o.number, { mode: 'differences', reason: 'x', changes: { lines: j.lines.map(l => ({ ...l, excl: 0, vat: 0 })) }, documentType: 'CreditNote', recordKey: KEY }, { api, validate: vies }), /claim .*released|no longer held|re-review/i);
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa'").get().c, 0);
});
test('K9 (double-issue proof, order 2): the issuance writes its document FIRST -> the release is refused, the claim stays as the document\u2019s claim', async () => {
  const { api, db, o } = await stuck(); const f = openStuckClaimReview(db, seller.id, KEY, OPTS); const j = JSON.parse(o.json);
  await issueRectificativa(db, seller, o.number, { mode: 'differences', reason: 'x', changes: { lines: j.lines.map(l => ({ ...l, excl: 0, vat: 0 })) }, documentType: 'CreditNote', recordKey: KEY }, { api, validate: vies });
  assert.throws(() => releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'u', reason: 'the process crashed before the document', ...OPTS }), /document|upload|evidence changed/i);
  assert.equal(claimCount(db), 1); assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND total<0").get().c, 1);
});
test('K10: claim creation is in the history, and a claim that is not stuck is never in the stuck list', async () => {
  const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: START });
  await processCorrections(db, seller, REPORT, { api, validate: vies }); approveAll(db, seller.id); await processCorrections(db, seller, REPORT, { api, validate: vies });
  const h = db.prepare('SELECT event FROM credit_claim_history WHERE reversal_key=? ORDER BY id').all(KEY).map(x => x.event); assert.ok(h.includes('CLAIMED'), 'creation is recorded: ' + JSON.stringify(h));
  assert.equal(listStuckClaims(db, seller.id, OPTS).length, 0, 'the claim became a document: not stuck');
});

test('K11 (cross-process double-issue proof): release and issuance race in two OS processes on one SQLite file, 12 rounds: never both', { timeout: 100000 }, async () => {
  const N = 12; const dir = mkdtempSync(join(tmpdir(), 'claimrace-')); const file = join(dir, 'db.sqlite'); const api = mkApi(); const db = openDb(file);
  const orig = (r) => { const x = [...base]; x[ix('order-id')] = `405-3318842-77${String(10000 + r).slice(1)}`; x[ix('shipping-id')] = `S9${100 + r}`; x[ix('transaction-id')] = x[ix('shipping-id')]; return x; };
  const rv = (r) => { const x = orig(r); x[ix('transaction-type')] = 'REFUND'; x[ix('transaction-id')] = `CorrectionReversal:R${r}:1`; AMT.forEach(n => { x[ix(n)] = x[ix(n)] ? '-' + x[ix(n)] : ''; }); x[ix('invoice-status')] = 'CreditNotePending'; return x.join('\t'); };
  const rp = (r) => { const x = orig(r); x[ix('transaction-id')] = `Correction::R${r}:2`; x[ix('billing-name')] = 'Name One SL'; return x.join('\t'); };
  await processReport(db, seller, [head, ...Array.from({ length: N }, (_, r) => orig(r).join('\t'))].join('\n'), { api, validate: vies, now: START });
  const full = [head, ...Array.from({ length: N }, (_, r) => [rv(r), rp(r)]).flat()].join('\n'); await processCorrections(db, seller, full, { api, validate: vies }); approveAll(db, seller.id);
  const items = [];
  for (let r = 0; r < N; r++) {
    const report = [head, rv(r), rp(r)].join('\n'); const list = parseVidr(report).filter(s => s.isCorrectionReversal || s.isCorrectedTx); const rr = list.find(s => s.isCorrectionReversal);
    const o = db.prepare('SELECT number, json FROM invoices WHERE shipment_key=? AND kind=\'invoice\'').get(`SHIPMENT:S9${100 + r}`);
    assert.equal(reviewAtomic(db, seller, rr, o, list, true, { vies: [{ vat: list.find(s => s.isCorrectedTx).buyerVat, status: 'valid' }] }), null);
    const key = `REFUND:CorrectionReversal:R${r}:1`; db.prepare('UPDATE credit_claims SET claimed_at=? WHERE reversal_key=?').run('2026-11-20T00:00:00.000Z', key);
    items.push({ report, key, fingerprint: openStuckClaimReview(db, seller.id, key, OPTS).fingerprint });
  }
  const t0 = Date.now() + 1500; const run = (mode) => new Promise(res => { const cfgPath = join(dir, mode + '.json'); writeFileSync(cfgPath, JSON.stringify({ mode, seller, items, t0, stepMs: 700 })); const p = spawn('node', ['--no-warnings', new URL('./helpers/claim-race-worker.mjs', import.meta.url).pathname, file, cfgPath]); let o = '', e = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d); p.on('close', () => res(o.match(/RESULT (.*)/) ? JSON.parse(o.match(/RESULT (.*)/)[1]) : { crashed: e.slice(0, 300) })); });
  const [a, b] = await Promise.all([run('issue'), run('release')]); assert.ok(!a.crashed && !b.crashed, JSON.stringify([a.crashed, b.crashed]));
  const chk = openDb(file); let releasedN = 0, issuedN = 0;
  for (const it of items) {
    const docs = chk.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND shipment_key=? AND total<0").get(it.key).c; const rel = chk.prepare("SELECT count(*) c FROM credit_claim_history WHERE reversal_key=? AND event='RELEASED'").get(it.key).c;
    assert.ok(docs <= 1, 'at most one credit note per event'); assert.ok(!(docs === 1 && rel === 1), `DOUBLE: ${it.key} was released AND issued`); releasedN += rel; issuedN += docs;
  }
  console.log(`CLAIMRACE rounds=${N} released=${releasedN} issued=${issuedN} issueWorker=${JSON.stringify(a)} releaseWorker=${JSON.stringify(b)}`); assert.equal(releasedN + issuedN <= N, true);
  rmSync(dir, { recursive: true, force: true });
});
