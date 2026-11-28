// Stuck-claim recovery, failure cases FIRST (Ahmed's six non-negotiables, Nov 28 2026). Written against a stub; see audit/phase-b/pre-fix-run-18-stuck-claims.spec.txt.
// 1 no auto-release ever. 2 time alone never proves abandonment. 3 no release with a document or an unsettled upload. 4 verify nothing active owns the claim. 5 every release is a documented HUMAN_DECISION (user, reason, time, fingerprint). 6 full history of claim creation and release.
import { procStart } from '../src/lease.js';
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
test('K1: time alone never releases: a ten-day-old claim stays after every pass (no auto-release)', async () => {
  const { api, db } = await stuck(); const other = [head, rev('CorrectionReversal:Y:1'), rep('Correction::Y:2')].join('\n');
  for (let i = 0; i < 3; i++) await processCorrections(db, seller, other, { api, validate: vies });
  assert.equal(claimCount(db), 1, 'the claim is still there'); assert.equal(listStuckClaims(db, seller.id).length, 1, 'it is only LISTED as stuck for a person');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa'").get().c, 0);
});
test('K2: release without an open review finding is refused', async () => { const { db } = await stuck(); assert.throws(() => releaseStuckClaim(db, seller.id, KEY, 'x'.repeat(64), { user: 'reviewer-1', reason: 'the process crashed before the document' }), /no open review|no open finding/i); assert.equal(claimCount(db), 1); });
test('K3: release needs user, reason >= 10 characters and the exact fingerprint', async () => {
  const { db } = await stuck(); const f = openStuckClaimReview(db, seller.id, KEY);
  assert.throws(() => releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { reason: 'the process crashed before the document' }), /needs the user/i);
  assert.throws(() => releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'u', reason: 'short' }), /10 characters/i);
  assert.throws(() => releaseStuckClaim(db, seller.id, KEY, 'f'.repeat(64), { user: 'u', reason: 'the process crashed before the document' }), /fingerprint/i);
  assert.equal(claimCount(db), 1);
});
for (const st of ['pending', 'sending', 'unknown', 'submitted', 'ready']) {
  test(`K4 ${st}: a document row for the event (upload ${st}) makes the claim NOT stuck and the release refused`, async () => {
    const { db, o } = await stuck(); const f = openStuckClaimReview(db, seller.id, KEY);
    db.prepare("INSERT INTO invoices (seller_id,number,shipment_key,kind,rectifies,issued_at,total,vat,json,feed_id,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(seller.id, 'R-2026-000099', KEY, 'rectificativa', o.number, new Date().toISOString(), -54.45, -9.45, '{}', null, st);
    assert.equal(listStuckClaims(db, seller.id).length, 0, 'a claim with a document is never listed as stuck');
    assert.throws(() => releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'u', reason: 'the process crashed before the document' }), /document|upload/i); assert.equal(claimCount(db), 1);
  });
}
test('K5: a claim younger than the quiet period is not listed and cannot be released (an issuance may still own it)', async () => {
  const { db } = await stuck(); db.prepare('UPDATE credit_claims SET claimed_at=? WHERE reversal_key=?').run(new Date().toISOString(), KEY);
  assert.equal(listStuckClaims(db, seller.id).length, 0); assert.throws(() => openStuckClaimReview(db, seller.id, KEY), /too recent|still be in progress|quiet period/i);
});
test('K6: the fingerprint binds the evidence: anything that changes after the review voids the decision', async () => {
  const { db, o } = await stuck(); const f = openStuckClaimReview(db, seller.id, KEY);
  db.prepare("INSERT INTO invoices (seller_id,number,shipment_key,kind,rectifies,issued_at,total,vat,json,feed_id,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(seller.id, 'R-2026-000098', 'SHIPMENT:S1001', 'rectificativa', o.number, new Date().toISOString(), -10, -1.7, '{}', null, 'submitted');
  assert.throws(() => releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'u', reason: 'the process crashed before the document' }), /evidence changed|fingerprint/i); assert.equal(claimCount(db), 1);
});
test('K7: a correct release is a documented HUMAN_DECISION with a full history, and the pair needs a NEW approval before anything issues', async () => {
  const { api, db } = await stuck(); const f = openStuckClaimReview(db, seller.id, KEY);
  releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'reviewer-1', reason: 'the process crashed before the document existed; nothing was uploaded' });
  assert.equal(claimCount(db), 0);
  const h = db.prepare('SELECT * FROM credit_claim_history WHERE reversal_key=? ORDER BY id').all(KEY); assert.deepEqual(h.map(x => x.event), ["CLAIMED", "RELEASED"]);
  assert.equal(h[1].actor, 'reviewer-1'); assert.match(h[1].reason, /crashed/); assert.ok(h[1].at); assert.equal(h[1].fingerprint, f.fingerprint);
  const d = db.prepare("SELECT * FROM integrity_decisions WHERE code='CLAIM_STUCK_REVIEW'").all(); assert.equal(d.length, 1); assert.equal(d[0].decided_by, 'reviewer-1');
  const n0 = api.calls.length; await processCorrections(db, seller, REPORT, { api, validate: vies });
  assert.equal(api.calls.length - n0, 0, 'the old pair approval does not carry over a released claim'); assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa'").get().c, 0);
  approveAll(db, seller.id); await processCorrections(db, seller, REPORT, { api, validate: vies });
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND total<0").get().c, 1, 'after a new approval exactly one credit note');
});
test('K8 (double-issue proof, order 1): release BEFORE the issuance writes its document -> the issuance refuses, no document, then a fresh approval issues once', async () => {
  const { api, db, o } = await stuck(); const f = openStuckClaimReview(db, seller.id, KEY);
  releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'reviewer-1', reason: 'the process crashed before the document existed' });
  const j = JSON.parse(o.json);
  await assert.rejects(() => issueRectificativa(db, seller, o.number, { mode: 'differences', reason: 'x', changes: { lines: j.lines.map(l => ({ ...l, excl: 0, vat: 0 })) }, documentType: 'CreditNote', recordKey: KEY }, { api, validate: vies }), /claim .*released|no longer held|re-review/i);
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa'").get().c, 0);
});
test('K9 (double-issue proof, order 2): the issuance writes its document FIRST -> the release is refused, the claim stays as the document\u2019s claim', async () => {
  const { api, db, o } = await stuck(); const f = openStuckClaimReview(db, seller.id, KEY); const j = JSON.parse(o.json);
  await issueRectificativa(db, seller, o.number, { mode: 'differences', reason: 'x', changes: { lines: j.lines.map(l => ({ ...l, excl: 0, vat: 0 })) }, documentType: 'CreditNote', recordKey: KEY }, { api, validate: vies });
  assert.throws(() => releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'u', reason: 'the process crashed before the document' }), /document|upload|evidence changed/i);
  assert.equal(claimCount(db), 1); assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND total<0").get().c, 1);
});
test('K10: claim creation is in the history, and a claim that is not stuck is never in the stuck list', async () => {
  const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: START });
  await processCorrections(db, seller, REPORT, { api, validate: vies }); approveAll(db, seller.id); await processCorrections(db, seller, REPORT, { api, validate: vies });
  const h = db.prepare('SELECT event FROM credit_claim_history WHERE reversal_key=? ORDER BY id').all(KEY).map(x => x.event); assert.ok(h.includes('CLAIMED'), 'creation is recorded: ' + JSON.stringify(h));
  assert.equal(listStuckClaims(db, seller.id).length, 0, 'the claim became a document: not stuck');
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
    const key = `REFUND:CorrectionReversal:R${r}:1`; db.prepare('UPDATE credit_claims SET claimed_at=? WHERE reversal_key=?').run('2026-11-20T00:00:00.000Z', key); await crashed(db);
    items.push({ report, key, fingerprint: openStuckClaimReview(db, seller.id, key).fingerprint });
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

// ---- Round 4 (Ahmed's review of the stuck-claim proposal, Nov 28 2026): three findings, tests first ----
test('K12: the quiet period is a constant of the production path: no caller can shorten it (minAgeMs is ignored)', async () => {
  const { db } = await stuck(); db.prepare('UPDATE credit_claims SET claimed_at=? WHERE reversal_key=?').run(new Date().toISOString(), KEY);
  assert.equal(listStuckClaims(db, seller.id, { minAgeMs: 0 }).length, 0, 'minAgeMs: 0 does not list a fresh claim');
  assert.throws(() => openStuckClaimReview(db, seller.id, KEY, { minAgeMs: 0 }), /quiet period|still be in progress/i);
  db.prepare('UPDATE credit_claims SET claimed_at=? WHERE reversal_key=?').run('2026-11-20T00:00:00.000Z', KEY); const f = openStuckClaimReview(db, seller.id, KEY);
  db.prepare('UPDATE credit_claims SET claimed_at=? WHERE reversal_key=?').run(new Date().toISOString(), KEY); // the claim became fresh again (new attempt): evidence changes AND the period applies
  assert.throws(() => releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'u', reason: 'the process crashed before the document', minAgeMs: 0 }), /quiet period|still be in progress|evidence changed|fingerprint/i); assert.equal(claimCount(db), 1);
});
test('K13: a missing original invoice blocks the review and the release entirely (no null original hash ever reaches a decision)', async () => {
  const { db, o } = await stuck(); const f = openStuckClaimReview(db, seller.id, KEY); // a review opened while the original existed
  db.prepare('DELETE FROM invoices WHERE number=?').run(o.number);
  assert.throws(() => openStuckClaimReview(db, seller.id, KEY), /original invoice/i);
  assert.throws(() => releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'reviewer-1', reason: 'the process crashed before the document existed' }), /original invoice/i);
  assert.equal(claimCount(db), 1, 'the claim stays'); assert.equal(db.prepare("SELECT count(*) c FROM integrity_decisions WHERE code='CLAIM_STUCK_REVIEW'").get().c, 0, 'no decision recorded');
  assert.ok(!db.prepare("SELECT evidence FROM integrity_findings WHERE code='CLAIM_STUCK_REVIEW'").all().some(r => /"sha256":null/.test(r.evidence) && false), 'sanity');
});
test('K13b: with the original missing from the start, no finding with a null original hash is ever created', async () => {
  const { db, o } = await stuck(); db.prepare('DELETE FROM invoices WHERE number=?').run(o.number); db.prepare("DELETE FROM integrity_findings WHERE code='CLAIM_STUCK_REVIEW'").run();
  assert.throws(() => openStuckClaimReview(db, seller.id, KEY), /original invoice/i); assert.equal(db.prepare("SELECT count(*) c FROM integrity_findings WHERE code='CLAIM_STUCK_REVIEW'").get().c, 0);
  const row = listStuckClaims(db, seller.id).find(c => c.reversalKey === KEY); assert.ok(row, 'still listed so a person sees it'); assert.equal(row.reviewable, false); assert.match(row.blockedReason, /original invoice/i);
});
test('K16: a claim with no recorded owner cannot be proven abandoned: review and release refused, and the list says it cannot prove it', async () => {
  const { db } = await stuck(); db.prepare('DELETE FROM claim_leases').run();
  const row = listStuckClaims(db, seller.id)[0]; assert.equal(row.activeIssuance.state, 'unproven'); assert.equal(row.activeIssuance.proven, false); assert.equal(row.reviewable, false);
  assert.throws(() => openStuckClaimReview(db, seller.id, KEY), /cannot prove|not proven|owner/i); assert.equal(claimCount(db), 1);
});
test('K17: an owner recorded on another machine cannot be checked: unproven, refused', async () => {
  const { db } = await stuck(); db.prepare("UPDATE claim_leases SET host='some-other-machine'").run();
  assert.equal(listStuckClaims(db, seller.id)[0].activeIssuance.state, 'unproven'); assert.throws(() => openStuckClaimReview(db, seller.id, KEY), /cannot prove|not proven|owner/i);
});
test('K18: while the process that reserved the claim is alive, the claim is not abandoned: the list says alive, review and release refused (also with a finding opened earlier)', async () => {
  const { db } = await stuck(); const f = openStuckClaimReview(db, seller.id, KEY); // dead owner at this moment
  db.prepare('UPDATE claim_leases SET pid=?, proc_start=?').run(process.pid, procStart(process.pid)); // an owner that is running (this process, same start time)
  const row = listStuckClaims(db, seller.id)[0]; assert.equal(row.activeIssuance.state, 'alive'); assert.equal(row.activeIssuance.proven, false);
  assert.throws(() => openStuckClaimReview(db, seller.id, KEY), /running|active|alive/i);
  assert.throws(() => releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'reviewer-1', reason: 'the process crashed before the document existed' }), /running|active|alive|evidence changed/i); assert.equal(claimCount(db), 1);
});
const sleepUntil = (cond, ms = 8000) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { if (cond()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')); } }, 25); });
async function pendingIssuance(mode) {
  // a REAL second process: it reserves the claim (approved pair) and then freezes before it writes the document, exactly the window of a pending issuance
  const dir = mkdtempSync(join(tmpdir(), 'lease-')); const file = join(dir, 'db.sqlite'); const api = mkApi(), db = openDb(file);
  await processReport(db, seller, text, { api, validate: vies, now: START }); await processCorrections(db, seller, REPORT, { api, validate: vies }); approveAll(db, seller.id);
  const cfg = join(dir, 'cfg.json'); writeFileSync(cfg, JSON.stringify({ seller, report: REPORT, mode, freezeMs: mode === 'resume' ? 2500 : 600000 }));
  const p = spawn('node', ['--no-warnings', new URL('./helpers/lease-worker.mjs', import.meta.url).pathname, file, cfg]); let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d); const closed = new Promise(res => p.on('close', (code, sig) => res({ code, sig })));
  await sleepUntil(() => /FROZEN/.test(out) || /CRASH/.test(out)); assert.ok(/FROZEN/.test(out), 'worker froze after reserving: ' + out + err);
  db.prepare('UPDATE credit_claims SET claimed_at=? WHERE reversal_key=?').run('2026-11-20T00:00:00.000Z', KEY); // old enough: only the active owner stands in the way
  return { db, p, closed, dir, file, out: () => out };
}
test('K14 (pending issuance before the document row): a release attempted while the issuing process is frozen is refused; when it resumes exactly one credit note is written, no double-issue, nothing unsettled', { timeout: 60000 }, async () => {
  const { db, closed, dir } = await pendingIssuance('resume');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa'").get().c, 0, 'pre-document window'); assert.equal(claimCount(db), 1);
  const row = listStuckClaims(db, seller.id)[0]; assert.equal(row.activeIssuance.state, 'alive', 'the system sees the active owner'); assert.equal(row.activeIssuance.proven, false);
  assert.throws(() => openStuckClaimReview(db, seller.id, KEY), /running|active|alive/i);
  await closed; // the issuance resumes and finishes
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND total<0 AND shipment_key=?").get(KEY).c, 1, 'exactly one credit note'); assert.equal(claimCount(db), 1, 'the claim belongs to that document');
  assert.equal(db.prepare("SELECT count(*) c FROM credit_claim_history WHERE reversal_key=? AND event='RELEASED'").get(KEY).c, 0, 'never released'); assert.equal(listStuckClaims(db, seller.id).length, 0, 'not stuck: it has a document');
  assert.equal(db.prepare("SELECT count(*) c FROM claim_leases").get().c, 0, 'the lease ended with the document'); rmSync(dir, { recursive: true, force: true });
});
test('K15 (proof of death): the frozen issuing process is killed; only then is its absence proven and a documented release possible; nothing was written', { timeout: 60000 }, async () => {
  const { db, p, closed, dir } = await pendingIssuance('hang');
  assert.throws(() => openStuckClaimReview(db, seller.id, KEY), /running|active|alive/i, 'refused while it is alive');
  p.kill('SIGKILL'); await closed;
  const row = listStuckClaims(db, seller.id)[0]; assert.equal(row.activeIssuance.state, 'gone'); assert.equal(row.activeIssuance.proven, true); assert.equal(row.reviewable, true);
  const f = openStuckClaimReview(db, seller.id, KEY); releaseStuckClaim(db, seller.id, KEY, f.fingerprint, { user: 'reviewer-1', reason: 'the issuing process was killed before it wrote the document' });
  assert.equal(claimCount(db), 0); assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa'").get().c, 0); assert.equal(db.prepare("SELECT count(*) c FROM claim_leases").get().c, 0); rmSync(dir, { recursive: true, force: true });
});
