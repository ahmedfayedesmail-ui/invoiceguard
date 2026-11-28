import { spawn } from 'node:child_process';
import { client } from './lib.mjs';
import { orderReport, vidrReport } from './gen.mjs';
const PORT = 4399, DB = '/tmp/probe.db';
const call = client(PORT);
for (const s of ['', '-wal', '-shm']) { try { (await import('node:fs')).rmSync(DB + s); } catch {} }
const srv = spawn(process.execPath, ['server.mjs'], { cwd: '/home/sandbox/ig-http-audit', env: { ...process.env, APP_ROOT: '/home/sandbox/invoiceguard', DB_FILE: DB, PORT: String(PORT) }, stdio: ['ignore', 'inherit', 'inherit'] });
for (let i = 0; i < 60; i++) { const r = await call('GET', '/api/me'); if (r.status) break; await new Promise(r2 => setTimeout(r2, 100)); }
const r = await call('POST', '/api/signup', { body: { email: 'p@audit.example', password: 'Audit-Pass-2026!' } });
const cookie = (r.headers['set-cookie'] ?? [''])[0].split(';')[0];
await call('POST', '/api/seller', { cookie, body: { name: 'P S.L.', nif: 'B12345674', address: 'Calle 1', country: 'ES', marketplaces: ['ES'] } });
await call('POST', '/api/amazon/connect', { cookie, body: { manual: true } });
const p = await call('POST', '/api/manual/preview', { cookie, body: { text: vidrReport(200, 0) } });
console.log(JSON.stringify({ willIssue: p.json?.willIssue, heldCount: p.json?.heldCount, held: p.json?.held?.slice(0,2), skippedCount: p.json?.skippedCount, skipped: p.json?.skipped?.slice(0,2), rows: p.json?.rows, ms: Math.round(p.ms) }, null, 1).slice(0, 2500));
const is = await call('POST', '/api/manual/issue', { cookie, body: { text: vidrReport(200, 0, 1), attest: true } });
console.log('ISSUE', is.status, Math.round(is.ms)+'ms', JSON.stringify({ issued: is.json?.issued, heldNow: is.json?.heldNow, errors: is.json?.errors, deferred: is.json?.deferred, repairsProposed: is.json?.repairsProposed }));
srv.kill('SIGTERM');
