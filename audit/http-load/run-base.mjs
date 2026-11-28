// HTTP-layer audit of the base app (ebfd583): manual uploads, malformed requests, limits, rate limits, in-flight cap.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { client, runPhase, summarize, rawSockets } from './lib.mjs';
import { vidrReport } from './gen.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = process.env.APP_ROOT ?? '/home/sandbox/invoiceguard';
const PORT = Number(process.env.PORT ?? 4310);
const DB = process.env.DB_FILE ?? '/tmp/audit-base.db';
const call = client(PORT);
const log = [];
const rec = (o) => { log.push(o); console.log(JSON.stringify(o)); };
let srv, srvOut = [];
async function startServer() {
  for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s); } catch {} }
  srv = spawn(process.execPath, ['server.mjs'], { cwd: HERE, env: { ...process.env, APP_ROOT: ROOT, DB_FILE: DB, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { const s = d.toString(); srvOut.push(s); process.stdout.write('[srv] ' + s); });
  srv.stderr.on('data', d => process.stdout.write('[srv:err] ' + d));
  for (let i = 0; i < 100; i++) { const r = await call('GET', '/api/me'); if (r.status) return; await new Promise(r2 => setTimeout(r2, 100)); }
  throw new Error('server did not start');
}
const stats = async () => { srvOut = []; srv.kill('SIGUSR2'); await new Promise(r => setTimeout(r, 250)); const line = srvOut.join('').split('\n').find(l => l.startsWith('STATS ')); return line ? JSON.parse(line.slice(6)) : null; };

const PW = 'Audit-Pass-2026!';
const sellers = [];
async function seedSellers(n, tag = 'base') {
  for (let i = 0; i < n; i++) {
    const email = `${tag}${i}-${Date.now()}@audit.example`;
    const r = await call('POST', '/api/signup', { body: { email, password: PW } });
    if (r.status !== 200) throw new Error('signup ' + r.status + ' ' + r.text);
    const cookie = (r.headers['set-cookie'] ?? [''])[0].split(';')[0];
    const s = await call('POST', '/api/seller', { cookie, body: { name: `Audit Seller ${i} S.L.`, nif: 'B12345674', address: 'Calle Falsa 1, Madrid', country: 'ES', marketplaces: ['ES', 'DE'] } });
    if (s.status !== 200) throw new Error('seller ' + s.status + ' ' + s.text);
    const c = await call('POST', '/api/amazon/connect', { cookie, body: { manual: true } });
    if (c.status !== 200) throw new Error('connect ' + c.status + ' ' + c.text);
    sellers.push({ email, cookie });
  }
  return sellers.length;
}

const phase = process.argv[2] ?? 'all';
await startServer();
try {
  const seeded = await seedSellers(24);
  rec({ phase: 'seed', sellers: seeded, stats: await stats() });

  if (phase === 'all' || phase === 'smoke') {
    const r = await call('POST', '/api/manual/preview', { cookie: sellers[0].cookie, body: { text: vidrReport(200, 0) } });
    rec({ phase: 'smoke_preview', status: r.status, ms: Math.round(r.ms), willIssue: r.json?.willIssue, heldCount: r.json?.heldCount, rows: r.json?.rows, skipped: r.json?.skippedCount });
    const i = await call('POST', '/api/manual/issue', { cookie: sellers[1].cookie, body: { text: vidrReport(50, 1), attest: true } });
    rec({ phase: 'smoke_issue', status: i.status, ms: Math.round(i.ms), issued: i.json?.issued, heldNow: i.json?.heldNow, errors: i.json?.errors });
  }

  if (phase === 'all' || phase === 'preview') {
    let k = 0;
    await runPhase('preview_conc8_1000rows', { conc: 8, seconds: 10 }, async () => {
      const s = sellers[(k++) % sellers.length];
      return call('POST', '/api/manual/preview', { cookie: s.cookie, body: { text: vidrReport(1000, k % 10) } });
    });
    rec({ phase: 'after_preview_conc8', stats: await stats() });
    let m = 0;
    await runPhase('preview_conc1_1000rows', { conc: 1, seconds: 8 }, async () => call('POST', '/api/manual/preview', { cookie: sellers[(m++) % sellers.length].cookie, body: { text: vidrReport(1000, m % 10) } }));
    rec({ phase: 'after_preview_conc1', stats: await stats() });
  }

  if (phase === 'all' || phase === 'issue') {
    let k = 0;
    await runPhase('issue_conc8_500rows', { conc: 8, seconds: 20 }, async () => {
      const s = sellers[(k++) % sellers.length];
      return call('POST', '/api/manual/issue', { cookie: s.cookie, body: { text: vidrReport(500, k % 10, k), attest: true } });
    });
    rec({ phase: 'after_issue_conc8', stats: await stats() });
    await runPhase('issue_same_seller_conc8', { conc: 8, count: 8 }, async () => call('POST', '/api/manual/issue', { cookie: sellers[2].cookie, body: { text: vidrReport(300, 2, 777), attest: true } }));
    rec({ phase: 'after_same_seller', stats: await stats() });
  }

  if (phase === 'all' || phase === 'stall') {
    const bg = call('POST', '/api/manual/issue', { cookie: sellers[9].cookie, body: { text: vidrReport(3000, 9, 55), attest: true }, timeout: 300000 });
    await new Promise(r => setTimeout(r, 300));
    const probes = [];
    for (let i = 0; i < 120; i++) { probes.push(await call('GET', '/api/me', { cookie: sellers[10].cookie, timeout: 300000 })); await new Promise(r => setTimeout(r, 100)); }
    const done = await bg;
    rec({ phase: 'stall_during_3000_row_issue', issueMs: Math.round(done.ms), issueStatus: done.status, issued: done.json?.issued, otherRequests: summarize('me', probes), stats: await stats() });
  }

  if (phase === 'all' || phase === 'big') {
    const r = await call('POST', '/api/manual/issue', { cookie: sellers[3].cookie, body: { text: vidrReport(10000, 3, 900), attest: true }, timeout: 180000 });
    rec({ phase: 'big_10000_rows_issue', status: r.status, ms: Math.round(r.ms), issued: r.json?.issued, truncated: r.json?.truncated, errors: r.json?.errors });
    rec({ phase: 'after_big', stats: await stats() });
  }

  if (phase === 'all' || phase === 'cap') {
    const bodyOf = (targetUnits, char, seed) => { let padTo = targetUnits - 300; let text = vidrReport(5, 4, seed, { padTo, padChar: char }); for (let i = 0; i < 8; i++) { const u = JSON.stringify({ text }).length; if (u === targetUnits) break; padTo += Math.round((targetUnits - u) / (char.length > 1 ? 2 : 1)); text = vidrReport(5, 4, seed, { padTo, padChar: char }); } return text; };
    const cases = [
      ['body_exactly_6_000_000_ascii', bodyOf(6000000, 'a', 11)],
      ['body_6_000_001_ascii', bodyOf(6000001, 'a', 12)],
      ['body_5_999_999_ascii', bodyOf(5999999, 'a', 13)],
      ['body_6_000_000_units_arabic', bodyOf(6000000, '\u0627', 14)],
      ['body_5_999_998_units_emoji', bodyOf(5999998, '\u{1F600}', 15)],
    ];
    for (const [name, text] of cases) {
      const r = await call('POST', '/api/manual/preview', { cookie: sellers[4].cookie, body: { text }, timeout: 180000 });
      rec({ phase: 'cap_' + name, chars: text.length, jsonBodyChars: JSON.stringify({ text }).length, bytes: Buffer.byteLength(JSON.stringify({ text })), status: r.status, ms: Math.round(r.ms), error: r.json?.error?.slice(0, 120) });
    }
    rec({ phase: 'after_cap', stats: await stats() });
  }

  if (phase === 'all' || phase === 'malformed') {
    const ck = sellers[5].cookie;
    const cases = [
      ['bad_json', { raw: '{"text":', headers: { 'content-type': 'application/json' } }],
      ['array_body', { raw: '[]', headers: { 'content-type': 'application/json' } }],
      ['null_body', { raw: 'null', headers: { 'content-type': 'application/json' } }],
      ['string_body', { raw: '"x"', headers: { 'content-type': 'application/json' } }],
      ['wrong_content_type', { raw: '{"text":"x"}', headers: { 'content-type': 'text/plain' } }],
      ['no_content_type', { raw: '{"text":"x"}', headers: { 'content-type': '' } }],
      ['content_type_suffix_jsonfoo', { raw: '{"text":', headers: { 'content-type': 'application/jsonfoo' } }],
      ['oversize_generic_route_70kb', { raw: JSON.stringify({ email: 'x'.repeat(70000) }), headers: { 'content-type': 'application/json' }, path: '/api/login' }],
      ['oversize_manual_6mb_plus_1', { raw: JSON.stringify({ text: 'a'.repeat(6000001) }), headers: { 'content-type': 'application/json' }, path: '/api/manual/preview' }],
      ['empty_body_post', { raw: '', headers: { 'content-type': 'application/json' } }],
    ];
    for (const [name, o] of cases) {
      const r = await call('POST', o.path ?? '/api/manual/preview', { cookie: ck, raw: o.raw, headers: o.headers, timeout: 120000 });
      rec({ phase: 'malformed_' + name, status: r.status, ms: Math.round(r.ms), error: r.json?.error ?? r.text?.slice(0, 80) });
    }
    for (const [name, method, path] of [['GET_on_sync', 'GET', '/api/sync'], ['GET_on_manual_issue', 'GET', '/api/manual/issue'], ['DELETE_on_me', 'DELETE', '/api/me'], ['HEAD_on_me', 'HEAD', '/api/me'], ['unknown_api', 'GET', '/api/nope'], ['POST_on_dashboard', 'POST', '/api/dashboard']]) {
      const r = await call(method, path, { cookie: ck, body: method === 'POST' ? {} : undefined });
      rec({ phase: 'method_' + name, status: r.status, ms: Math.round(r.ms), error: r.json?.error ?? null });
    }
    const big = await call('GET', '/api/me', { headers: { 'x-pad': 'p'.repeat(20000) } });
    rec({ phase: 'huge_header_20kb', status: big.status, err: big.err ?? null });
  }

  if (phase === 'all' || phase === 'ratelimit') {
    const email = sellers[6].email;
    const seq = [];
    for (let i = 0; i < 10; i++) { const r = await call('POST', '/api/login', { body: { email, password: 'wrong-password-here' } }); seq.push(r.status); }
    rec({ phase: 'login_wrong_x10', statuses: seq });
    const right = await call('POST', '/api/login', { body: { email, password: PW } });
    rec({ phase: 'login_correct_after_10_wrong', status: right.status, error: right.json?.error ?? null });
    const sample = [];
    for (let i = 0; i < 12; i++) { const r = await call('GET', '/api/sample/run', { timeout: 60000 }); sample.push(r.status); }
    rec({ phase: 'sample_run_x12_same_ip', statuses: sample });
    const spoof = [];
    for (let i = 0; i < 12; i++) { const r = await call('GET', '/api/sample/run', { headers: { 'x-forwarded-for': `203.0.113.${i + 1}` }, timeout: 60000 }); spoof.push(r.status); }
    rec({ phase: 'sample_run_x12_spoofed_xff', statuses: spoof });
  }

  if (phase === 'all' || phase === 'inflight') {
    const before = await call('GET', '/api/me', { cookie: sellers[7].cookie });
    const socks = await rawSockets(PORT, 401);
    await new Promise(r => setTimeout(r, 300));
    const during = await call('GET', '/api/me', { cookie: sellers[7].cookie });
    rec({ phase: 'inflight_401_idle_sockets', before: before.status, during: during.status, error: during.json?.error ?? null });
    for (const s of socks) s.destroy();
    await new Promise(r => setTimeout(r, 500));
    const after = await call('GET', '/api/me', { cookie: sellers[7].cookie });
    rec({ phase: 'inflight_after_close', status: after.status, stats: await stats() });
  }

  if (phase === 'all' || phase === 'memory') {
    rec({ phase: 'memory_before', stats: await stats() });
    const big = vidrReport(5, 4, 21, { padTo: 5900000 });
    const results = await Promise.all(Array.from({ length: 20 }, () => call('POST', '/api/manual/preview', { cookie: sellers[8].cookie, body: { text: big }, timeout: 180000 })));
    rec({ phase: 'memory_20x5_9MB', codes: summarize('m', results).codes, p95: summarize('m', results).p95, stats: await stats() });
  }
} finally {
  srv?.kill('SIGTERM');
}
