import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

const validate = async (v) => v === 'ESA1234567' ? { status: 'invalid', reason: 'bad_format', vat: v } : { status: 'valid', vat: v };
async function setup() {
  const { server } = createApp({ validate, secret: 'test' }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) });
    const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0]; return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }; };
  return { server, call, base };
}

test('full seller journey on simulated Amazon', async () => {
  const { server, call, base } = await setup();
  assert.equal((await call('dashboard')).status, 401);
  assert.equal((await call('signup', { email: 'a@b.es', password: 'short' })).status, 400);
  assert.equal((await call('signup', { email: 'a@b.es', password: 'Long-Enough-Pw-42!' })).status, 200);
  assert.equal((await call('signup', { email: 'a@b.es', password: 'Long-Enough-Pw-42!' })).status, 409);
  assert.equal((await call('dashboard')).status, 409, 'needs seller profile');
  await call('seller', { name: 'Tienda Demo S.L.', nif: 'b11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES', 'DE'] });
  assert.equal((await call('amazon/connect', { demo: true })).body.mode, 'demo');
  const s = (await call('sync', {})).body; assert.equal(s.uploaded, 2); assert.equal(s.held.length, 1);
  const d = (await call('dashboard')).body;
  assert.equal(d.kpis.total, 3); assert.equal(d.kpis.held, 1); assert.equal(d.kpis.uploaded, 2); assert.equal(d.kpis.estDefectPct, 33.3);
  const pdf = await call(`invoices/${d.invoices.at(-1).number}/pdf`); assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
  const num = d.invoices.find(i => i.total === 54.45).number;
  const r = await call('rectify', { number: num, mode: 'substitution', reason: 'Wrong buyer name', buyerName: 'New Name S.L.' }); assert.equal(r.status, 200); assert.match(r.body.number, /^R-/);
  assert.equal((await call('rectify', { number: num, mode: 'substitution', reason: 'x', buyerVat: 'ESA1234567' })).status, 422);
  assert.equal((await call('sync', {})).body.uploaded, 0, 'second sync does not duplicate');
  assert.equal((await call('vat/check', { vat: 'DE811128135' })).body.status, 'valid');
  const html = await (await fetch(base + '/')).text(); assert.match(html, /InvoiceGuard/);
  assert.equal((await fetch(base + '/api/me', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  server.close();
});

test('login rejects wrong password; sessions are per user', async () => {
  const { server, call } = await setup();
  await call('signup', { email: 'x@y.es', password: 'Long-Enough-Pw-42!' });
  const other = await setup(); assert.equal((await other.call('login', { email: 'x@y.es', password: 'whatever-long' })).status, 401);
  assert.equal((await call('login', { email: 'x@y.es', password: 'wrong-password' })).status, 401);
  server.close(); other.server.close();
});

test('dashboard script has valid syntax', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs'); const { execFileSync } = await import('node:child_process');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'); const js = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  writeFileSync('/tmp/_ui_check.js', js); execFileSync('node', ['--check', '/tmp/_ui_check.js']);
});

test('audit verify and csv export', async () => {
  const { server, call } = await setup();
  await call('signup', { email: 'c@d.es', password: 'Long-Enough-Pw-42!' });
  await call('seller', { name: 'T S.L.', nif: 'b11111111', address: 'Calle 1', marketplaces: ['ES'] });
  await call('amazon/connect', { demo: true }); await call('sync', {});
  const a = (await call('audit/verify')).body; assert.equal(a.ok, true); assert.ok(a.entries >= 1);
  const c = await call('export.csv'); assert.equal(c.status, 200); assert.match(c.body.toString(), /^number,type,rectifies/);
  server.close();
});

test('invoice language setting applies to new invoices', async () => {
  const { server, call } = await setup();
  await call('signup', { email: 'e@f.es', password: 'Long-Enough-Pw-42!' });
  await call('seller', { name: 'T S.L.', nif: 'b11111111', address: 'Calle 1', marketplaces: ['ES'] });
  await call('amazon/connect', { demo: true });
  assert.equal((await call('settings', { invoiceLang: 'xx' })).status, 400);
  assert.equal((await call('settings', { invoiceLang: 'both' })).status, 200);
  await call('sync', {}); const d = (await call('dashboard')).body; assert.equal(d.seller.invoiceLang, 'both');
  const pdf = await call(`invoices/${d.invoices[0].number}/pdf`); assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
  server.close();
});

test('rectify API: amount differences, address, seller details, and validation', async () => {
  const { server, call } = await setup();
  await call('signup', { email: 'g@h.es', password: 'Long-Enough-Pw-42!' });
  await call('seller', { name: 'T S.L.', nif: 'b11111111', address: 'Calle 1', marketplaces: ['ES'] });
  await call('amazon/connect', { demo: true }); await call('sync', {});
  const d = (await call('dashboard')).body; const inv = d.invoices.find(i => i.total === 54.45).number;
  assert.equal((await call('rectify', { number: inv, mode: 'substitution', reason: 'x' })).status, 400, 'nothing changed');
  assert.equal((await call('rectify', { number: inv, mode: 'differences', reason: 'x', buyerName: 'Only Name' })).status, 400, 'differences needs amounts');
  assert.equal((await call('rectify', { number: inv, mode: 'differences', reason: 'Partial return', lines: [{ index: 0, qty: 1 }] })).status, 200);
  assert.equal((await call('rectify', { number: inv, mode: 'substitution', reason: 'Address', buyerAddress: 'Nueva 1\n46002 Valencia' })).status, 200);
  assert.equal((await call('rectify', { number: inv, mode: 'substitution', reason: 'Seller', sellerName: 'Nuevo Nombre S.L.' })).status, 200);
  const j = (await call(`invoices/${inv}/json`)).body; assert.equal(j.seller.nif, 'B11111111');
  const rs = (await call('dashboard')).body.invoices.filter(i => i.kind === 'rectificativa'); assert.equal(rs.length, 3); assert.ok(rs.some(r => r.total === -24.2));
  server.close();
});

test('security: cross-site POST blocked, same-site allowed, headers and Secure cookie', async () => {
  const { server, base } = await setup();
  const post = (headers) => fetch(base + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ email: 'sec' + Math.random() + '@x.es', password: 'Long-Enough-Pw-42!' }) });
  const bad = await post({ origin: 'https://evil.example' });
  assert.equal(bad.status, 403);
  const good = await post({ origin: base });
  assert.equal(good.status, 200);
  assert.ok(!/Secure/.test(good.headers.get('set-cookie')), 'plain http: no Secure flag');
  assert.equal(good.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(good.headers.get('x-frame-options'), 'DENY');
  const https = await post({ 'x-forwarded-proto': 'https' });
  assert.match(https.headers.get('set-cookie'), /; Secure/);
  server.close();
});

test('limits: oversize body gets a clear 413, bad JSON a 400, internal errors do not leak', async () => {
  const { server, base } = await setup();
  const big = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.es', password: 'x'.repeat(100000) }) });
  assert.equal(big.status, 413); assert.match((await big.json()).error, /too large/);
  const bad = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  server.close();
});

test('a JSON null or array body is a 400, never a crash', async () => {
  const { server, base } = await setup();
  for (const b of ['null', '[]', '5', '"x"']) assert.equal((await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: b })).status, 400);
  server.close();
});

test('login throttle also counts per account across different IPs', async () => {
  const { server, base } = await setup();
  await fetch(base + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'acct@x.es', password: 'Long-Enough-Pw-42!' }) });
  let last = 0;
  for (let i = 0; i < 11; i++) { last = (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.' + i }, body: JSON.stringify({ email: 'acct@x.es', password: 'wrong-' + i }) })).status; }
  assert.equal(last, 429);
  server.close();
});

test('release and retry without a shipment key are a clear 400', async () => {
  const { server, call } = await setup();
  await call('signup', { email: 'k@x.es', password: 'Long-Enough-Pw-42!' });
  await call('seller', { name: 'K', nif: 'B12345678', address: 'Calle 1, Madrid', country: 'ES', marketplaces: ['ES'] });
  for (const p of ['release', 'retry']) for (const b of [{}, { key: 5 }, { key: {} }]) assert.equal((await call(p, b)).status, 400);
  server.close();
});

test('referral capture: auth, validation, dedupe, cap', async () => {
  const { server, call } = await setup();
  assert.equal((await call('referrals', { email: 'x@y.es' })).status, 401);
  await call('signup', { email: 'r@b.es', password: 'Long-Enough-Pw-42!' });
  assert.equal((await call('referrals', { email: 'not-an-email' })).status, 400);
  assert.equal((await call('referrals', { email: 'r@b.es' })).status, 400, 'own email');
  assert.equal((await call('referrals', { email: ' Friend@Example.com ' })).status, 200);
  assert.equal((await call('referrals', { email: 'friend@example.com' })).status, 409, 'duplicate');
  assert.equal((await call('referrals', { email: 'two@example.com' })).status, 200);
  assert.equal((await call('me')).body.features.referrals, false, 'flag off by default');
  server.close();
});
