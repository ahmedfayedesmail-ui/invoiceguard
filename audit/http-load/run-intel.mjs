// HTTP-layer audit of the PR #5 branch (d1466ff, read-only clone): seal API and timeline reads under load.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { client, runPhase, summarize } from './lib.mjs';

const ROOT = process.env.APP_ROOT ?? '/home/sandbox/ig-pr5';
const PORT = Number(process.env.PORT ?? 4320);
const DB = process.env.DB_FILE ?? '/tmp/audit-intel.db';
const call = client(PORT);
const rec = (o) => console.log(JSON.stringify(o));
const { openDb, migrateAuth } = await import(pathToFileURL(ROOT + '/src/db.js').href);

for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s); } catch {} }
const db = openDb(DB); migrateAuth(db);
const iso = (i) => new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString();
function seed(sid, rows) {
  db.prepare('INSERT INTO sellers (id,name,created_at,marketplace_ids) VALUES (?,?,?,?)').run(sid, 'Audit ' + sid, iso(0), '["ES"]');
  db.prepare('INSERT INTO users (id,email,salt,hash,seller_id,created_at) VALUES (?,?,?,?,?,?)').run('u-' + sid, sid + '@audit.example', 's', 'h', sid, iso(0));
  db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run('tok-' + sid, 'u-' + sid, Date.now() + 86400000);
  const ev = db.prepare('INSERT INTO events (ts,seller_id,type,detail) VALUES (?,?,?,?)');
  const ih = db.prepare('INSERT INTO integrity_history (seller_id,shipment_key,code,field,event,fingerprint,at) VALUES (?,?,?,?,?,?,?)');
  const inv = db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,upload_status) VALUES (?,?,?,?,?,?,?,?)');
  const sh = db.prepare('INSERT INTO shipments (seller_id,key,order_id,shipping_id,total,vat,shipment_date,due_at,status,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const nEv = Math.floor(rows * .45), nIh = Math.floor(rows * .25), nInv = Math.floor(rows * .10), nSh = rows - nEv - nIh - nInv;
  db.exec('BEGIN');
  for (let i = 0; i < nEv; i++) ev.run(iso(i), sid, 'invoice_created', JSON.stringify({ number: `${sid}-${i % nInv}`, status: 'ready', reason: 'synthetic free text ' + i }));
  for (let i = 0; i < nIh; i++) ih.run(sid, `SH-${i % nSh}`, 'AMOUNT_MISMATCH', 'total', i % 2 ? 'opened' : 'resolved', 'fp-' + i, iso(i));
  for (let i = 0; i < nInv; i++) inv.run(sid, `${sid}-${i}`, `SH-${i}`, 'invoice', iso(i), 59.9 + (i % 7), 9.9, 'ready');
  for (let i = 0; i < nSh; i++) sh.run(sid, `SH-${i}`, 'O-' + i, 'SH-' + i, 59.9, 9.9, '2026-11-01', '2026-12-01', 'open', 'test', iso(i));
  db.exec('COMMIT');
}
seed('chain1k', 1000); seed('chain20k', 20000);
for (const s of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']) seed(s, 2000);
db.close();

const srv = spawn(process.execPath, ['server.mjs'], { cwd: '/home/sandbox/ig-http-audit', env: { ...process.env, APP_ROOT: ROOT, DB_FILE: DB, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', d => { out += d.toString(); });
srv.stderr.on('data', d => process.stdout.write('[srv:err] ' + d));
for (let i = 0; i < 100; i++) { const r = await call('GET', '/api/me', { cookie: 'sid=tok-chain1k' }); if (r.status) break; await new Promise(r => setTimeout(r, 100)); }
const stats = async () => { out = ''; srv.kill('SIGUSR2'); await new Promise(r => setTimeout(r, 250)); const l = out.split('\n').find(x => x.startsWith('STATS ')); return l ? JSON.parse(l.slice(6)) : null; };
const ck = (s) => 'sid=tok-' + s;
const phase = process.argv[2] ?? 'all';
try {
  if (phase === 'all' || phase === 'seal') {
    let r = await call('POST', '/api/intel/seal', { cookie: ck('chain1k'), body: {}, timeout: 300000 });
    rec({ phase: 'seal_first_1000_rows', status: r.status, ms: Math.round(r.ms), added: r.json?.added, seq: r.json?.head?.sequence, valid: r.json?.verification?.valid });
    r = await call('POST', '/api/intel/seal', { cookie: ck('chain1k'), body: {}, timeout: 300000 });
    rec({ phase: 'seal_again_unchanged', status: r.status, ms: Math.round(r.ms), added: r.json?.added, seq: r.json?.head?.sequence });
    rec({ phase: 'stats_after_1k', stats: await stats() });
    r = await call('POST', '/api/intel/seal', { cookie: ck('chain20k'), body: {}, timeout: 300000 });
    rec({ phase: 'seal_first_20000_rows', status: r.status, ms: Math.round(r.ms), added: r.json?.added, seq: r.json?.head?.sequence, valid: r.json?.verification?.valid, stats: await stats() });
    r = await call('POST', '/api/intel/seal', { cookie: ck('chain20k'), body: {}, timeout: 300000 });
    rec({ phase: 'seal_20k_no_new_rows', status: r.status, ms: Math.round(r.ms), added: r.json?.added, stats: await stats() });
  }
  if (phase === 'all' || phase === 'timeline') {
    await call('POST', '/api/intel/seal', { cookie: ck('chain1k'), body: {}, timeout: 300000 });
    const s20 = await call('POST', '/api/intel/seal', { cookie: ck('chain20k'), body: {}, timeout: 300000 });
    rec({ phase: 'timeline_prereq_seal_20k', status: s20.status, ms: Math.round(s20.ms), seq: s20.json?.head?.sequence });
    let r = await call('GET', '/api/intel/timeline?number=chain1k-0', { cookie: ck('chain1k'), timeout: 120000 });
    rec({ phase: 'timeline_1k_chain', status: r.status, ms: Math.round(r.ms), events: r.json?.events?.length, seq: r.json?.checkpoint?.sequence });
    r = await call('GET', '/api/intel/timeline?number=chain20k-0', { cookie: ck('chain20k'), timeout: 120000 });
    rec({ phase: 'timeline_20k_chain', status: r.status, ms: Math.round(r.ms), events: r.json?.events?.length, seq: r.json?.checkpoint?.sequence });
    await runPhase('timeline_conc10_20k_chain', { conc: 10, seconds: 10 }, async () => call('GET', '/api/intel/timeline?number=chain20k-0', { cookie: ck('chain20k'), timeout: 120000 }));
    rec({ phase: 'stats_after_timeline_conc10', stats: await stats() });
    await runPhase('timeline_conc1_20k_chain', { conc: 1, seconds: 8 }, async () => call('GET', '/api/intel/timeline?number=chain20k-0', { cookie: ck('chain20k'), timeout: 120000 }));
    await runPhase('timeline_conc10_1k_chain', { conc: 10, seconds: 8 }, async () => call('GET', '/api/intel/timeline?number=chain1k-0', { cookie: ck('chain1k'), timeout: 120000 }));
  }
  if (phase === 'all' || phase === 'sealconc') {
    let r = await call('POST', '/api/intel/seal', { cookie: ck('c1'), body: {}, timeout: 300000 });
    rec({ phase: 'seal_c1_2000_rows', status: r.status, ms: Math.round(r.ms), added: r.json?.added });
    const same = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/api/intel/seal', { cookie: ck('c1'), body: {}, timeout: 300000 })));
    rec({ phase: 'seal_conc8_same_seller', codes: summarize('x', same).codes, p50: summarize('x', same).p50, max: summarize('x', same).max, addedTotal: same.reduce((n, x) => n + (x.json?.added ?? 0), 0), stats: await stats() });
    const diff = await Promise.all(['c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].map(s => call('POST', '/api/intel/seal', { cookie: ck(s), body: {}, timeout: 300000 })));
    rec({ phase: 'seal_conc7_different_sellers', codes: summarize('x', diff).codes, p50: summarize('x', diff).p50, max: summarize('x', diff).max, addedTotal: diff.reduce((n, x) => n + (x.json?.added ?? 0), 0), stats: await stats() });
    const tl = await call('GET', '/api/intel/timeline?number=c1-0', { cookie: ck('c1') });
    rec({ phase: 'chain_valid_after_concurrent_seals', status: tl.status, valid: tl.json?.verification?.valid, seq: tl.json?.checkpoint?.sequence });
  }
  if (phase === 'all' || phase === 'malformed') {
    const cases = [
      ['timeline_no_number', 'GET', '/api/intel/timeline', {}],
      ['timeline_unknown_invoice', 'GET', '/api/intel/timeline?number=NOPE-1', {}],
      ['timeline_201_char_number', 'GET', '/api/intel/timeline?number=' + 'a'.repeat(201), {}],
      ['timeline_not_sealed_seller', 'GET', '/api/intel/timeline?number=c1-0', {}],
      ['seal_via_GET', 'GET', '/api/intel/seal', {}],
      ['timeline_via_POST', 'POST', '/api/intel/timeline?number=chain1k-0', {}],
      ['seal_bad_json', 'POST', '/api/intel/seal', { raw: '{bad', headers: { 'content-type': 'application/json' } }],
      ['seal_wrong_content_type', 'POST', '/api/intel/seal', { raw: '{}', headers: { 'content-type': 'text/plain' } }],
      ['seal_oversize_body', 'POST', '/api/intel/seal', { raw: JSON.stringify({ x: 'a'.repeat(70000) }), headers: { 'content-type': 'application/json' } }],
      ['timeline_unauthenticated', 'GET', '/api/intel/timeline?number=chain1k-0', { anon: true }],
    ];
    for (const [name, method, path, o] of cases) {
      const r = await call(method, path, { cookie: o.anon ? undefined : ck('chain1k'), raw: o.raw, headers: o.headers, body: o.raw ? undefined : (method === 'POST' ? {} : undefined), timeout: 60000 });
      rec({ phase: 'malformed_' + name, status: r.status, ms: Math.round(r.ms), code: r.json?.code ?? null, error: r.json?.error?.slice(0, 90) ?? null });
    }
  }
  if (phase === 'all' || phase === 'export') {
    const r = await call('GET', '/api/intel/export', { cookie: ck('chain20k'), timeout: 300000 });
    rec({ phase: 'export_20k_chain', status: r.status, ms: Math.round(r.ms), bytes: r.bytes, stats: await stats() });
  }
} finally { srv.kill('SIGTERM'); }
