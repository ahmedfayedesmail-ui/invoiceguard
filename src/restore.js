// Restore path for the production database (no shell on the host). Two steps, both safe by construction:
//   1. stageRestore(): an operator uploads a snapshot; it is validated in a scratch file (SQLite integrity, required tables,
//      every seller's audit chain) and only then saved next to the database as <db>.restore-pending. Nothing live changes.
//   2. applyPendingRestore(): at the next boot, BEFORE the database is opened, the pending file is re-validated, the current
//      database is kept as backups/pre-restore-<time>.db, and the snapshot takes its place. Invalid pending files are deleted.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, verifyAudit } from './db.js';

const REQUIRED = ['sellers', 'shipments', 'invoices', 'events'], OPTIONAL = ['audit', 'users']; // audit/users are created lazily, so a young database may lack them

/** Reads backups/anchors.log (written by backup.js anchorLog). Returns { anchors, bad } - bad counts unparsable or malformed lines. */
export function readAnchors(anchorsFile) {
  if (!anchorsFile || !existsSync(anchorsFile)) return { anchors: [], bad: 0, present: false };
  const anchors = []; let bad = 0;
  for (const line of readFileSync(anchorsFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const a = JSON.parse(line); if (typeof a.seller === 'string' && Number.isInteger(a.entries) && a.entries > 0 && typeof a.head === 'string') anchors.push(a); else bad++; } catch { bad++; }
  }
  return { anchors, bad, present: true };
}

/** Opens `file` read-only-ish (a scratch copy is expected) and checks it is a sound InvoiceGuard database.
 *  opts.anchorsFile: the anchors.log kept OUTSIDE the database. Every anchor must be satisfied: the snapshot's audit chain for that
 *  seller must reach the anchored seq and carry the anchored head hash there. A hash mismatch always fails. A snapshot that merely
 *  ends BEFORE an anchor (older, truncated or wiped) fails unless opts.allowBehindAnchor is set, and is then reported in `behindAnchor`.
 *  Invoices that have no audit rows at all always fail. */
export function validateSnapshot(file, opts = {}) {
  const { anchorsFile = null, allowBehindAnchor = false } = opts;
  let db;
  try {
    db = new DatabaseSync(file);
    const ic = db.prepare('PRAGMA integrity_check').get().integrity_check;
    if (ic !== 'ok') return { ok: false, reason: 'SQLite integrity check failed: ' + ic };
    const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const missing = REQUIRED.filter(t => !have.has(t));
    if (missing.length) return { ok: false, reason: 'not an InvoiceGuard database, missing tables: ' + missing.join(', ') };
    db.close(); db = openDb(file); // runs migrations on the scratch copy so older snapshots can still be verified
    const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const counts = Object.fromEntries([...REQUIRED, ...OPTIONAL].filter(t => present.has(t)).map(t => [t, db.prepare(`SELECT count(*) c FROM ${t}`).get().c]));
    const chains = (present.has('audit') ? db.prepare('SELECT DISTINCT seller_id FROM audit').all() : []).map(({ seller_id }) => ({ seller: seller_id, ...verifyAudit(db, seller_id) }));
    const bad = chains.filter(c => !c.ok);
    if (bad.length) return { ok: false, reason: `${bad.length} audit chain(s) do not verify; the snapshot was altered or damaged`, counts };
    const orphan = present.has('audit') ? db.prepare("SELECT DISTINCT i.seller_id FROM invoices i WHERE NOT EXISTS (SELECT 1 FROM audit a WHERE a.seller_id=i.seller_id)").all() : db.prepare('SELECT DISTINCT seller_id FROM invoices').all(); // audit is created lazily: no table = no rows
    if (orphan.length) return { ok: false, reason: `invoices exist for ${orphan.length} seller(s) with no audit rows at all; the audit trail was wiped or the snapshot is damaged`, counts };
    const { anchors, bad: badLines, present: anchorsPresent } = readAnchors(anchorsFile);
    if (badLines) return { ok: false, reason: `anchors.log has ${badLines} unreadable line(s); cannot trust the anchor check`, counts };
    const behind = [];
    for (const a of anchors) {
      const row = present.has('audit') ? db.prepare('SELECT hash FROM audit WHERE seller_id=? AND seq=?').get(a.seller, a.entries) : undefined;
      if (row) { if (row.hash !== a.head) return { ok: false, reason: `audit chain for seller ${a.seller} does not match the anchor at entry ${a.entries} (anchored ${a.at}); the snapshot's history differs from what was anchored`, counts }; continue; }
      const max = present.has('audit') ? db.prepare('SELECT max(seq) m FROM audit WHERE seller_id=?').get(a.seller).m ?? 0 : 0;
      if (max >= a.entries) return { ok: false, reason: `audit chain for seller ${a.seller} has no entry ${a.entries} although it extends to ${max}; it does not match the anchor`, counts };
      behind.push({ seller: a.seller, anchoredEntries: a.entries, snapshotEntries: max, anchoredAt: a.at });
    }
    if (behind.length && !allowBehindAnchor) return { ok: false, reason: `snapshot is behind the anchor log for ${new Set(behind.map(b => b.seller)).size} seller(s) (audit tail truncated, wiped or snapshot older than the last anchor); pass an explicit operator override to accept an older snapshot`, behindAnchor: behind, counts };
    return { ok: true, counts, chains: chains.length, anchorsChecked: anchors.length, anchorsFilePresent: anchorsPresent, ...(behind.length ? { behindAnchor: behind } : {}) };
  } catch (e) { return { ok: false, reason: 'cannot read as a database: ' + String(e.message).slice(0, 120) }; }
  finally { try { db?.close(); } catch { /* closed */ } }
}

/** Where backup.js writes anchors.log for a given database file. */
export const anchorsPathFor = (dbFile) => join(dirname(dbFile), 'backups', 'anchors.log');

export function stageRestore(bytes, dbFile, opts = {}) {
  const scratch = `${dbFile}.restore-scratch`;
  try {
    writeFileSync(scratch, bytes);
    const v = validateSnapshot(scratch, { anchorsFile: anchorsPathFor(dbFile), ...opts });
    if (!v.ok) return v;
    renameSync(scratch, `${dbFile}.restore-pending`);
    return { ...v, staged: true };
  } finally { for (const s of ['', '-wal', '-shm']) rmSync(scratch + s, { force: true }); }
}

/** opts.allowBehindAnchor: explicit operator override to accept a snapshot older than the anchor log (reported, never silent). */
export function applyPendingRestore(dbFile, log = console.log, opts = {}) {
  const pending = `${dbFile}.restore-pending`;
  if (!existsSync(pending)) return { applied: false };
  const v = validateSnapshot(pending, { anchorsFile: anchorsPathFor(dbFile), ...opts });
  if (!v.ok) { rmSync(pending, { force: true }); for (const s of ['-wal', '-shm']) rmSync(pending + s, { force: true }); log('restore refused, pending file deleted: ' + v.reason); return { applied: false, reason: v.reason }; }
  // Abort = keep the pending file, the live database AND its WAL untouched, so the next boot can retry.
  const abort = (reason) => { log('restore NOT applied, pending file and live database left untouched: ' + reason); return { applied: false, aborted: true, reason }; };
  let kept = null;
  if (existsSync(dbFile)) {
    const dir = join(dirname(dbFile), 'backups'); mkdirSync(dir, { recursive: true });
    kept = join(dir, `pre-restore-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}.db`);
    let d;
    try {
      d = new DatabaseSync(dbFile);
      d.exec('PRAGMA busy_timeout=2000');
      // wal_checkpoint returns (busy, log, checkpointed) and does NOT throw when busy=1: the result must be read.
      const cp = d.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (cp.busy) return abort('another connection holds the database, the WAL checkpoint did not finish (busy=1)');
      d.exec('BEGIN IMMEDIATE'); // no writer may slip in between the checkpoint and the copy
      copyFileSync(dbFile, kept);
      d.exec('ROLLBACK');
    } catch (e) { rmSync(kept, { force: true }); return abort('cannot open and checkpoint the live database exclusively: ' + String(e.message).slice(0, 120)); }
    finally { try { d?.close(); } catch { /* closed */ } }
    const wal = dbFile + '-wal';
    if (existsSync(wal) && statSync(wal).size > 0) { rmSync(kept, { force: true }); return abort('the WAL still holds frames after the checkpoint; deleting it would lose committed rows'); }
    let k;
    try { k = new DatabaseSync(kept); const ic = k.prepare('PRAGMA integrity_check').get().integrity_check; if (ic !== 'ok') throw new Error(ic); }
    catch (e) { rmSync(kept, { force: true }); return abort('the pre-restore copy failed its integrity check: ' + String(e.message).slice(0, 120)); }
    finally { try { k?.close(); } catch { /* closed */ } }
  }
  for (const s of ['-wal', '-shm']) rmSync(dbFile + s, { force: true });
  for (const s of ['-wal', '-shm']) rmSync(pending + s, { force: true });
  renameSync(pending, dbFile);
  log(`restore applied from the staged snapshot (${JSON.stringify(v.counts)}); previous database kept as ${kept}` + (v.behindAnchor ? ' (OVERRIDE: snapshot is BEHIND the anchor log)' : ''));
  return { applied: true, kept, counts: v.counts, ...(v.behindAnchor ? { behindAnchor: v.behindAnchor } : {}) };
}
