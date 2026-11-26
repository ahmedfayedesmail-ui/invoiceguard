// Print the audit chain head for every seller: seq, hash, timestamp.
// The audit log lives in the same database it protects, so an attacker with write access could
// rewrite the whole chain. Anchoring the head hash ANYWHERE outside the database (a git note, an
// email to yourself, a dated message) turns a full rewrite into a detectable mismatch: re-run this
// later and compare the head for the same seq.
// Usage: node tools/audit-anchor.mjs [dbFile]
import { openDb, verifyAudit } from '../src/db.js';
import { anchorLog } from '../src/backup.js';

const db = openDb(process.argv[2] ?? process.env.DB_FILE ?? 'invoiceguard.db');
db.exec('CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, seller_id TEXT, type TEXT, ref TEXT, ts TEXT, doc_hash TEXT, prev_hash TEXT, hash TEXT)');
const sellers = db.prepare('SELECT DISTINCT seller_id FROM audit').all();
const out = sellers.map(({ seller_id }) => {
  const head = db.prepare('SELECT seq, hash, ts FROM audit WHERE seller_id=? ORDER BY seq DESC LIMIT 1').get(seller_id);
  return { seller: seller_id, entries: head.seq, head: head.hash, at: head.ts, chain: verifyAudit(db, seller_id).ok ? 'intact' : 'BROKEN' };
});
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), anchors: out }, null, 2));
// The same heads are appended to backups/anchors.log (outside the database) so later runs can be compared without trusting the database.
anchorLog(db);
