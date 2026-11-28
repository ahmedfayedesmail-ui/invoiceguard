// Restore test: a backup that was never restored is a hope, not a backup.
// Restores the newest snapshot into a scratch file, checks SQLite integrity, table counts and
// every seller's audit chain. Usage: node tools/restore-check.mjs [backupDir] [dbFile]
import { copyFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDb, verifyAudit } from '../src/db.js';

const dbFile = process.argv[3] ?? process.env.DB_FILE ?? 'invoiceguard.db';
const dir = process.argv[2] ?? join(dirname(dbFile), 'backups');
const files = readdirSync(dir).filter(f => /^invoiceguard-.*\.db$/.test(f)).sort();
if (!files.length) { console.error('no backups found in ' + dir); process.exit(1); }
const scratch = join(dir, '.restore-check-scratch.db');
copyFileSync(join(dir, files.at(-1)), scratch);
try {
  const db = openDb(scratch);
  const integrity = db.prepare('PRAGMA integrity_check').get();
  const counts = Object.fromEntries(['sellers', 'shipments', 'invoices', 'events', 'audit'].map(t => [t, db.prepare(`SELECT count(*) c FROM ${t}`).get().c]));
  const chains = db.prepare('SELECT DISTINCT seller_id FROM audit').all().map(({ seller_id }) => ({ seller: seller_id, ...verifyAudit(db, seller_id) }));
  const ok = integrity.integrity_check === 'ok' && chains.every(c => c.ok);
  console.log(JSON.stringify({ restored: files.at(-1), integrity: integrity.integrity_check, counts, chains, ok }, null, 2));
  process.exit(ok ? 0 : 1);
} finally { rmSync(scratch, { force: true }); }
