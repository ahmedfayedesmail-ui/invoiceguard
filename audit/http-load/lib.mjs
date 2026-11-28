import http from 'node:http';
import net from 'node:net';
const agent = new http.Agent({ keepAlive: true, maxSockets: 4000 });
export function client(port) {
  const u = { host: '127.0.0.1', port };
  const call = (method, path, { body, cookie, headers = {}, raw = null, timeout = 120000 } = {}) => new Promise((ok) => {
    const t0 = performance.now();
    const payload = raw !== null ? Buffer.from(raw) : (body === undefined ? null : Buffer.from(JSON.stringify(body)));
    const h = { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...(cookie ? { cookie } : {}), ...headers };
    const req = http.request({ ...u, method, path, agent, headers: h }, (res) => {
      let n = 0; const chunks = []; res.on('data', c => { n += c.length; if (n < 200000) chunks.push(c); });
      res.on('end', () => { let j = null; const txt = Buffer.concat(chunks).toString(); try { j = JSON.parse(txt); } catch {} ok({ status: res.statusCode, ms: performance.now() - t0, bytes: n, json: j, text: txt.slice(0, 300), headers: res.headers }); });
    });
    req.on('error', e => ok({ status: 0, ms: performance.now() - t0, err: e.code || e.message }));
    req.setTimeout(timeout, () => req.destroy(new Error('client-timeout')));
    if (payload) req.write(payload); req.end();
  });
  return call;
}
export const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
export function summarize(name, results, extra = {}) {
  const lat = results.map(r => r.ms).sort((a, b) => a - b);
  const codes = {}; for (const r of results) { const k = r.status || r.err || 'err'; codes[k] = (codes[k] || 0) + 1; }
  return { phase: name, n: results.length, p50: +pct(lat, .5).toFixed(0), p95: +pct(lat, .95).toFixed(0), p99: +pct(lat, .99).toFixed(0), max: +(lat.at(-1) ?? 0).toFixed(0), codes, ...extra };
}
export async function runPhase(name, { conc, seconds = 0, count = 0 }, fn) {
  const results = []; const end = seconds ? performance.now() + seconds * 1000 : Infinity; let i = 0; let stop = false;
  const take = () => { const k = i++; if (count && k >= count) { stop = true; return -1; } if (performance.now() >= end) { stop = true; return -1; } return k; };
  await Promise.all(Array.from({ length: conc }, async () => { for (;;) { const k = take(); if (k < 0) return; results.push(await fn(k)); } }));
  const s = summarize(name, results); console.log(JSON.stringify(s)); return s;
}
export function rawSockets(port, n) { // open n connections that send a header with a body that never completes
  const socks = [];
  return new Promise((ok) => {
    let opened = 0;
    for (let i = 0; i < n; i++) {
      const s = net.connect(port, '127.0.0.1', () => { s.write(`POST /api/me HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"a":`); if (++opened === n) ok(socks); });
      s.on('error', () => {}); socks.push(s);
    }
  });
}
