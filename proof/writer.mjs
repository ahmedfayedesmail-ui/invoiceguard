// Contention: a second process/connection hammering the same SQLite file with short IMMEDIATE write transactions.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]); db.exec('PRAGMA busy_timeout=5000'); db.exec('CREATE TABLE IF NOT EXISTS proof_side (n INTEGER, ts TEXT)');
let ok = 0, busy = 0, other = 0, maxWait = 0, stop = false; process.on('SIGTERM', () => { stop = true; });
while (!stop) { const t = performance.now(); try { db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO proof_side VALUES (?,?)').run(ok, new Date().toISOString()); await new Promise(r => setTimeout(r, +(process.argv[3] ?? 5))); db.exec('COMMIT'); ok++; } catch (e) { try { db.exec('ROLLBACK'); } catch {} if (/locked|busy/i.test(e.message)) busy++; else other++; }
  maxWait = Math.max(maxWait, performance.now() - t - 20); await new Promise(r => setTimeout(r, +(process.argv[4] ?? 50))); }
console.log(JSON.stringify({ writerCommits: ok, writerBusyErrors: busy, writerOtherErrors: other, writerMaxWaitMs: Math.round(maxWait) })); process.exit(0);
