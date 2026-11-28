// Automatic, restore-tested backups.
// backupNow(): WAL-checkpoint then copy the single database file (crash-consistent snapshot),
// rotate to the newest 14. anchorLog(): append every seller's audit-chain head to an anchors log
// OUTSIDE the database, so a rewritten chain is detectable without trusting the database itself.
// The copies and the log contain personal data: never commit or publish them.
import { mkdirSync, readdirSync, unlinkSync, statSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function backupNow(dbFile = process.env.DB_FILE ?? 'invoiceguard.db', dir = join(dirname(dbFile), 'backups'), { keep = 14 } = {}) {
  mkdirSync(dir, { recursive: true });
  // Flush the WAL into the main file first; under WAL the main file is always crash-consistent,
  // so copying it right after a full checkpoint yields one consistent snapshot file.
  const side = new DatabaseSync(dbFile);
  side.exec('PRAGMA busy_timeout=5000;');
  // wal_checkpoint(TRUNCATE) returns (busy, log, checkpointed). busy=1 means another connection held
  // the WAL, so not every frame reached the main file; copying then would silently snapshot a stale
  // database. Report it honestly and copy nothing.
  const cp = side.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (cp.busy) { side.close(); return { ok: false, reason: 'the database was busy, so the checkpoint did not finish and no snapshot was copied - the previous backup is still the newest good one', checkpoint: cp }; }
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const dest = join(dir, `invoiceguard-${stamp}.db`), tmp = join(dir, `.inprogress-${process.pid}-${Date.now()}`);
  // swarm-backend B1: a plain file copy can tear when a writer's auto-checkpoint rewrites pages of the main file during the copy
  // (reproduced: one of 491 attempts under a synthetic writer failed integrity_check yet was reported ok). VACUUM INTO reads one
  // consistent snapshot; the snapshot is integrity-checked in a temp file and only then renamed into place, so a bad copy is never kept.
  try {
    side.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    side.close();
    const chk = new DatabaseSync(tmp); let ic; try { ic = chk.prepare('PRAGMA integrity_check').get().integrity_check; } finally { chk.close(); }
    if (ic !== 'ok') { rmSync(tmp, { force: true }); return { ok: false, reason: 'the snapshot failed its integrity check and was discarded: ' + String(ic).slice(0, 120) }; }
    renameSync(tmp, dest);
  } catch (e) { try { side.close(); } catch { /* closed */ } rmSync(tmp, { force: true }); return { ok: false, reason: 'the snapshot could not be written: ' + String(e.message).slice(0, 120) }; }
  // swarm-backend B2: rotate ONLY this module's own files; pre-restore-*.db safety copies must not use up (or outlive) the retention slots.
  const files = readdirSync(dir).filter(f => /^invoiceguard-.*\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(join(dir, f));
  return { ok: true, dest, bytes: statSync(dest).size, kept: Math.min(files.length, keep) };
}

export function anchorLog(db, dir = join(dirname(process.env.DB_FILE ?? 'invoiceguard.db'), 'backups')) {
  mkdirSync(dir, { recursive: true });
  db.exec('CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, seller_id TEXT, type TEXT, ref TEXT, ts TEXT, doc_hash TEXT, prev_hash TEXT, hash TEXT)');
  const lines = db.prepare('SELECT DISTINCT seller_id FROM audit').all().map(({ seller_id }) => {
    const h = db.prepare('SELECT seq, hash, ts FROM audit WHERE seller_id=? ORDER BY seq DESC LIMIT 1').get(seller_id);
    return JSON.stringify({ at: new Date().toISOString(), seller: seller_id, entries: h.seq, head: h.hash });
  });
  if (lines.length) appendFileSync(join(dir, 'anchors.log'), lines.join('\n') + '\n');
  return lines.length;
}
