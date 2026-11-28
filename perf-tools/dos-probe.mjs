// Synthetic DoS probe (F2/F5/F7). Usage: MAX_INFLIGHT=50 node perf-tools/dos-probe.mjs [idleSockets=80] [watchSeconds=40]
import net from 'node:net';
import { createApp } from '../src/app.js';
const N = Number(process.argv[2] ?? 80), WATCH = Number(process.argv[3] ?? 40);
const { server } = createApp({ secret: 'probe', validate: async (v) => ({ status: 'valid', vat: v }) });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const raw = (head, onData) => new Promise(res => { const s = net.connect(port, '127.0.0.1'); let buf = ''; s.on('connect', () => s.write(head)); s.on('data', d => { buf += d; onData?.(s, buf); }); s.on('close', () => res({ s, buf })); s.on('error', () => {}); s._buf = () => buf; });
const socks = []; let closed = 0, ended = 0;
for (let i = 0; i < N; i++) { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => s.write('POST /api/login HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 5000\r\n\r\n{"em')); s.on('close', () => closed++); s.resume(); s.on('error', () => {}); socks.push(s); }
await new Promise(r => setTimeout(r, 1500));
const normal = async () => { try { const r = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { signal: AbortSignal.timeout(5000) }); return r.status; } catch (e) { return 'ERR ' + (e.cause?.code ?? e.name); } };
console.log(JSON.stringify({ idleSockets: N, closedAt1_5s: closed, normalRequestStatus_expect401: await normal() }));
const t0 = Date.now(); let closedAt = null;
while ((Date.now() - t0) / 1000 < WATCH) { await new Promise(r => setTimeout(r, 1000)); if (closedAt === null && closed >= N - 20) closedAt = Math.round((Date.now() - t0) / 1000); }
console.log(JSON.stringify({ afterSeconds: WATCH, idleSocketsClosed: closed, firstTimeMostClosedSec: closedAt, normalRequestStatus: await normal() }));
socks.forEach(s => s.destroy()); await new Promise(r => setTimeout(r, 500)); // fresh capacity so F5/F7 are measured alone
// F5: 6,000,001 BYTES of 2-byte chars (3,000,001 UTF-16 units... 3.0M chars) to a 6e6-limit route
const bodyStr = JSON.stringify({ text: 'é'.repeat(3000001) }); const bytes = Buffer.byteLength(bodyStr);
const r5 = await fetch(`http://127.0.0.1:${port}/api/manual/preview`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'sid=x' }, body: bodyStr }).then(async r => ({ status: r.status, body: (await r.text()).slice(0, 200) })).catch(e => ({ err: String(e.cause?.code ?? e.message) }));
console.log(JSON.stringify({ f5_bodyBytes: bytes, f5_utf16Units: bodyStr.length, f5_result: r5 }));
// F7: stream 50MB at an unauthenticated 64KB-limit route; when does the 413 arrive?
await new Promise(res => { const s = net.connect(port, '127.0.0.1'); const t = Date.now(); let sent = 0, got = '', first = null; const chunk = Buffer.alloc(65536, 0x61);
  s.on('data', d => { got += d; if (first === null && /HTTP\/1.1 \d+/.test(got)) first = { status: got.slice(0, 12), ms: Date.now() - t, bytesSentAtThatPoint: sent }; });
  s.on('error', () => {}); s.on('close', () => { console.log(JSON.stringify({ f7_total_bytes_sent: sent, f7_413_seen: first, f7_socketClosedAfterMs: Date.now() - t })); res(); });
  s.on('connect', () => { s.write('POST /api/login HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 49938432\r\n\r\n'); const pump = () => { while (sent + chunk.length <= 50e6) { const ok = s.write(chunk); sent += chunk.length; if (!ok) return s.once('drain', pump); } s.end(); }; pump(); }); });
socks.forEach(s => s.destroy()); server.close(); process.exit(0);
