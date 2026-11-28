// swarm-quality audit (28 Nov 2026): backward compatibility of the boot migrations.
// A database file written by an EARLIER version of the app must still boot under the
// current code, gain every new table/column/trigger/index, and keep its rows.
// The legacy schema below reproduces a real pre-integrity-engine database (the shape of
// the accidental `--help` dev database committed at 5b2d5e8): no integrity_*, credit_claim*,
// repairs, users/sessions tables; invoices without the modern columns; the narrow round-8
// uniq_rect_per_event predicate ('SHIPMENT:Correction::%'). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, migrateAuth } from '../src/db.js';
import { migrateSecurity, migrateSecLog } from '../src/security.js';
import { ensureRepairTables } from '../src/repair.js';

const LEGACY_SCHEMA = `
CREATE TABLE sellers (id TEXT PRIMARY KEY, name TEXT, nif TEXT, address TEXT, email TEXT, marketplace_ids TEXT, region TEXT DEFAULT 'EU', created_at TEXT);
CREATE TABLE counters (seller_id TEXT, series TEXT, year INTEGER, n INTEGER, PRIMARY KEY (seller_id, series, year));
CREATE TABLE shipments (seller_id TEXT, key TEXT, order_id TEXT, shipping_id TEXT, buyer_vat TEXT, buyer TEXT, country TEXT, total REAL, vat REAL,
  shipment_date TEXT, due_at TEXT, status TEXT, reason TEXT, raw TEXT, updated_at TEXT, PRIMARY KEY (seller_id, key));
CREATE TABLE invoices (seller_id TEXT, number TEXT, shipment_key TEXT, kind TEXT, rectifies TEXT, issued_at TEXT, total REAL, vat REAL, json TEXT,
  feed_id TEXT, upload_status TEXT, uploaded_at TEXT, error TEXT, PRIMARY KEY (seller_id, number));
CREATE TABLE vat_checks (seller_id TEXT, vat TEXT, status TEXT, name TEXT, checked_at TEXT);
CREATE TABLE events (ts TEXT, seller_id TEXT, type TEXT, detail TEXT);
CREATE TABLE site_counters (key TEXT PRIMARY KEY, n INTEGER);
CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, seller_id TEXT, type TEXT, ref TEXT, ts TEXT, doc_hash TEXT, prev_hash TEXT, hash TEXT);
CREATE UNIQUE INDEX uniq_rect_per_event ON invoices (seller_id, shipment_key) WHERE kind='rectificativa' AND (shipment_key NOT LIKE 'SHIPMENT:%' OR shipment_key LIKE 'SHIPMENT:Correction::%');
CREATE UNIQUE INDEX uniq_invoice_per_shipment ON invoices (seller_id, shipment_key) WHERE kind='invoice';`;

function legacyDb(path) {
  const raw = new DatabaseSync(path);
  raw.exec(LEGACY_SCHEMA);
  raw.prepare("INSERT INTO sellers (id, name, nif, created_at) VALUES ('sel1','Tienda Vieja S.L.','B22222222','2026-11-20T10:00:00Z')").run();
  raw.prepare("INSERT INTO shipments (seller_id, key, order_id, status, total, vat) VALUES ('sel1','S1','405-0000001-0000001','pending',121,21)").run();
  raw.prepare("INSERT INTO invoices (seller_id, number, shipment_key, kind, issued_at, total, vat, json) VALUES ('sel1','A-2026-000001','S1','invoice','2026-11-20T10:05:00Z',121,21,'{}')").run();
  raw.prepare("INSERT INTO invoices (seller_id, number, shipment_key, kind, rectifies, issued_at, total, vat, json) VALUES ('sel1','R-2026-000001','SHIPMENT:Correction::S1','rectificativa','A-2026-000001','2026-11-21T09:00:00Z',-21,-3.47,'{}')").run();
  raw.close();
}

test('legacy database: boots under current code, gains new schema objects, keeps every row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-legacy-')), path = join(dir, 'legacy.db');
  try {
    legacyDb(path);
    const db = openDb(path); // must not throw: duplicate-document preflight accepts this clean history
    migrateAuth(db); migrateSecurity(db); migrateSecLog(db); ensureRepairTables(db); // the createApp boot sequence (src/app.js:55)

    // rows survived the migration untouched
    assert.equal(db.prepare('SELECT count(*) c FROM sellers').get().c, 1);
    assert.equal(db.prepare('SELECT count(*) c FROM shipments').get().c, 1);
    assert.equal(db.prepare('SELECT count(*) c FROM invoices').get().c, 2);
    assert.equal(db.prepare("SELECT total FROM invoices WHERE number='R-2026-000001'").get().total, -21);

    // new tables exist now
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    for (const t of ['integrity_findings', 'integrity_history', 'integrity_decisions', 'credit_claims', 'credit_claim_history', 'repairs', 'report_snapshots', 'users', 'sessions', 'seq_counters', 'report_gens'])
      assert.ok(tables.has(t), 'missing after migration: ' + t);

    // new columns exist on old tables
    const invCols = new Set(db.prepare("PRAGMA table_info(invoices)").all().map(c => c.name));
    for (const c of ['tx_id', 'dedupe_key', 'blocked_feed_id', 'sending_at', 'claim_heartbeat', 'claim_token', 'vidr_processing_at', 'attempt_seq'])
      assert.ok(invCols.has(c), 'invoices missing column after migration: ' + c);

    // the round-9 widened dedup index replaced the narrow round-8 one
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uniq_rect_per_event'").get();
    assert.ok(idx.sql.includes("'SHIPMENT:Correction:%'"), 'index predicate widened');
    assert.ok(!idx.sql.includes("'SHIPMENT:Correction::%'"), 'old double-colon predicate gone');

    // append-only triggers are enforced on the migrated database (rows needed: triggers fire per row)
    db.prepare("INSERT INTO credit_claim_history (seller_id, reversal_key, original_number, amount, event, at) VALUES ('sel1','SHIPMENT:Correction::S1','A-2026-000001',21,'TEST','2026-11-21T09:00:00Z')").run();
    db.prepare("INSERT INTO integrity_history (seller_id, shipment_key, code, field, event, fingerprint, at) VALUES ('sel1','S1','TEST','row','TEST','fp','2026-11-21T09:00:00Z')").run();
    assert.throws(() => db.prepare('DELETE FROM credit_claim_history').run(), /append-only/);
    assert.throws(() => db.prepare("UPDATE credit_claim_history SET amount=0").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM integrity_history').run(), /append-only/);
    assert.equal(db.prepare('SELECT count(*) c FROM credit_claim_history').get().c, 1, 'row survived the refused delete');

    // the dedup guarantee protects the legacy rows: a second invoice for shipment S1 is refused
    assert.throws(() => db.prepare("INSERT INTO invoices (seller_id, number, shipment_key, kind) VALUES ('sel1','A-2026-000002','S1','invoice')").run(), /unique/i);

    // reopening the migrated file keeps working and keeps the data
    db.close();
    const again = openDb(path);
    assert.equal(again.prepare('SELECT count(*) c FROM invoices').get().c, 2);
    again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy database: the migration is idempotent (second boot changes nothing and throws nothing)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ig-legacy2-')), path = join(dir, 'legacy.db');
  try {
    legacyDb(path);
    for (let i = 0; i < 2; i++) {
      const db = openDb(path);
      migrateAuth(db); migrateSecurity(db); migrateSecLog(db); ensureRepairTables(db);
      assert.equal(db.prepare('SELECT count(*) c FROM invoices').get().c, 2);
      db.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
