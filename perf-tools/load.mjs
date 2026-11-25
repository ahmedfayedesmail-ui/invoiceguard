// Load test for the real InvoiceGuard server. usage: node load.mjs BASE USERS SECONDS CONC [phase,phase]
import http from 'node:http';
const [base, USERS = '20', SECS = '8', CONC = '50', only] = process.argv.slice(2);
const agent = new http.Agent({ keepAlive: true, maxSockets: 1000 });
const u = new URL(base);
const call = (method, path, { body, cookie } = {}) => new Promise((ok) => {
  const t0 = performance.now(); const data = body ? JSON.stringify(body) : null;
  const req = http.request({ host: u.hostname, port: u.port, method, path, agent, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(cookie ? { cookie } : {}) } }, (res) => {
    let n = 0; const chunks = []; res.on('data', c => { n += c.length; if (n < 4096) chunks.push(c); }); res.on('end', () => ok({ status: res.statusCode, ms: performance.now() - t0, headers: res.headers, text: Buffer.concat(chunks).toString() }));
  });
  req.on('error', e => ok({ status: 0, ms: performance.now() - t0, err: e.code })); req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  if (data) req.write(data); req.end();
});
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
async function phase(name, secs, conc, fn) {
  const lat = [], codes = {}; const end = performance.now() + secs * 1000; let i = 0;
  await Promise.all(Array.from({ length: conc }, async (_, w) => { while (performance.now() < end) { const r = await fn(w, i++); lat.push(r.ms); codes[r.status || r.err] = (codes[r.status || r.err] ?? 0) + 1; } }));
  lat.sort((a, b) => a - b);
  const row = { phase: name, conc, rps: +(lat.length / secs).toFixed(1), p50: +pct(lat, .5).toFixed(0), p95: +pct(lat, .95).toFixed(0), p99: +pct(lat, .99).toFixed(0), max: +lat[lat.length - 1]?.toFixed(0), codes };
  console.log(JSON.stringify(row)); return row;
}
// seed users
const users = []; const t0 = performance.now();
for (let i = 0; i < +USERS; i++) {
  const email = `load${i}-${Date.now()}@x.es`, r = await call('POST', '/api/signup', { body: { email, password: 'long-enough-pw' } });
  const cookie = (r.headers['set-cookie'] ?? [])[0]?.split(';')[0]; if (!cookie) { console.log('signup failed', r.status, r.text); process.exit(1); }
  await call('POST', '/api/seller', { cookie, body: { name: 'Load Seller ' + i, nif: 'B12345678', address: 'Calle 1, Madrid', country: 'ES', marketplaces: ['ES', 'DE'] } });
  await call('POST', '/api/amazon/connect', { cookie, body: { demo: true } });
  if (!process.env.NOSYNC) await call('POST', '/api/sync', { cookie, body: {} });
  const d = await call('GET', '/api/dashboard', { cookie }); let num = null; try { num = JSON.parse((await (async () => { const full = await new Promise(ok => { http.get({ host: u.hostname, port: u.port, path: '/api/dashboard', headers: { cookie }, agent }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => ok(b)); }); }); return full; })())).invoices?.[0]?.number; } catch {}
  users.push({ email, cookie, num });
}
console.log(JSON.stringify({ seeded: users.length, seedSeconds: +((performance.now() - t0) / 1000).toFixed(1), withInvoice: users.filter(x => x.num).length }));
const pick = (i) => users[i % users.length];
const phases = {
  static: () => phase('GET / (page)', +SECS, +CONC, () => call('GET', '/')),
  me: () => phase('GET /api/me', +SECS, +CONC, (w, i) => call('GET', '/api/me', { cookie: pick(i).cookie })),
  dashboard: () => phase('GET /api/dashboard', +SECS, +CONC, (w, i) => call('GET', '/api/dashboard', { cookie: pick(i).cookie })),
  rules: () => phase('GET /api/rules', +SECS, +CONC, (w, i) => call('POST', '/api/rules', { cookie: pick(i).cookie, body: {} })),
  radar: () => phase('GET /api/radar', +SECS, +CONC, (w, i) => call('POST', '/api/radar', { cookie: pick(i).cookie, body: {} })),
  sync: () => phase('POST /api/sync', +SECS, +CONC, (w, i) => call('POST', '/api/sync', { cookie: pick(i).cookie, body: {} })),
  pdf: () => phase('GET invoice pdf', +SECS, +CONC, (w, i) => { const x = pick(i); return x.num ? call('GET', `/api/invoices/${x.num}/pdf`, { cookie: x.cookie }) : call('GET', '/api/me', { cookie: x.cookie }); }),
  login: () => phase('POST /api/login (scrypt)', +SECS, +CONC, (w, i) => call('POST', '/api/login', { body: { email: pick(i).email, password: 'long-enough-pw' } })),
  mixed: () => phase('MIXED (70% read, 15% sync, 10% pdf, 5% login)', +SECS, +CONC, (w, i) => { const x = pick(i), r = (i * 7919) % 100; return r < 35 ? call('GET', '/api/dashboard', { cookie: x.cookie }) : r < 70 ? call('GET', '/api/me', { cookie: x.cookie }) : r < 85 ? call('POST', '/api/sync', { cookie: x.cookie, body: {} }) : r < 95 && x.num ? call('GET', `/api/invoices/${x.num}/pdf`, { cookie: x.cookie }) : call('POST', '/api/login', { body: { email: x.email, password: 'long-enough-pw' } }); }),
};
// Open loop: RATE new users per second, each does a full visit. Arrivals do not wait for earlier visits to finish.
async function arrivals(rate, secs) {
  const flows = [], codes = {}, perCall = []; const end = performance.now() + secs * 1000; let n = 0, running = 0, peak = 0; const all = [];
  const step = async (p, o) => { const r = await call(...p, o); perCall.push(r.ms); codes[r.status || r.err] = (codes[r.status || r.err] ?? 0) + 1; return r; };
  const visit = async (x) => { const t = performance.now(); running++; peak = Math.max(peak, running);
    const l = await step(['POST', '/api/login'], { body: { email: x.email, password: 'long-enough-pw' } }); const ck = (l.headers?.['set-cookie'] ?? [])[0]?.split(';')[0] ?? x.cookie;
    await step(['GET', '/api/me'], { cookie: ck }); await step(['GET', '/api/dashboard'], { cookie: ck }); await step(['POST', '/api/sync'], { cookie: ck, body: {} }); await step(['GET', '/api/dashboard'], { cookie: ck });
    if (x.num) await step(['GET', `/api/invoices/${x.num}/pdf`], { cookie: ck }); running--; flows.push(performance.now() - t); };
  while (performance.now() < end) { const t = performance.now(); all.push(visit(pick(n++))); const wait = 1000 / rate - (performance.now() - t); await new Promise(r => setTimeout(r, Math.max(0, wait))); }
  const t1 = performance.now(); await Promise.all(all); const drain = performance.now() - t1;
  flows.sort((a, b) => a - b); perCall.sort((a, b) => a - b);
  const row = { phase: `ARRIVALS ${rate} users/s (=${rate * 60}/min), full visit each`, visits: n, completed: flows.length, peakConcurrentVisits: peak, visitP50: +pct(flows, .5).toFixed(0), visitP95: +pct(flows, .95).toFixed(0), visitP99: +pct(flows, .99).toFixed(0), callP95: +pct(perCall, .95).toFixed(0), callMax: +perCall[perCall.length - 1].toFixed(0), drainMs: +drain.toFixed(0), codes };
  console.log(JSON.stringify(row)); return row;
}
phases.issue = async () => { const lat = [], codes = {}; const t = performance.now(); await Promise.all(users.map(async (x) => { const r = await call('POST', '/api/sync', { cookie: x.cookie, body: {} }); lat.push(r.ms); codes[r.status] = (codes[r.status] ?? 0) + 1; })); lat.sort((a, b) => a - b); const secs = (performance.now() - t) / 1000;
  const d = await call('GET', '/api/dashboard', { cookie: users[0].cookie }); let n = 0; try { const full = await new Promise(ok => { http.get({ host: u.hostname, port: u.port, path: '/api/dashboard', headers: { cookie: users[0].cookie }, agent }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => ok(b)); }); }); n = JSON.parse(full).shown.invoicesTotal; } catch {}
  const row = { phase: 'FIRST SYNC = invoice generation, all sellers at once', sellers: users.length, invoicesPerSeller: n, totalInvoices: n * users.length, wallSeconds: +secs.toFixed(2), invoicesPerSecond: +(n * users.length / secs).toFixed(1), p50: +pct(lat, .5).toFixed(0), p95: +pct(lat, .95).toFixed(0), max: +lat[lat.length - 1].toFixed(0), codes }; console.log(JSON.stringify(row)); return row; };
phases.arrivals = () => arrivals(+(process.env.RATE ?? 17), +SECS);
const rows = []; for (const k of (only ? only.split(',') : Object.keys(phases).filter(k => k !== 'arrivals'))) rows.push(await phases[k]());
