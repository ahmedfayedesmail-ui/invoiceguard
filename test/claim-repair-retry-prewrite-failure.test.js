// Squad swarm-t9-claims-verify: regression test for the repair.js retryRejectedUpload claim-stuck shape.
// A failure of the local shipment 'sending' write AFTER the committed claim ('rejected'->'sending') must restore 'rejected'
// (nothing was sent), never strand the document in 'sending'.
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js'; import { processReport } from '../src/pipeline.js';
import { listRepairs, approveRepair, recoverUncertainUploads } from '../src/repair.js';
import { proved, seqOpt } from './helpers/prove-verdict.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'selT9', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const vies = async (v) => ({ status: 'valid', vat: v }); const NOW = new Date('2026-11-24T12:00:00Z');
const rejectedReport = () => { const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const r = rows[0].split('\t'); while (r.length < c.length) r.push(''); r[c.indexOf('invoice-status')] = 'InvoiceRejected'; r.push('Internal processing error'); return [head + '\tinvoice-status-description', r.join('\t')].join('\n'); };
const failSending = (db) => db.exec("CREATE TRIGGER sim_busy_upd BEFORE UPDATE ON shipments WHEN NEW.status='sending' BEGIN SELECT RAISE(ABORT,'SQLITE_BUSY simulated'); END;");
const heal = (db) => db.exec('DROP TRIGGER sim_busy_upd;');

async function setup() {
  const db = openDb(); const calls = [];
  const api = { uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) };
  await processReport(db, seller, text, { api, validate: vies, now: NOW });
  const inv = db.prepare("SELECT number, shipment_key FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  await processReport(db, seller, proved(db, seller.id, rejectedReport()), { ...seqOpt(db, seller.id), api, validate: vies });
  const st = () => db.prepare('SELECT upload_status s, claim_token t FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number);
  assert.equal(st().s, 'rejected', 'fixture: document rejected through the real flow');
  const q = listRepairs(db, seller.id); assert.equal(q.length, 1); assert.equal(q[0].suggestion.action, 'retry_upload');
  return { db, api, calls, inv, st, q: q[0] };
}

test('CR2 retry-upload: shipment write failing after the claim restores rejected, sends nothing, repair stays retryable, then retries exactly once', async () => {
  const { db, api, calls, inv, st, q } = await setup();
  const before = calls.length; failSending(db);
  await assert.rejects(() => approveRepair(db, seller, q.event_key, { api, validate: vies }), /SQLITE_BUSY simulated/);
  assert.equal(st().s, 'rejected', 'document restored to rejected, not stuck in sending');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE upload_status='sending'").get().c, 0);
  assert.equal(db.prepare('SELECT status FROM shipments WHERE seller_id=? AND key=?').get(seller.id, inv.shipment_key).status, 'rejected', 'shipment restored too');
  assert.equal(calls.length, before, 'nothing was sent to Amazon');
  assert.equal(db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, q.event_key).state, 'proposed', 'repair returns to its pre-approval state (proposed), not left in issuing');
  assert.equal(recoverUncertainUploads(db, { minAgeMs: 0 }), 0, 'nothing left for the boot sweep');
  heal(db);
  const res = await approveRepair(db, seller, q.event_key, { api, validate: vies });
  assert.equal(res.retried, inv.number); assert.equal(calls.length, before + 1, 'exactly one upload after healing');
  assert.equal(st().s, 'submitted');
});

test('CR2 control: the same retry succeeds without the fault', async () => {
  const { db, api, calls, inv, st, q } = await setup(); const before = calls.length;
  await approveRepair(db, seller, q.event_key, { api, validate: vies });
  assert.equal(calls.length, before + 1); assert.equal(st().s, 'submitted');
});
