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
  CREATE TABLE IF NOT EXISTS integrity_findings (seller_id TEXT, shipment_key TEXT, code TEXT, field TEXT, severity TEXT, resolution TEXT, status TEXT, fingerprint TEXT, evidence TEXT, explanation TEXT, action TEXT,
    first_seen TEXT, last_seen TEXT, seen_count INTEGER, reopened_count INTEGER, resolved_at TEXT, PRIMARY KEY (seller_id, shipment_key, code, field));
  -- Credit claims on an original invoice (owner review Nov 28): a CorrectionReversal reserves its amount here in the same BEGIN IMMEDIATE transaction that checks the creditable balance, so two events can never both see the same free balance. A claim whose document exists is counted as that document, not twice.
  CREATE TABLE IF NOT EXISTS credit_claims (seller_id TEXT, original_number TEXT, reversal_key TEXT, amount REAL, claimed_at TEXT, claim_id TEXT, PRIMARY KEY (seller_id, reversal_key));
  CREATE TABLE IF NOT EXISTS credit_claim_history (id INTEGER PRIMARY KEY AUTOINCREMENT, seller_id TEXT, reversal_key TEXT, original_number TEXT, amount REAL, event TEXT, claim_id TEXT, actor TEXT, reason TEXT, fingerprint TEXT, at TEXT);
  CREATE TRIGGER IF NOT EXISTS credit_claim_history_no_update BEFORE UPDATE ON credit_claim_history BEGIN SELECT RAISE(ABORT,'credit_claim_history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS credit_claim_history_no_delete BEFORE DELETE ON credit_claim_history BEGIN SELECT RAISE(ABORT,'credit_claim_history is append-only'); END;
  CREATE TABLE IF NOT EXISTS integrity_history (seller_id TEXT, shipment_key TEXT, code TEXT, field TEXT, event TEXT, fingerprint TEXT, at TEXT);
  CREATE TRIGGER IF NOT EXISTS integrity_release_needs_decision_u BEFORE UPDATE OF status ON integrity_findings WHEN NEW.status='RELEASED' AND NOT EXISTS (SELECT 1 FROM integrity_decisions d WHERE d.seller_id=NEW.seller_id AND d.shipment_key=NEW.shipment_key AND d.code=NEW.code AND d.field=NEW.field AND d.fingerprint=NEW.fingerprint)
    BEGIN SELECT RAISE(ABORT,'RELEASED needs a recorded decision'); END;
  CREATE TRIGGER IF NOT EXISTS integrity_release_needs_decision_i BEFORE INSERT ON integrity_findings WHEN NEW.status='RELEASED' AND NOT EXISTS (SELECT 1 FROM integrity_decisions d WHERE d.seller_id=NEW.seller_id AND d.shipment_key=NEW.shipment_key AND d.code=NEW.code AND d.field=NEW.field AND d.fingerprint=NEW.fingerprint)
    BEGIN SELECT RAISE(ABORT,'RELEASED needs a recorded decision'); END;
  CREATE TABLE IF NOT EXISTS integrity_decisions (seller_id TEXT, shipment_key TEXT, code TEXT, field TEXT, fingerprint TEXT, decided_by TEXT, reason TEXT, decided_at TEXT);
  CREATE TRIGGER IF NOT EXISTS integrity_decisions_no_update BEFORE UPDATE ON integrity_decisions BEGIN SELECT RAISE(ABORT,'integrity_decisions is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS integrity_decisions_no_delete BEFORE DELETE ON integrity_decisions BEGIN SELECT RAISE(ABORT,'integrity_decisions is append-only'); END;
  -- Owner ruling Nov 28 2026 (A1): an OPEN credit-note hold on a pair blocks every automatic correction document of that original IN THE DATABASE, so no code path, retry or race can issue or re-upload around it. Checked inside whatever transaction does the write.
  CREATE TRIGGER IF NOT EXISTS cn_hold_blocks_issue BEFORE INSERT ON invoices WHEN NEW.kind='rectificativa' AND EXISTS (SELECT 1 FROM integrity_findings f WHERE f.seller_id=NEW.seller_id AND f.status='OPEN' AND f.code IN ('CREDIT_NOTE_IDENTITY_UNPROVEN','CREDIT_NOTE_ROWS_CONFLICT','CREDIT_NOTE_VERDICT_CONTRADICTION') AND (f.shipment_key=NEW.shipment_key OR f.shipment_key IN (SELECT i.shipment_key FROM invoices i WHERE i.seller_id=NEW.seller_id AND i.kind='rectificativa' AND i.rectifies=NEW.rectifies))) BEGIN SELECT RAISE(ABORT,'credit-note hold: an open credit-note hold needs a person before any correction document is issued or sent'); END;
  CREATE TRIGGER IF NOT EXISTS cn_hold_blocks_send BEFORE UPDATE OF upload_status ON invoices WHEN NEW.kind='rectificativa' AND NEW.upload_status='sending' AND EXISTS (SELECT 1 FROM integrity_findings f WHERE f.seller_id=NEW.seller_id AND f.status='OPEN' AND f.code IN ('CREDIT_NOTE_IDENTITY_UNPROVEN','CREDIT_NOTE_ROWS_CONFLICT','CREDIT_NOTE_VERDICT_CONTRADICTION') AND (f.shipment_key=NEW.shipment_key OR f.shipment_key IN (SELECT i.shipment_key FROM invoices i WHERE i.seller_id=NEW.seller_id AND i.kind='rectificativa' AND i.rectifies=NEW.rectifies))) BEGIN SELECT RAISE(ABORT,'credit-note hold: an open credit-note hold needs a person before any correction document is issued or sent'); END;
  CREATE TRIGGER IF NOT EXISTS integrity_history_no_update BEFORE UPDATE ON integrity_history BEGIN SELECT RAISE(ABORT,'integrity_history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS integrity_history_no_delete BEFORE DELETE ON integrity_history BEGIN SELECT RAISE(ABORT,'integrity_history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS integrity_decision_must_be_valid BEFORE INSERT ON integrity_decisions
    WHEN trim(coalesce(NEW.decided_by,''))='' OR length(trim(coalesce(NEW.reason,'')))<10 OR NOT EXISTS (SELECT 1 FROM integrity_findings f WHERE f.seller_id=NEW.seller_id AND f.shipment_key=NEW.shipment_key AND f.code=NEW.code AND f.field=NEW.field AND f.fingerprint=NEW.fingerprint AND f.status='OPEN' AND f.resolution='HUMAN_DECISION' AND f.severity<>'BLOCK')
    BEGIN SELECT RAISE(ABORT,'not a valid decision: it needs a user, a reason of 10 characters and an open HUMAN_DECISION finding with this fingerprint'); END;
  CREATE INDEX IF NOT EXISTS idx_events_seller ON events (seller_id, ts);
  CREATE INDEX IF NOT EXISTS idx_ship_status ON shipments (seller_id, status);
  CREATE INDEX IF NOT EXISTS idx_ship_date ON shipments (seller_id, shipment_date);
  CREATE INDEX IF NOT EXISTS idx_inv_issued ON invoices (seller_id, issued_at);
  CREATE INDEX IF NOT EXISTS idx_vat_checks ON vat_checks (seller_id, checked_at);`);
  // Round-8 dedup invariants, enforced by the database itself so no execution interleaving can
  // create them twice: one invoice per shipment, one correction document per Amazon event
  // (recordKey-less manual corrections keep the original shipment key and stay exempt - several of
  // them per shipment are legitimate). Guarded: a legacy duplicate must never crash boot.
  // Round-10 (critic round-8): never START without the dedup guarantees the correction paths rely
  // on. Preflight: existing duplicates make a unique index impossible - fail fast and name the
  // offending rows (keep the earliest document of each pair) instead of logging and running
  // unprotected. Post-check: verify both indexes actually exist.
  // Round-11 (critic round-9): name the actual document NUMBERS, not just keys and counts.
  const dupInv = db.prepare("SELECT seller_id, shipment_key, group_concat(number, ', ') numbers, count(*) c FROM invoices WHERE kind='invoice' GROUP BY 1,2 HAVING c>1").all();
  const dupRect = db.prepare("SELECT seller_id, shipment_key, group_concat(number, ', ') numbers, count(*) c FROM invoices WHERE kind='rectificativa' AND (shipment_key NOT LIKE 'SHIPMENT:%' OR shipment_key LIKE 'SHIPMENT:Correction:%') GROUP BY 1,2 HAVING c>1").all();
  if (dupInv.length || dupRect.length) throw new Error(`Refusing to start: duplicate financial documents exist, so the uniqueness migration cannot run safely. Resolve these rows manually first (keep the earliest document of each pair): ${JSON.stringify([...dupInv, ...dupRect]).slice(0, 900)}`);
  // Round-9 (N2): the round-8 predicate exempted every SHIPMENT: key, which silently left Amazon
  // Correction:: events uncovered - their record keys are 'SHIPMENT:Correction::...'. The drop
  // replaces the narrower round-8 index on existing databases; the widened predicate covers
  // Correction:: keys while other SHIPMENT:-keyed corrections (the original shipment key, where
  // several corrections can be legitimate) stay exempt.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_per_shipment ON invoices (seller_id, shipment_key) WHERE kind='invoice'`);
  db.exec(`DROP INDEX IF EXISTS uniq_rect_per_event`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_rect_per_event ON invoices (seller_id, shipment_key) WHERE kind='rectificativa' AND (shipment_key NOT LIKE 'SHIPMENT:%' OR shipment_key LIKE 'SHIPMENT:Correction:%')`);
  for (const idx of ['uniq_invoice_per_shipment', 'uniq_rect_per_event'])
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(idx)) throw new Error(`Refusing to start: required dedup index ${idx} is missing.`);
  // One-time repair for the stage-2 limbo defect: corrections approved before the fix sit at
  // 'submitted' with feed_id 'manual' - invisible to the pack and unmarkable. They belong in 'ready'.
  db.exec("UPDATE invoices SET upload_status='ready', feed_id=NULL WHERE upload_status='submitted' AND feed_id='manual'");
  try { db.exec('ALTER TABLE integrity_history ADD COLUMN evidence TEXT'); } catch { /* column exists */ } // night WP3: the evidence of every OPENED / CHANGED / REOPENED event, so an earlier version is never lost
  try { db.exec('ALTER TABLE credit_claims ADD COLUMN claim_id TEXT'); } catch { /* column exists */ }
  try { db.exec('ALTER TABLE invoices ADD COLUMN tx_id TEXT'); } catch { /* column exists */ }
  // Round-9 (N1): fingerprint of a recordKey-less correction (original + mode + reason + changes),
  // so a double-submitted identical correction is recognized as the same document.
  try { db.exec('ALTER TABLE invoices ADD COLUMN dedupe_key TEXT'); } catch { /* column exists */ }
  // Round-10 (critic round-8): the feed whose outcome was never resolved at document level (FATAL,
  // or aged out of the 90-day feed API). A known feed is invisible to the orphan cross-check, so
  // the settle path checks this column explicitly before any resend.
  try { db.exec('ALTER TABLE invoices ADD COLUMN blocked_feed_id TEXT'); } catch { /* column exists */ }
  // Round-7: the moment an upload attempt STARTED, written before the Amazon call. After a crash of
  // any length this is the anchor for the feed-list settle window - the recovery event's own time is
  // boot time, which can be hours later.
  try { db.exec('ALTER TABLE invoices ADD COLUMN sending_at TEXT'); } catch { /* column exists */ }
  try { db.exec('ALTER TABLE invoices ADD COLUMN vidr_processing_at TEXT'); } catch { /* column exists */ } // round-11: when Amazon's report last stated document-level processing
  // Round-14 (critic round-12): monotonic PER-SELLER upload-attempt sequence. Millisecond clocks
  // cannot order a report request against an attempt claimed in the same ms; a sequence can. Every
  // atomic claim takes the next number; every VIDR report snapshots the current number at request
  // time; a verdict whose snapshot is older than the document's current attempt is stale.
  try { db.exec('ALTER TABLE invoices ADD COLUMN attempt_seq INTEGER'); } catch { /* column exists */ }
  db.exec('CREATE TABLE IF NOT EXISTS seq_counters (seller_id TEXT PRIMARY KEY, n INTEGER)');
  db.exec('CREATE TABLE IF NOT EXISTS report_gens (seller_id TEXT PRIMARY KEY, n INTEGER)'); // round-17: one generation per report, independent of attempts
  // Backfill: attempts that predate this column are all OLDER than any report requested from now
  // on, so they share seq 1 and each affected seller's counter starts at 1 (next claim = 2+). A
  // report requested after this migration can therefore never resurrect a verdict over a claim
  // that happens after it - every new claim takes a fresh, higher number.
  db.prepare('UPDATE invoices SET attempt_seq=1 WHERE attempt_seq IS NULL AND sending_at IS NOT NULL').run();
  db.prepare('INSERT INTO seq_counters (seller_id, n) SELECT seller_id, 1 FROM invoices WHERE attempt_seq IS NOT NULL GROUP BY seller_id ON CONFLICT(seller_id) DO UPDATE SET n=MAX(n, excluded.n)').run();
  return db;
}

/** Gapless numbering per seller, series and year. Returns e.g. A-2026-000001.
 * allocateNumber is the same allocation WITHOUT opening a transaction: call it only inside
 * txImm/tx, so a rolled-back insert never burns a number in a correlative series (round-9). */
export function allocateNumber(db, sellerId, series, date = new Date()) {
  const year = date.getUTCFullYear();
  const row = db.prepare('SELECT n FROM counters WHERE seller_id=? AND series=? AND year=?').get(sellerId, series, year);
  const n = (row?.n ?? 0) + 1;
  db.prepare('INSERT INTO counters (seller_id, series, year, n) VALUES (?,?,?,?) ON CONFLICT(seller_id,series,year) DO UPDATE SET n=excluded.n').run(sellerId, series, year, n);
  return `${series}-${year}-${String(n).padStart(6, '0')}`;
}
export function nextNumber(db, sellerId, series, date = new Date()) {
  db.exec('BEGIN IMMEDIATE');
  try { const n = allocateNumber(db, sellerId, series, date); db.exec('COMMIT'); return n; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Run a block of SYNCHRONOUS writes atomically: either every write lands or none does.
 * Closes the crash window between a status write and its Repairs proposal (round-8). Never hold
 * this across an await, and never call nextNumber inside it (it opens its own BEGIN IMMEDIATE). */
export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
}

/** Same atomic block as tx, but takes the write lock up front (BEGIN IMMEDIATE): for
 * check-then-write sequences (round-9 correction issuance) so a concurrent writer cannot
 * interleave between the check and the insert. Same rules: synchronous writes only,
 * never held across an await. */
export function txImm(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
}

/** Round-14 (critic round-12): the next upload-attempt sequence for a seller. Monotonic per
 * seller, assigned ONLY at the atomic claim, so a VIDR report snapshot orders itself against
 * attempts with zero reliance on the system clock. Two synchronous statements, never awaited
 * between; the claim UPDATE that consumes the number follows synchronously in the same tick. */
export function nextAttemptSeq(db, sellerId) {
  db.prepare('INSERT INTO seq_counters (seller_id, n) VALUES (?,1) ON CONFLICT(seller_id) DO UPDATE SET n=n+1').run(sellerId);
  return db.prepare('SELECT n FROM seq_counters WHERE seller_id=?').get(sellerId).n;
}
/** The current attempt sequence: the snapshot a VIDR report request records (0 = none yet). */
export function currentAttemptSeq(db, sellerId) {
  return db.prepare('SELECT n FROM seq_counters WHERE seller_id=?').get(sellerId)?.n ?? 0;
}

/** Round-17 (critic round-15 P1-A): REPORT GENERATION - a monotonic counter per seller that
 * increments once per report taken in, INDEPENDENT of upload attempts. attempt_seq orders upload
 * attempts (stale-report protection); report_generation orders reports themselves (proposal
 * freshness) - two consecutive reports with no upload between them share an attempt_seq and must
 * still order. */
export function nextReportGen(db, sellerId) {
  db.prepare('INSERT INTO report_gens (seller_id, n) VALUES (?,1) ON CONFLICT(seller_id) DO UPDATE SET n=n+1').run(sellerId);
  return db.prepare('SELECT n FROM report_gens WHERE seller_id=?').get(sellerId).n;
}
export function currentReportGen(db, sellerId) {
  return db.prepare('SELECT n FROM report_gens WHERE seller_id=?').get(sellerId)?.n ?? 0;
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
