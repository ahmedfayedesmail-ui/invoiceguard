import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { client, summarize } from './lib.mjs';
const ROOT = '/home/sandbox/ig-pr5', PORT = 4394, DB = '/tmp/probe5.db';
const call = client(PORT);
const { openDb, migrateAuth } = await import(pathToFileURL(ROOT + '/src/db.js').href);
for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s); } catch {} }
const db = openDb(DB); migrateAuth(db);
const iso = (i) => new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString();
db.prepare('INSERT INTO sellers (id,name,created_at,marketplace_ids) VALUES (?,?,?,?)').run('big', 'Big', iso(0), '["ES"]');
db.prepare('INSERT INTO users (id,email,salt,hash,seller_id,created_at) VALUES (?,?,?,?,?,?)').run('u1', 'big@x.example', 's', 'h', 'big', iso(0));
db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run('t1', 'u1', Date.now() + 86400000);
db.prepare('INSERT INTO sellers (id,name,created_at,marketplace_ids) VALUES (?,?,?,?)').run('other', 'Other', iso(0), '["ES"]');
db.prepare('INSERT INTO users (id,email,salt,hash,seller_id,created_at) VALUES (?,?,?,?,?,?)').run('u2', 'other@x.example', 's', 'h', 'other', iso(0));
db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run('t2', 'u2', Date.now() + 86400000);
const ev = db.prepare('INSERT INTO events (ts,seller_id,type,detail) VALUES (?,?,?,?)');
const inv = db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,upload_status) VALUES (?,?,?,?,?,?,?,?)');
db.exec('BEGIN');
for (let i = 0; i < 20000; i++) ev.run(iso(i), 'big', 'invoice_created', JSON.stringify({ number: `big-${i % 2000}`, status: 'ready' }));
for (let i = 0; i < 2000; i++) inv.run('big', `big-${i}`, `SH-${i}`, 'invoice', iso(i), 59.9, 9.9, 'ready');
db.exec('COMMIT'); db.close();
const srv = spawn(process.execPath, ['server.mjs'], { cwd: '/home/sandbox/ig-http-audit', env: { ...process.env, APP_ROOT: ROOT, DB_FILE: DB, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', d => { out += d.toString(); });
for (let i = 0; i < 100; i++) { const r = await call('GET', '/api/me', { cookie: 'sid=t1' }); if (r.status) break; await new Promise(r => setTimeout(r, 100)); }
const stats = async () => { out = ''; srv.kill('SIGUSR2'); await new Promise(r => setTimeout(r, 250)); const l = out.split('\n').find(x => x.startsWith('STATS ')); return l ? JSON.parse(l.slice(6)) : null; };
const first = await call('POST', '/api/intel/seal', { cookie: 'sid=t1', body: {}, timeout: 300000 });
console.log(JSON.stringify({ phase: 'seal_20k_first', ms: Math.round(first.ms), seq: first.json?.head?.sequence }));
const seqMs = [];
for (let i = 0; i < 5; i++) { const r = await call('POST', '/api/intel/seal', { cookie: 'sid=t1', body: {}, timeout: 300000 }); seqMs.push({ ms: Math.round(r.ms), added: r.json?.added }); }
console.log(JSON.stringify({ phase: 'seal_5_sequential_noop_20k', runs: seqMs, totalMs: seqMs.reduce((n, x) => n + x.ms, 0), stats: await stats() }));
const bg = call('POST', '/api/intel/seal', { cookie: 'sid=t1', body: {}, timeout: 300000 });
await new Promise(r => setTimeout(r, 200));
const probes = [];
for (let i = 0; i < 20; i++) { probes.push(await call('GET', '/api/me', { cookie: 'sid=t2', timeout: 300000 })); await new Promise(r => setTimeout(r, 100)); }
const done = await bg;
console.log(JSON.stringify({ phase: 'seal_blocks_other_seller', sealMs: Math.round(done.ms), otherRequests: summarize('me', probes), stats: await stats() }));
const ex = await call('GET', '/api/intel/export', { cookie: 'sid=t1', timeout: 300000 });
console.log(JSON.stringify({ phase: 'export_20k_chain', status: ex.status, ms: Math.round(ex.ms), bytes: ex.bytes, stats: await stats() }));
srv.kill('SIGTERM');
