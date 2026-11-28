// T9 DoS hardening: per-IP connection cap, body-read deadline, byte-accurate body limit, early destroy on oversize (api-load F2/F5/F7). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { createApp } from '../src/app.js';

const validate = async (v) => ({ status: 'valid', vat: v });
async function start(extraEnv = {}) {
  const { server } = createApp({ validate, secret: 'test', env: { ...process.env, ...extraEnv } });
  await new Promise(r => server.listen(0, r));
  return { server, port: server.address().port };
}
// a request from a chosen local source address (127.0.0.2 = a different "client IP" than the attacker's 127.0.0.1)
const get = (port, path, from = '127.0.0.2') => new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port, path, localAddress: from, agent: false, timeout: 5000 }, (m) => { m.resume(); m.on('end', () => res(m.statusCode)); }); r.on('error', rej); r.on('timeout', () => r.destroy(new Error('timeout'))); r.end(); });
const idle = (port, n, path = '/api/login') => { const socks = []; let closed = 0; for (let i = 0; i < n; i++) { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => s.write(`POST ${path} HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 5000\r\n\r\n{"em`)); s.on('close', () => closed++); s.on('error', () => {}); s.resume(); socks.push(s); } return { socks, closed: () => closed }; };
const until = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return fn(); };
const rawPost = (port, path, declared, payload, { cookie = '' } = {}) => new Promise(res => { const s = net.connect(port, '127.0.0.1'); let got = ''; const t = Date.now(); let first = null;
  s.on('data', d => { got += d; if (first === null && /HTTP\/1.1 \d+/.test(got)) first = Date.now() - t; }); s.on('error', () => {}); s.on('close', () => res({ got, first, closedMs: Date.now() - t, sent: s.bytesWritten }));
  s.on('connect', () => { s.write(`POST ${path} HTTP/1.1\r\nhost: x\r\ncookie: ${cookie}\r\ncontent-type: application/json\r\ncontent-length: ${declared}\r\n\r\n`); let sent = 0; const chunk = Buffer.alloc(65536, 0x61); const pump = () => { while (sent + chunk.length <= payload) { const ok = s.write(chunk); sent += chunk.length; if (!ok) return s.once('drain', pump); } s.end(); }; pump(); }); });

test('F2: idle partial-body sockets from one IP hit the per-IP cap and do not deny other clients', async () => {
  const { server, port } = await start({ MAX_CONN_PER_IP: '5', MAX_INFLIGHT: '400' });
  const a = idle(port, 40);
  await new Promise(r => setTimeout(r, 600));
  assert.ok(a.closed() >= 30, 'connections over the cap are refused (closed: ' + a.closed() + ')');
  assert.equal(await get(port, '/api/dashboard'), 401, 'another client IP is still served normally');
  a.socks.forEach(s => s.destroy()); server.close();
});

test('F2: an idle body is closed within the body-read deadline, and capacity is freed', async () => {
  const { server, port } = await start({ BODY_READ_DEADLINE_MS: '800', MAX_CONN_PER_IP: '50' });
  const a = idle(port, 3);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(a.closed(), 0, 'not yet closed before the deadline');
  assert.ok(await until(() => a.closed() === 3, 3000), 'all idle bodies closed shortly after the 800 ms deadline');
  assert.equal(await get(port, '/api/dashboard', '127.0.0.1'), 401);
  server.close();
});

test('F2: the cap counts live connections only: it recovers after sockets close', async () => {
  const { server, port } = await start({ MAX_CONN_PER_IP: '3' });
  const a = idle(port, 3); await new Promise(r => setTimeout(r, 300)); a.socks.forEach(s => s.destroy()); await new Promise(r => setTimeout(r, 300));
  assert.equal(await get(port, '/api/dashboard', '127.0.0.1'), 401);
  server.close();
});

test('F5: the limit counts BYTES: a 6,000,001-byte body of 2-byte characters is a 413 with an honest message', async () => {
  const { server, port } = await start();
  const base = `http://127.0.0.1:${port}`;
  const exact = (bytes) => { const pad = bytes - Buffer.byteLength(JSON.stringify({ text: '' })); const n2 = Math.floor(pad / 2); return JSON.stringify({ text: 'é'.repeat(n2) + 'a'.repeat(pad - n2 * 2) }); };
  const over = exact(6000001), at = exact(6000000);
  assert.equal(Buffer.byteLength(over), 6000001); assert.ok(over.length < 4000000, 'under the limit if counted in UTF-16 units');
  const r = await fetch(base + '/api/manual/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: over });
  assert.equal(r.status, 413); const j = await r.json();
  assert.match(j.error, /too large/); assert.match(j.error, /6,000,000 bytes/); assert.match(j.error, /CSV|report/); assert.doesNotMatch(j.error, /5 MB/);
  const ok = await fetch(base + '/api/manual/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: at });
  assert.equal(ok.status, 401, 'exactly at the limit passes the size check (then needs sign-in)');
  const ext = await fetch(base + '/api/export/external', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pdfBase64: 'A'.repeat(8000001) }) });
  assert.equal(ext.status, 413); assert.match((await ext.json()).error, /8,000,000 bytes.*|PDF/s);
  const gen = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'é'.repeat(40000) }) }); // 80,000 bytes, only 40,000 chars
  assert.equal(gen.status, 413); assert.match((await gen.json()).error, /64,000 bytes/);
  server.close();
});

test('F7: an oversized stream gets its 413 before it completes and the socket is destroyed', async () => {
  const { server, port } = await start();
  const r = await rawPost(port, '/api/manual/preview', 50e6, 50e6, {});
  assert.match(r.got, /^HTTP\/1\.1 413/); assert.match(r.got, /6,000,000 bytes/);
  assert.ok(r.sent < 50e6, 'client was cut off before sending everything (sent ' + r.sent + ')');
  // chunked / undeclared length: the cut happens when the byte count crosses the limit
  const s = await new Promise(res => { const so = net.connect(port, '127.0.0.1'); let got = ''; so.on('data', d => got += d); so.on('error', () => {}); so.on('close', () => res({ got, sent: so.bytesWritten }));
    so.on('connect', () => { so.write('POST /api/login HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n'); const piece = Buffer.alloc(8192, 0x61); let i = 0; const t = setInterval(() => { if (so.destroyed || i++ > 2000) { clearInterval(t); return; } so.write(piece.length.toString(16) + '\r\n'); so.write(piece); so.write('\r\n'); }, 0); }); });
  assert.match(s.got, /^HTTP\/1\.1 413/); assert.match(s.got, /64,000 bytes/); assert.ok(s.sent < 8192 * 2000, 'stream stopped early (sent ' + s.sent + ')');
  server.close();
});

test('normal behaviour unchanged: small JSON, bad JSON, non-object JSON', async () => {
  const { server, port } = await start();
  const base = `http://127.0.0.1:${port}`; const post = (b) => fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
  assert.equal((await post(JSON.stringify({ email: 'a@b.es', password: 'x' }))).status, 401);
  assert.equal((await post('{nope')).status, 400);
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post('')).status, 401, 'empty body is treated as {} (unchanged)');
  server.close();
});
