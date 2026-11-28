import { spawn } from 'node:child_process';
import net from 'node:net';
import { client } from './lib.mjs';
import { vidrReport } from './gen.mjs';
const PORT = 4397, DB = '/tmp/probe2.db';
const call = client(PORT);
for (const s of ['', '-wal', '-shm']) { try { (await import('node:fs')).rmSync(DB + s); } catch {} }
const srv = spawn(process.execPath, ['server.mjs'], { cwd: '/home/sandbox/ig-http-audit', env: { ...process.env, APP_ROOT: '/home/sandbox/invoiceguard', DB_FILE: DB, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', d => { out += d.toString(); });
for (let i = 0; i < 60; i++) { const r = await call('GET', '/api/me'); if (r.status) break; await new Promise(r2 => setTimeout(r2, 100)); }
const stats = async () => { out = ''; srv.kill('SIGUSR2'); await new Promise(r => setTimeout(r, 250)); const l = out.split('\n').find(x => x.startsWith('STATS ')); return l ? JSON.parse(l.slice(6)) : null; };

// 1. sample run cost
const s1 = [];
for (let i = 0; i < 3; i++) { const r = await call('GET', '/api/sample/run', { timeout: 120000 }); s1.push({ status: r.status, ms: Math.round(r.ms) }); }
console.log(JSON.stringify({ phase: 'sample_run_cost', runs: s1, stats: await stats() }));

// 2. global sample cap: rotate XFF until 429
let ok = 0, first429 = null, total = 0;
for (let i = 0; i < 140; i++) {
  const r = await call('GET', '/api/sample/run', { headers: { 'x-forwarded-for': `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}` }, timeout: 120000 });
  total++;
  if (r.status === 200) ok++; else { first429 = { i, status: r.status, error: r.json?.error, retryAfter: r.headers['retry-after'] }; break; }
}
console.log(JSON.stringify({ phase: 'sample_global_cap', successes: ok, attempts: total, firstBlocked: first429, stats: await stats() }));

// 3. GET performs a state-changing sync (demo mode)
const r = await call('POST', '/api/signup', { body: { email: 'demo@audit.example', password: 'Audit-Pass-2026!' } });
const cookie = (r.headers['set-cookie'] ?? [''])[0].split(';')[0];
await call('POST', '/api/seller', { cookie, body: { name: 'Demo S.L.', nif: 'B12345674', address: 'Calle 1', country: 'ES', marketplaces: ['ES'] } });
await call('POST', '/api/amazon/connect', { cookie, body: { demo: true } });
const before = await call('GET', '/api/dashboard', { cookie });
const g = await call('GET', '/api/sync', { cookie });
const after = await call('GET', '/api/dashboard', { cookie });
console.log(JSON.stringify({ phase: 'GET_sync_demo', status: g.status, uploaded: g.json?.uploaded, kpisBefore: before.json?.kpis, kpisAfter: after.json?.kpis }));

// 4. chunked oversized body: how long does the server keep reading before 413
const chunk = Buffer.alloc(1024 * 1024, 0x61);
const t0 = Date.now();
const res = await new Promise((ok) => {
  const s = net.connect(PORT, '127.0.0.1', async () => {
    s.write('POST /api/manual/preview HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n');
    for (let i = 0; i < 50; i++) { s.write(chunk.length.toString(16) + '\r\n'); s.write(chunk); s.write('\r\n'); }
    s.write('0\r\n\r\n');
  });
  let buf = '';
  s.on('data', d => { buf += d.toString(); });
  s.on('close', () => ok({ text: buf.slice(0, 200), ms: Date.now() - t0 }));
  setTimeout(() => { s.destroy(); ok({ text: 'client-timeout ' + buf.slice(0, 80), ms: Date.now() - t0 }); }, 30000);
});
console.log(JSON.stringify({ phase: 'chunked_50MB_body', response: res.text.split('\r\n')[0], ms: res.ms, stats: await stats() }));
srv.kill('SIGTERM');
