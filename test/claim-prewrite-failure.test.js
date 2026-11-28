// Squad swarm-claims-recovery: a failure of the local shipment write BETWEEN the committed claim and the
// guarded upload (e.g. SQLITE_BUSY) must never leave a document stuck in 'sending' inside a live process.
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js'; import { processReport } from '../src/pipeline.js'; import { recoverUncertainUploads } from '../src/repair.js';
const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', country: 'ES', invoice_lang: 'auto' };
const vies = async (v) => ({ status: 'valid', vat: v }); const NOW = new Date('2026-11-24T12:00:00Z');
const okApi = () => ({ calls: [], uploadInvoice: async function (a) { this.calls.push(a); return 'f' + this.calls.length; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] });
const failSending = (db) => db.exec("CREATE TRIGGER sim_busy_ins BEFORE INSERT ON shipments WHEN NEW.status='sending' BEGIN SELECT RAISE(ABORT,'SQLITE_BUSY simulated'); END; CREATE TRIGGER sim_busy_upd BEFORE UPDATE ON shipments WHEN NEW.status='sending' BEGIN SELECT RAISE(ABORT,'SQLITE_BUSY simulated'); END;");
const heal = (db) => db.exec('DROP TRIGGER sim_busy_ins; DROP TRIGGER sim_busy_upd;');
const states = (db) => db.prepare("SELECT upload_status s, count(*) c FROM invoices GROUP BY upload_status").all();

test('CR1 shipment write failing after the claim does not strand the document in sending; the next pass uploads it exactly once', async () => {
  const db = openDb(); const api = okApi(); failSending(db);
  let thrown = null; try { await processReport(db, seller, text, { api, validate: vies, now: NOW }); } catch (e) { thrown = e; }
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE upload_status='sending'").get().c, 0, 'no document may stay in sending after the pass (thrown: ' + (thrown && thrown.message) + ')');
  assert.equal(api.calls.length, 0, 'nothing was sent to Amazon while the write failed');
  heal(db);
  await processReport(db, seller, text, { api, validate: vies, now: NOW });
  assert.ok(api.calls.length >= 1, 'the next pass uploads the document (states: ' + JSON.stringify(states(db)) + ')');
  const per = {}; for (const c of api.calls) per[c.number] = (per[c.number] || 0) + 1; assert.ok(Object.values(per).every(n => n === 1), 'each document uploaded exactly once');
  assert.equal(recoverUncertainUploads(db, { minAgeMs: 0 }), 0, 'nothing left for the sweep');
});
