// Open-loop: RATE new visitors per second for SECS seconds. Each: signup, profile, connect demo, sync, dashboard, invoice PDF (6 calls).
const [base, RATE='17', SECS='15'] = process.argv.slice(2);
const lat = [], errs = {}; let done = 0, started = 0;
const J = (cookie, b) => ({ method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(b ?? {}) });
async function visit(n) {
  const t0 = performance.now();
  try {
    let r = await fetch(base + '/api/signup', J('', { email: `v${n}-${Math.random().toString(36).slice(2)}@x.es`, password: 'long-enough-pw' }));
    if (r.status !== 200) throw new Error('signup ' + r.status);
    const ck = r.headers.get('set-cookie').split(';')[0];
    const steps = [['/api/seller', { name: 'Visit Seller', nif: 'B12345678', address: 'Calle 1, Madrid', country: 'ES', marketplaces: ['ES', 'DE'] }], ['/api/amazon/connect', { demo: true }], ['/api/sync', {}]];
    for (const [p, b] of steps) { r = await fetch(base + p, J(ck, b)); await r.arrayBuffer(); if (r.status !== 200) throw new Error(p + ' ' + r.status); }
    r = await fetch(base + '/api/dashboard', { headers: { cookie: ck } }); const d = await r.json(); if (r.status !== 200) throw new Error('dash ' + r.status);
    const num = d.invoices?.[0]?.number; if (num) { r = await fetch(base + '/api/invoices/' + encodeURIComponent(num) + '/pdf', { headers: { cookie: ck } }); await r.arrayBuffer(); if (r.status !== 200) throw new Error('pdf ' + r.status); }
    lat.push(performance.now() - t0);
  } catch (e) { errs[e.message] = (errs[e.message] || 0) + 1; }
  done++;
}
const end = Date.now() + SECS * 1000; const ps = [];
while (Date.now() < end) { ps.push(visit(started++)); await new Promise(r => setTimeout(r, 1000 / RATE)); }
await Promise.all(ps); lat.sort((a, b) => a - b); const pc = q => lat[Math.floor(q * (lat.length - 1))]?.toFixed(0);
console.log(JSON.stringify({ visitsPerMin: Math.round(RATE * 60), started, completed: lat.length, errors: errs, p50ms: pc(.5), p95ms: pc(.95), p99ms: pc(.99) }));
