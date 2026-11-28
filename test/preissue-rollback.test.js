// Owner ruling (Ahmed, Nov 28 2026, WhatsApp 10:46:35): the ONLY automatic release of a credit claim is the Definite Pre-Issue Failure Rollback: the issuance that created the claim failed before ANY document row existed, so nothing was uploaded and nothing is unsettled. Conditions: never after a document row in any state; unknown outcomes keep the claim; identity-bound release (claim_id): an old attempt can never delete a newer claim; no silent deletion (history: created, aborted, reason, time, event); idempotent retry, at most one active claim per event. Anything abandoned by a crash or not provably pre-document stays human-only. Tests first: audit/phase-b/pre-fix-run-20-preissue-rollback.spec.txt
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
test('P1: failure before the document row: the claim is rolled back, nothing uploaded, and the history says why', async () => {
  const { api, db } = await setup(); await run(db, api, 1); approveAll(db, seller.id); FAIL_BEFORE_DOC(db); await run(db, api, 1);
  assert.equal(api.calls.length, 0, 'no upload'); assert.equal(claims(db).length, 0, 'claim rolled back'); assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa'").get().c, 0);
  const h = hist(db, KEY(1)); assert.deepEqual(h.map(x => x.event), ['CLAIMED', 'ABORTED']); assert.equal(h[1].state ?? h[1].reason?.includes('PRE_ISSUE_FAILURE'), true); assert.ok(h[1].at); assert.equal(h[1].claim_id, h[0].claim_id, 'the abort names the claim it created'); assert.match(h[1].reason, /before any document/i);
});
test('P2: failure AFTER the document row (upload fails): the claim stays', async () => {
  const { api, db } = await setup(); await run(db, api, 1); approveAll(db, seller.id); api.uploadInvoice = async () => { throw new Error('network down'); };
  await run(db, api, 1); assert.ok(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND shipment_key=?").get(KEY(1)).c >= 1, 'a document row exists'); assert.equal(claims(db).length, 1, 'the claim stays with the document');
  assert.ok(!hist(db, KEY(1)).some(x => x.event === 'ABORTED'));
});
test('P3: an unknown upload outcome never releases the claim', async () => {
  const { api, db } = await setup(); await run(db, api, 1); approveAll(db, seller.id); await run(db, api, 1);
  db.prepare("UPDATE invoices SET upload_status='unknown' WHERE shipment_key=?").run(KEY(1));
  const o = db.prepare("SELECT number FROM invoices WHERE shipment_key=?").get(KEY(1)); assert.ok(o);
  assert.equal(rollbackPreIssueClaim(db, seller.id, KEY(1), claims(db)[0].claim_id, 'forced attempt'), false, 'refused: a document row exists'); assert.equal(claims(db).length, 1);
});
test('P4: an old attempt cannot delete a newer attempt\u2019s claim for the same event (identity-bound)', async () => {
  const { api, db } = await setup(); await run(db, api, 1); approveAll(db, seller.id); FAIL_BEFORE_DOC(db); await run(db, api, 1); // attempt A: claim A, rolled back
  db.exec('DROP TRIGGER boom'); const o = db.prepare("SELECT number FROM invoices WHERE kind='invoice' AND shipment_key='SHIPMENT:S1001'").get();
  const idA = hist(db, KEY(1))[0].claim_id; assert.ok(idA);
  db.prepare('INSERT INTO credit_claims (seller_id, original_number, reversal_key, amount, claimed_at, claim_id) VALUES (?,?,?,?,?,?)').run(seller.id, o.number, KEY(1), 54.45, new Date().toISOString(), 'newer-claim-id'); // attempt B owns the claim now
  assert.equal(rollbackPreIssueClaim(db, seller.id, KEY(1), idA, 'stale attempt A fails late'), false); assert.equal(claims(db).length, 1); assert.equal(claims(db)[0].claim_id, 'newer-claim-id');
});
test('P5: after a safe rollback another event can use the balance that became available', async () => {
  const { api, db } = await setup(); await run(db, api, 1); await run(db, api, 2); approveAll(db, seller.id); FAIL_BEFORE_DOC(db); await run(db, api, 1); assert.equal(claims(db).length, 0); db.exec('DROP TRIGGER boom');
  await run(db, api, 2); assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND total<0 AND shipment_key=?").get(KEY(2)).c, 1, 'event 2 issued with the freed balance');
});
test('P6: retrying the same event after a rollback is idempotent: one claim, one credit note, no duplicates', async () => {
  const { api, db } = await setup(); await run(db, api, 1); approveAll(db, seller.id); FAIL_BEFORE_DOC(db); await run(db, api, 1); db.exec('DROP TRIGGER boom');
  await run(db, api, 1); await run(db, api, 1); await run(db, api, 1);
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa' AND total<0 AND shipment_key=?").get(KEY(1)).c, 1); assert.equal(claims(db).length, 1, 'at most one active claim for the event'); assert.equal(api.calls.filter(Boolean).length >= 1, true);
  assert.equal(hist(db, KEY(1)).filter(x => x.event === 'ABORTED').length, 1, 'one abort recorded, none lost, none duplicated');
});
