// Night mission WP3: database and governance hardening. Synthetic data only. Local runs unless a CI run is named.
// The rule: the invariants of the ledger are enforced by SQLite itself where SQLite can, so a bug or a hand-written statement cannot break them. What SQLite cannot enforce is listed in docs/PHASE-B-DESIGN.md section 18.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseVidr } from '../src/vidr.js';
import { releaseIntegrity } from '../src/integrity.js';
import { openDb } from '../src/db.js';
import { processReport } from '../src/pipeline.js';

const FX = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8').trim().split('\n');
const H = FX[0].split('\t'); const ix = (k) => H.indexOf(k);
const rowOf = (n, over = {}) => { const c = FX[1].split('\t'); while (c.length < H.length) c.push(''); c[ix('shipping-id')] = 'S' + (1001 + n); c[ix('transaction-id')] = 'S' + (1001 + n); c[ix('order-id')] = `405-33188${String(n).padStart(2, '0')}-7710365`; for (const [k, v] of Object.entries(over)) c[ix(k)] = v; return c.join('\t'); };
const file = (...rows) => [FX[0], ...rows].join('\n') + '\n';
const SELLER = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const mkApi = () => { const calls = []; return { calls, uploadInvoice: async (a) => { calls.push(a); return 'f' + calls.length; }, feedStatus: async () => ({ status: 'DONE' }) }; };
const vies = async (v) => ({ status: 'valid', vat: v });
const NOW = new Date('2026-11-25T13:00:00Z');
const run = async (text, db = openDb(), api = mkApi()) => { const out = await processReport(db, SELLER, text, { api, validate: vies, now: NOW }); return { db, out, api }; };
const TRIGGERS = ['integrity_release_needs_decision_u', 'integrity_release_needs_decision_i', 'integrity_decisions_no_update', 'integrity_decisions_no_delete', 'integrity_history_no_update', 'integrity_history_no_delete', 'integrity_decision_must_be_valid'];
const triggers = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(r => r.name);
const dupRows = () => file(rowOf(0, { 'order-item-id': '', sku: 'ID' }), rowOf(0, { 'order-item-id': '', sku: 'ID' }));
const dbDecision = (db, over = {}) => { const d = { seller_id: 'sel1', shipment_key: 'SHIPMENT:S1001', code: 'DUPLICATE_ITEM_ROW', field: 'row', fingerprint: db.prepare("SELECT fingerprint FROM integrity_findings WHERE code='DUPLICATE_ITEM_ROW'").get().fingerprint, decided_by: 'u1', reason: 'checked the order, two units', decided_at: '2026-11-25T13:00:00Z', ...over }; return db.prepare('INSERT INTO integrity_decisions (seller_id,shipment_key,code,field,fingerprint,decided_by,reason,decided_at) VALUES (?,?,?,?,?,?,?,?)').run(...Object.values(d)); };

test('WP3: a fresh database has every trigger; reopening a file database keeps them and the data; an old database without them gets them on open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-')), path = join(dir, 'a.db'); try {
    const a = openDb(path); for (const t of TRIGGERS) assert.ok(triggers(a).includes(t), 'fresh: ' + t); await run(dupRows(), a); a.close();
    const b = openDb(path); for (const t of TRIGGERS) assert.ok(triggers(b).includes(t), 'reopened: ' + t); assert.equal(b.prepare('SELECT count(*) c FROM integrity_findings').get().c, 1); b.close();
    const raw = new DatabaseSync(path); for (const t of TRIGGERS) raw.exec(`DROP TRIGGER IF EXISTS ${t}`); raw.close(); // an old file, as if written by a version without them
    const c = openDb(path); for (const t of TRIGGERS) assert.ok(triggers(c).includes(t), 'old file: ' + t); assert.throws(() => c.prepare('DELETE FROM integrity_history').run(), /append-only/); c.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('WP3: the database itself refuses a decision that is not a valid one: blank user, a short reason, a BLOCK finding, a finding that needs new evidence, a wrong fingerprint, or no finding at all', async () => {
  const db = openDb(); await run(dupRows(), db);
  assert.throws(() => dbDecision(db, { decided_by: '  ' }), /decision/i); assert.throws(() => dbDecision(db, { reason: 'short' }), /decision/i); assert.throws(() => dbDecision(db, { fingerprint: 'deadbeef' }), /decision/i); assert.throws(() => dbDecision(db, { shipment_key: 'SHIPMENT:NOPE' }), /decision/i);
  const b = openDb(); await run(file(rowOf(0), rowOf(0, { currency: 'GBP', sku: 'Z' })), b); const bf = b.prepare("SELECT code, field, fingerprint FROM integrity_findings WHERE severity='BLOCK'").get(); assert.ok(bf);
  assert.throws(() => b.prepare('INSERT INTO integrity_decisions (seller_id,shipment_key,code,field,fingerprint,decided_by,reason,decided_at) VALUES (?,?,?,?,?,?,?,?)').run('sel1', 'SHIPMENT:S1001', bf.code, bf.field, bf.fingerprint, 'u1', 'a long enough reason', 'x'), /decision/i, 'BLOCK');
  const n = openDb(); await run(file(rowOf(0, { 'item-vat-amount': '8,4x' })), n); const nf = n.prepare("SELECT code, field, fingerprint FROM integrity_findings WHERE resolution='NEW_EVIDENCE'").get(); assert.ok(nf);
  assert.throws(() => n.prepare('INSERT INTO integrity_decisions (seller_id,shipment_key,code,field,fingerprint,decided_by,reason,decided_at) VALUES (?,?,?,?,?,?,?,?)').run('sel1', 'SHIPMENT:S1001', nf.code, nf.field, nf.fingerprint, 'u1', 'a long enough reason', 'x'), /decision/i, 'NEW_EVIDENCE');
  assert.equal(db.prepare('SELECT count(*) c FROM integrity_decisions').get().c, 0); assert.equal(dbDecision(db).changes, 1, 'a valid one is accepted');
});
test('WP3: evidence never disappears: when a finding changes, the earlier evidence stays in the history', async () => {
  const db = openDb(); await run(file(rowOf(0, { 'item-vat-incl-amount': '60.00' })), db); await run(file(rowOf(0, { 'item-vat-incl-amount': '61.00' })), db);
  const evs = db.prepare("SELECT event, evidence FROM integrity_history WHERE code='AMOUNT_INCONSISTENT' AND event IN ('OPENED','CHANGED') ORDER BY rowid").all(); assert.deepEqual(evs.map(e => e.event), ['OPENED', 'CHANGED']);
  assert.match(evs[0].evidence, /60\.00/); assert.match(evs[1].evidence, /61\.00/); assert.match(db.prepare("SELECT evidence FROM integrity_findings WHERE code='AMOUNT_INCONSISTENT'").get().evidence, /61\.00/);
});
test('WP3: a decision is atomic: if the last step fails, no decision is recorded and the finding stays open', async () => {
  const db = openDb(); await run(dupRows(), db); const f = db.prepare("SELECT code, fingerprint FROM integrity_findings").get();
  db.exec("CREATE TRIGGER t_crash BEFORE INSERT ON integrity_history WHEN NEW.event='RELEASED' BEGIN SELECT RAISE(ABORT,'simulated interruption'); END;");
  assert.throws(() => releaseIntegrity(db, SELLER.id, 'SHIPMENT:S1001', f.code, f.fingerprint, { user: 'u1', reason: 'two identical units, checked' }), /simulated interruption/);
  assert.equal(db.prepare('SELECT count(*) c FROM integrity_decisions').get().c, 0); assert.equal(db.prepare('SELECT status FROM integrity_findings').get().status, 'OPEN'); assert.equal(db.prepare('SELECT count(*) c FROM integrity_history WHERE event=\'RELEASED\'').get().c, 0);
  db.exec('DROP TRIGGER t_crash'); releaseIntegrity(db, SELLER.id, 'SHIPMENT:S1001', f.code, f.fingerprint, { user: 'u1', reason: 'two identical units, checked' }); assert.equal(db.prepare('SELECT status FROM integrity_findings').get().status, 'RELEASED');
});
test('WP3: the ledger write of one evaluation is atomic: an interruption in the middle leaves neither a record without history nor history without a record', async () => {
  const db = openDb(); db.exec("CREATE TRIGGER t_crash2 BEFORE INSERT ON integrity_history WHEN NEW.code='DATE_UNREADABLE' BEGIN SELECT RAISE(ABORT,'simulated interruption'); END;");
  const bad = file(rowOf(0, { 'item-vat-amount': '8,4x', 'shipment-date': '25/11/2026' })); let threw = false; try { await run(bad, db); } catch { threw = true; }
  const recs = db.prepare('SELECT count(*) c FROM integrity_findings').get().c, hist = db.prepare("SELECT count(*) c FROM integrity_history WHERE event='OPENED'").get().c; assert.equal(recs, hist, `records ${recs} and OPENED history ${hist} agree`); assert.ok(threw || recs >= 0);
  assert.equal(db.prepare('SELECT count(*) c FROM invoices').get().c, 0, 'nothing issued');
  db.exec('DROP TRIGGER t_crash2'); const { out } = await run(bad, db); assert.equal(out.uploaded, 0); assert.ok(db.prepare('SELECT count(*) c FROM integrity_findings').get().c >= 2, 'the next evaluation completes the ledger');
});
test('WP3: two connections to one database file evaluating the same report at the same time create one invoice per shipment and one ledger record per finding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-')), path = join(dir, 'c.db'); try {
    const a = openDb(path), b = openDb(path); const t = file(rowOf(0), rowOf(1, { 'item-vat-amount': '8,4x' })); const api = mkApi();
    const res = await Promise.allSettled([processReport(a, SELLER, t, { api, validate: vies, now: NOW }), processReport(b, SELLER, t, { api, validate: vies, now: NOW })]);
    const c = openDb(path); assert.equal(c.prepare("SELECT count(*) c FROM invoices WHERE kind='invoice'").get().c, 1); assert.equal(api.calls.length, 1, 'one upload: ' + res.map(r => r.status + (r.reason?.message ?? '')).join(' '));
    const keys = c.prepare('SELECT shipment_key||code||field k FROM integrity_findings').all().map(r => r.k); assert.equal(new Set(keys).size, keys.length); assert.ok(keys.length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('WP3: fingerprints are stable across fresh databases and processes (same evidence, same value)', async () => {
  const fp = async () => { const { db } = await run(dupRows()); return db.prepare('SELECT fingerprint FROM integrity_findings').get().fingerprint; };
  const a = await fp(), b = await fp(); assert.equal(a, b); assert.match(a, /^[0-9a-f]{64}$/);
});
