// Automatic, restore-tested backups.
// backupNow(): WAL-checkpoint then copy the single database file (crash-consistent snapshot),
// rotate to the newest 14. anchorLog(): append every seller's audit-chain head to an anchors log
// OUTSIDE the database, so a rewritten chain is detectable without trusting the database itself.
// The copies and the log contain personal data: never commit or publish them.
import { copyFileSync, mkdirSync, readdirSync, unlinkSync, statSync, appendFileSync } from 'node:fs';
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
  side.close();
  if (cp.busy) return { ok: false, reason: 'the database was busy, so the checkpoint did not finish and no snapshot was copied - the previous backup is still the newest good one', checkpoint: cp };
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const dest = join(dir, `invoiceguard-${stamp}.db`);
  copyFileSync(dbFile, dest);
  const files = readdirSync(dir).filter(f => f.endsWith('.db')).sort();
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
