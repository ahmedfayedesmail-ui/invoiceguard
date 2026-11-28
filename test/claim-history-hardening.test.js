// Round 3, decision 3 (owner ruling Nov 28 2026): credit_claim_history is append-only at the SQLite level, a replaced claim gets its own SUPERSEDED event, and every event carries the fingerprint of the approval that created the claim.
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { openDb } from '../src/db.js'; import { processReport, processCorrections, rollbackPreIssueClaim } from '../src/pipeline.js'; import { approveAll } from './correction-helpers.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8'); const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const vies = async (v) => ({ status: 'valid', vat: v }); const mkApi = () => ({ calls: [], uploadInvoice: async function (a) { this.calls.push(a); return 'f' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }) });
const [head, ...body] = text.trim().split('\n'); const cols = head.split('\t'); const ix = n => cols.indexOf(n); const base = body[0].split('\t');
const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const rv = (id) => { const r = [...base]; r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = id; AMT.forEach(n => { r[ix(n)] = r[ix(n)] ? '-' + r[ix(n)] : ''; }); r[ix('invoice-status')] = 'CreditNotePending'; return r.join('\t'); };
const rp = (id) => { const f = [...base]; f[ix('transaction-id')] = id; f[ix('billing-name')] = 'Name One SL'; return f.join('\t'); };
const REPORT = (n) => [head, rv(`CorrectionReversal:X:${n}`), rp(`Correction::X:${n + 100}`)].join('\n'); const KEY = (n) => `REFUND:CorrectionReversal:X:${n}`;
const START = new Date('2026-11-24T12:00:00Z');
const setup = async () => { const api = mkApi(), db = openDb(); await processReport(db, seller, text, { api, validate: vies, now: START }); api.calls.length = 0; return { api, db }; };
const FAIL_BEFORE_DOC = (db) => db.exec("CREATE TRIGGER boom BEFORE INSERT ON invoices WHEN NEW.kind='rectificativa' BEGIN SELECT RAISE(ABORT,'simulated failure before the document row'); END");
const claims = (db) => db.prepare('SELECT * FROM credit_claims').all(); const hist = (db, k) => db.prepare('SELECT * FROM credit_claim_history WHERE reversal_key=? ORDER BY id').all(k);
const run = (db, api, n) => processCorrections(db, seller, REPORT(n), { api, validate: vies });
const approvedFp = (db, n) => db.prepare("SELECT fingerprint FROM integrity_decisions WHERE shipment_key=? AND code='CORRECTION_PAIR_REVIEW'").get('CORRECTION:' + KEY(n))?.fingerprint;
const prime = async (n = 1) => { const { api, db } = await setup(); await run(db, api, n); approveAll(db, seller.id); return { api, db }; };
test('H1: SQLite itself rejects UPDATE of a history row, and the row is unchanged', async () => {
  const { api, db } = await prime(); await run(db, api, 1); const before = JSON.stringify(hist(db, KEY(1))); assert.ok(hist(db, KEY(1)).length >= 1);
  assert.throws(() => db.prepare("UPDATE credit_claim_history SET reason='edited' WHERE reversal_key=?").run(KEY(1)), /append-only/i);
  assert.throws(() => db.prepare("UPDATE credit_claim_history SET event='ABORTED', fingerprint=NULL").run(), /append-only/i); assert.equal(JSON.stringify(hist(db, KEY(1))), before);
});
test('H2: SQLite itself rejects DELETE of a history row (single and bulk), and the rows remain', async () => {
  const { api, db } = await prime(); await run(db, api, 1); const n = db.prepare('SELECT count(*) c FROM credit_claim_history').get().c; assert.ok(n >= 1);
  assert.throws(() => db.prepare('DELETE FROM credit_claim_history WHERE reversal_key=?').run(KEY(1)), /append-only/i); assert.throws(() => db.exec('DELETE FROM credit_claim_history'), /append-only/i);
  assert.equal(db.prepare('SELECT count(*) c FROM credit_claim_history').get().c, n);
});
test('H3: the CLAIMED row carries the fingerprint of the approval that created the claim', async () => {
  const { api, db } = await prime(); await run(db, api, 1); const fp = approvedFp(db, 1); assert.match(fp ?? '', /^[0-9a-f]{64}$/, 'a person approved this fingerprint');
  const c = hist(db, KEY(1)).find(x => x.event === 'CLAIMED'); assert.ok(c, 'CLAIMED recorded'); assert.equal(c.fingerprint, fp);
});
test('H4: replacing a claim writes a SUPERSEDED event for the old claim_id, then a CLAIMED for the new one, each traceable by claim_id', async () => {
  const { api, db } = await prime(); FAIL_BEFORE_DOC(db); const o = db.prepare("SELECT number FROM invoices WHERE kind='invoice' AND shipment_key='SHIPMENT:S1001'").get(); const fp = approvedFp(db, 1);
  // a crash left claim A behind (no document row, no rollback ran): simulate the leftover
  db.prepare('INSERT INTO credit_claims (seller_id, original_number, reversal_key, amount, claimed_at, claim_id) VALUES (?,?,?,?,?,?)').run(seller.id, o.number, KEY(1), 54.45, new Date().toISOString(), 'claim-A');
  db.prepare("INSERT INTO credit_claim_history (seller_id,reversal_key,original_number,amount,event,claim_id,actor,reason,fingerprint,at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(seller.id, KEY(1), o.number, 54.45, 'CLAIMED', 'claim-A', 'system', 'reserved with the approved pair review', fp, new Date().toISOString());
  await run(db, api, 1); // attempt B replaces claim A (then fails before the document row and rolls back its own claim)
  const h = hist(db, KEY(1)); const ev = h.map(x => x.event + ':' + x.claim_id); const idB = h.find(x => x.event === 'CLAIMED' && x.claim_id !== 'claim-A')?.claim_id; assert.ok(idB, 'B recorded');
  assert.ok(ev.indexOf('SUPERSEDED:claim-A') > ev.indexOf('CLAIMED:claim-A') && ev.indexOf('SUPERSEDED:claim-A') < ev.indexOf('CLAIMED:' + idB), 'order CLAIMED A, SUPERSEDED A, CLAIMED B: ' + ev.join(' | '));
  const sup = h.find(x => x.event === 'SUPERSEDED'); assert.match(sup.reason, new RegExp(idB), 'the SUPERSEDED reason names the claim that replaced it'); assert.equal(sup.fingerprint, fp);
  assert.equal(h.filter(x => x.claim_id === 'claim-A').length, 2, 'claim A history is traceable by claim_id: CLAIMED and SUPERSEDED');
});
test('H5: ABORTED carries the fingerprint of its claim, and CLAIMED, ABORTED trace by claim_id', async () => {
  const { api, db } = await prime(); FAIL_BEFORE_DOC(db); await run(db, api, 1); const h = hist(db, KEY(1)); const c = h.find(x => x.event === 'CLAIMED'), a = h.find(x => x.event === 'ABORTED');
  assert.ok(c && a); assert.equal(a.claim_id, c.claim_id); assert.equal(a.fingerprint, c.fingerprint); assert.equal(a.fingerprint, approvedFp(db, 1));
});
test('H6 (guard): a rollback after the claim still records CLAIMED then ABORTED', async () => {
  const { api, db } = await prime(); FAIL_BEFORE_DOC(db); await run(db, api, 1); assert.equal(hist(db, KEY(1)).map(x => x.event).join(), 'CLAIMED,ABORTED');
});
