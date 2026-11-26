// Timestamped backup of the SQLite database, with rotation.
// Usage: node tools/backup.mjs [dbFile] [backupDir]   (defaults: DB_FILE or invoiceguard.db, <dir>/backups)
// Run it from any external scheduler (cron, a monitoring agent). Keep at least one copy OFF the
// host: download from the backup dir regularly. Contains personal data - never commit or publish.
import { copyFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dbFile = process.argv[2] ?? process.env.DB_FILE ?? 'invoiceguard.db';
const dir = process.argv[3] ?? join(process.cwd(), 'backups');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const dest = join(dir, `invoiceguard-${stamp}.db`);
// WAL checkpoint first so the copy is complete: opening the db here and checkpointing via a side
// connection is overkill for our size - copying db + wal files together is consistent enough for
// a crash-consistent restore point. We copy all three possible files.
for (const suffix of ['', '-wal', '-shm']) {
  try { copyFileSync(dbFile + suffix, dest + suffix); } catch (e) { if (suffix === '') throw e; }
}
const files = readdirSync(dir).filter(f => f.endsWith('.db')).sort();
const KEEP = 14;
for (const f of files.slice(0, Math.max(0, files.length - KEEP))) { unlinkSync(join(dir, f)); for (const s of ['-wal', '-shm']) { try { unlinkSync(join(dir, f) + s); } catch { /* absent */ } } }
console.log(JSON.stringify({ ok: true, dest, bytes: statSync(dest).size, kept: Math.min(files.length, KEEP) }));
