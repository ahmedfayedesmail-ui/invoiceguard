// Restore path for the production database (no shell on the host). Two steps, both safe by construction:
//   1. stageRestore(): an operator uploads a snapshot; it is validated in a scratch file (SQLite integrity, required tables,
//      every seller's audit chain) and only then saved next to the database as <db>.restore-pending. Nothing live changes.
//   2. applyPendingRestore(): at the next boot, BEFORE the database is opened, the pending file is re-validated, the current
//      database is kept as backups/pre-restore-<time>.db, and the snapshot takes its place. Invalid pending files are deleted.
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, verifyAudit } from './db.js';

const REQUIRED = ['sellers', 'shipments', 'invoices', 'events'], OPTIONAL = ['audit', 'users']; // audit/users are created lazily, so a young database may lack them

/** Opens `file` read-only-ish (a scratch copy is expected) and checks it is a sound InvoiceGuard database. */
export function validateSnapshot(file) {
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
    return { ok: true, counts, chains: chains.length };
  } catch (e) { return { ok: false, reason: 'cannot read as a database: ' + String(e.message).slice(0, 120) }; }
  finally { try { db?.close(); } catch { /* closed */ } }
}

export function stageRestore(bytes, dbFile) {
  const scratch = `${dbFile}.restore-scratch`;
  try {
    writeFileSync(scratch, bytes);
    const v = validateSnapshot(scratch);
    if (!v.ok) return v;
    renameSync(scratch, `${dbFile}.restore-pending`);
    return { ...v, staged: true };
  } finally { for (const s of ['', '-wal', '-shm']) rmSync(scratch + s, { force: true }); }
}

export function applyPendingRestore(dbFile, log = console.log) {
  const pending = `${dbFile}.restore-pending`;
  if (!existsSync(pending)) return { applied: false };
  const v = validateSnapshot(pending);
  if (!v.ok) { rmSync(pending, { force: true }); for (const s of ['-wal', '-shm']) rmSync(pending + s, { force: true }); log('restore refused, pending file deleted: ' + v.reason); return { applied: false, reason: v.reason }; }
  let kept = null;
  if (existsSync(dbFile)) {
    const dir = join(dirname(dbFile), 'backups'); mkdirSync(dir, { recursive: true });
    kept = join(dir, `pre-restore-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}.db`);
    try { const d = new DatabaseSync(dbFile); d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); d.close(); } catch { /* copy whatever is there */ }
    copyFileSync(dbFile, kept);
  }
  for (const s of ['-wal', '-shm']) rmSync(dbFile + s, { force: true });
  for (const s of ['-wal', '-shm']) rmSync(pending + s, { force: true });
  renameSync(pending, dbFile);
  log(`restore applied from the staged snapshot (${JSON.stringify(v.counts)}); previous database kept as ${kept}`);
  return { applied: true, kept, counts: v.counts };
}
