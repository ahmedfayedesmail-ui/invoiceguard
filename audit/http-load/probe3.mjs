import { spawn } from 'node:child_process';
import net from 'node:net';
import { client } from './lib.mjs';
import { vidrReport } from './gen.mjs';
const PORT = 4396, DB = '/tmp/probe3.db';
const call = client(PORT);
for (const s of ['', '-wal', '-shm']) { try { (await import('node:fs')).rmSync(DB + s); } catch {} }
const srv = spawn(process.execPath, ['server.mjs'], { cwd: '/home/sandbox/ig-http-audit', env: { ...process.env, APP_ROOT: '/home/sandbox/invoiceguard', DB_FILE: DB, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', d => { out += d.toString(); });
for (let i = 0; i < 60; i++) { const r = await call('GET', '/api/me'); if (r.status) break; await new Promise(r2 => setTimeout(r2, 100)); }
const stats = async () => { out = ''; srv.kill('SIGUSR2'); await new Promise(r => setTimeout(r, 250)); const l = out.split('\n').find(x => x.startsWith('STATS ')); return l ? JSON.parse(l.slice(6)) : null; };
const r0 = await call('POST', '/api/signup', { body: { email: 'mem@audit.example', password: 'Audit-Pass-2026!' } });
const cookie = (r0.headers['set-cookie'] ?? [''])[0].split(';')[0];
await call('POST', '/api/seller', { cookie, body: { name: 'Mem S.L.', nif: 'B12345674', address: 'Calle 1', country: 'ES', marketplaces: ['ES'] } });
await call('POST', '/api/amazon/connect', { cookie, body: { manual: true } });
const big = vidrReport(5, 4, 41, { padTo: 5900000 });
console.log(JSON.stringify({ phase: 'mem_before_40', stats: await stats() }));
const t0 = performance.now();
const res = await Promise.all(Array.from({ length: 40 }, () => call('POST', '/api/manual/preview', { cookie, body: { text: big }, timeout: 200000 })));
const codes = {}; for (const r of res) codes[r.status || r.err] = (codes[r.status || r.err] || 0) + 1;
const ms = res.map(r => r.ms).sort((a, b) => a - b);
console.log(JSON.stringify({ phase: 'mem_40x5_9MB', codes, wallMs: Math.round(performance.now() - t0), p50: Math.round(ms[20]), max: Math.round(ms.at(-1)), stats: await stats() }));
const t1 = Date.now();
const closed = await new Promise((ok) => {
  const s = net.connect(PORT, '127.0.0.1', () => s.write('POST /api/me HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"a":'));
  s.on('close', () => ok({ by: 'server-close', ms: Date.now() - t1 }));
  s.on('error', (e) => ok({ by: 'error ' + e.code, ms: Date.now() - t1 }));
  setTimeout(() => { s.destroy(); ok({ by: 'still-open-at-70s', ms: Date.now() - t1 }); }, 70000);
});
console.log(JSON.stringify({ phase: 'partial_body_lifetime', ...closed, stats: await stats() }));
srv.kill('SIGTERM');
