import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  // File databases: WAL lets readers and the writer work together, NORMAL sync is crash-safe under WAL, busy_timeout waits instead of failing.
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=OFF;'); if (file !== ':memory:') db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  // Prepared statements are reused: parsing SQL on every request was a measurable cost.
  const rawPrepare = db.prepare.bind(db), stmts = new Map();
  db.prepare = (sql) => { let s = stmts.get(sql); if (!s) { s = rawPrepare(sql); if (stmts.size > 600) stmts.clear(); stmts.set(sql, s); } return s; };
  db.exec(`
  CREATE TABLE IF NOT EXISTS sellers (id TEXT PRIMARY KEY, name TEXT, nif TEXT, address TEXT, email TEXT, marketplace_ids TEXT, region TEXT DEFAULT 'EU', created_at TEXT);
  CREATE TABLE IF NOT EXISTS counters (seller_id TEXT, series TEXT, year INTEGER, n INTEGER, PRIMARY KEY (seller_id, series, year));
  CREATE TABLE IF NOT EXISTS shipments (seller_id TEXT, key TEXT, order_id TEXT, shipping_id TEXT, buyer_vat TEXT, buyer TEXT, country TEXT, total REAL, vat REAL,
    shipment_date TEXT, due_at TEXT, status TEXT, reason TEXT, raw TEXT, updated_at TEXT, PRIMARY KEY (seller_id, key));
  CREATE TABLE IF NOT EXISTS invoices (seller_id TEXT, number TEXT, shipment_key TEXT, kind TEXT, rectifies TEXT, issued_at TEXT, total REAL, vat REAL, json TEXT,
    feed_id TEXT, upload_status TEXT, uploaded_at TEXT, error TEXT, PRIMARY KEY (seller_id, number));
  CREATE TABLE IF NOT EXISTS vat_checks (seller_id TEXT, vat TEXT, status TEXT, name TEXT, checked_at TEXT);
  CREATE TABLE IF NOT EXISTS events (ts TEXT, seller_id TEXT, type TEXT, detail TEXT);
  CREATE TABLE IF NOT EXISTS site_counters (key TEXT PRIMARY KEY, n INTEGER);
  CREATE INDEX IF NOT EXISTS idx_events_seller ON events (seller_id, ts);
  CREATE INDEX IF NOT EXISTS idx_ship_status ON shipments (seller_id, status);
  CREATE INDEX IF NOT EXISTS idx_ship_date ON shipments (seller_id, shipment_date);
  CREATE INDEX IF NOT EXISTS idx_inv_issued ON invoices (seller_id, issued_at);
  CREATE INDEX IF NOT EXISTS idx_vat_checks ON vat_checks (seller_id, checked_at);`);
  // Round-8 dedup invariants, enforced by the database itself so no execution interleaving can
  // create them twice: one invoice per shipment, one correction document per Amazon event
  // (recordKey-less manual corrections keep the original shipment key and stay exempt - several of
  // them per shipment are legitimate). Guarded: a legacy duplicate must never crash boot.
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_per_shipment ON invoices (seller_id, shipment_key) WHERE kind='invoice'`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_rect_per_event ON invoices (seller_id, shipment_key) WHERE kind='rectificativa' AND shipment_key NOT LIKE 'SHIPMENT:%'`);
  } catch (e) { console.error('dedup index migration skipped (legacy duplicate?):', e.message); }
  // One-time repair for the stage-2 limbo defect: corrections approved before the fix sit at
  // 'submitted' with feed_id 'manual' - invisible to the pack and unmarkable. They belong in 'ready'.
  db.exec("UPDATE invoices SET upload_status='ready', feed_id=NULL WHERE upload_status='submitted' AND feed_id='manual'");
  try { db.exec('ALTER TABLE invoices ADD COLUMN tx_id TEXT'); } catch { /* column exists */ }
  // Round-7: the moment an upload attempt STARTED, written before the Amazon call. After a crash of
  // any length this is the anchor for the feed-list settle window - the recovery event's own time is
  // boot time, which can be hours later.
  try { db.exec('ALTER TABLE invoices ADD COLUMN sending_at TEXT'); } catch { /* column exists */ }
  return db;
}

/** Gapless numbering per seller, series and year. Returns e.g. A-2026-000001. */
export function nextNumber(db, sellerId, series, date = new Date()) {
  const year = date.getUTCFullYear();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT n FROM counters WHERE seller_id=? AND series=? AND year=?').get(sellerId, series, year);
    const n = (row?.n ?? 0) + 1;
    db.prepare('INSERT INTO counters (seller_id, series, year, n) VALUES (?,?,?,?) ON CONFLICT(seller_id,series,year) DO UPDATE SET n=excluded.n').run(sellerId, series, year, n);
    db.exec('COMMIT');
    return `${series}-${year}-${String(n).padStart(6, '0')}`;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Run a block of SYNCHRONOUS writes atomically: either every write lands or none does.
 * Closes the crash window between a status write and its Repairs proposal (round-8). Never hold
 * this across an await, and never call nextNumber inside it (it opens its own BEGIN IMMEDIATE). */
export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
}

export const logEvent = (db, sellerId, type, detail) =>
  db.prepare('INSERT INTO events (ts, seller_id, type, detail) VALUES (?,?,?,?)').run(new Date().toISOString(), sellerId, type, JSON.stringify(detail));

export function migrateAuth(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, salt TEXT, hash TEXT, seller_id TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER);
  CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions (expires_at);
  CREATE TABLE IF NOT EXISTS amazon_conn (seller_id TEXT PRIMARY KEY, mode TEXT, secret_enc TEXT, connected_at TEXT, last_sync TEXT, last_sync_result TEXT);`);
  try { db.exec("ALTER TABLE sellers ADD COLUMN country TEXT DEFAULT 'ES'"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE sellers ADD COLUMN profile TEXT"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE sellers ADD COLUMN invoice_lang TEXT DEFAULT 'auto'"); } catch { /* column exists */ }
  try { db.exec('ALTER TABLE users ADD COLUMN ref_code TEXT'); } catch { /* column exists */ }
  try { db.exec('ALTER TABLE users ADD COLUMN referred_by TEXT'); } catch { /* column exists */ }
  for (const r of db.prepare('SELECT id FROM users WHERE ref_code IS NULL').all()) db.prepare('UPDATE users SET ref_code=? WHERE id=?').run(newRefCode(db), r.id);
}

/** Unique short code for a user's personal invite link (?ref=CODE). */
export function newRefCode(db) {
  let c; do { c = randomBytes(5).toString('hex'); } while (db.prepare('SELECT 1 FROM users WHERE ref_code=?').get(c));
  return c;
}

import { createHash } from 'node:crypto';
/** Append-only, hash-chained log of every document issued. Any edit or deletion breaks verifyAudit(). Not a Verifactu record. */
export function appendAudit(db, sellerId, type, ref, doc) {
  db.exec('CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, seller_id TEXT, type TEXT, ref TEXT, ts TEXT, doc_hash TEXT, prev_hash TEXT, hash TEXT)');
  const prev = db.prepare('SELECT hash FROM audit WHERE seller_id=? ORDER BY seq DESC LIMIT 1').get(sellerId)?.hash ?? 'GENESIS';
  const ts = new Date().toISOString(), docHash = createHash('sha256').update(JSON.stringify(doc)).digest('hex');
  const hash = createHash('sha256').update([sellerId, type, ref, ts, docHash, prev].join('|')).digest('hex');
  db.prepare('INSERT INTO audit (seller_id,type,ref,ts,doc_hash,prev_hash,hash) VALUES (?,?,?,?,?,?,?)').run(sellerId, type, ref, ts, docHash, prev, hash);
}
export function verifyAudit(db, sellerId) {
  db.exec('CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, seller_id TEXT, type TEXT, ref TEXT, ts TEXT, doc_hash TEXT, prev_hash TEXT, hash TEXT)');
  let prev = 'GENESIS';
  for (const r of db.prepare('SELECT * FROM audit WHERE seller_id=? ORDER BY seq').all(sellerId)) {
    const h = createHash('sha256').update([sellerId, r.type, r.ref, r.ts, r.doc_hash, prev].join('|')).digest('hex');
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, brokenAt: r.seq };
    const inv = db.prepare('SELECT json FROM invoices WHERE seller_id=? AND number=?').get(sellerId, r.ref);
    if (inv && createHash('sha256').update(JSON.stringify(JSON.parse(inv.json))).digest('hex') !== r.doc_hash) return { ok: false, brokenAt: r.seq, reason: 'document changed after issue' };
    prev = r.hash;
  }
  return { ok: true };
}
