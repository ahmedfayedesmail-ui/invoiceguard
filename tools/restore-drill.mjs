// Restore DRILL: proves a snapshot can bring the service back, not just that the file looks fine.
// 1. validates the snapshot (integrity, tables, every audit chain)  2. copies it to a fresh location as if it were the live volume
// 3. boots the real app on that copy and checks it answers and refuses a wrong login  4. prints counts. Exit 1 on any failure.
// Usage: node tools/restore-drill.mjs path/to/snapshot.db
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { validateSnapshot } from '../src/restore.js';

const src = process.argv[2]; if (!src) { console.error('usage: node tools/restore-drill.mjs snapshot.db'); process.exit(2); }
const dir = mkdtempSync(join(tmpdir(), 'ig-drill-')), live = join(dir, 'invoiceguard.db');
let ok = false;
try {
  copyFileSync(src, live);
  const v = validateSnapshot(live, { anchorsFile: process.env.ANCHORS_LOG ?? null, allowBehindAnchor: process.env.ALLOW_BEHIND_ANCHOR === '1' }); if (!v.ok) { console.error('DRILL FAILED: ' + v.reason); process.exit(1); }
  const { server, db } = createApp({ db: openDb(live), secret: 'drill' }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const wrong = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.invalid', password: 'x' }) });
  const page = await fetch(base + '/');
  const users = db.prepare('SELECT count(*) c FROM users').get().c;
  server.closeAllConnections(); server.close(); db.close();
  ok = wrong.status === 401 && page.status === 200;
  console.log(JSON.stringify({ drill: ok ? 'PASSED' : 'FAILED', counts: v.counts, auditChainsVerified: v.chains, usersReadableAfterRestore: users, loginRejectsUnknown: wrong.status, landing: page.status }));
} finally { rmSync(dir, { recursive: true, force: true }); }
process.exit(ok ? 0 : 1);
