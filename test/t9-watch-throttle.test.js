import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

const PW = 'Long-Enough-Pw-42!';
async function boot() {
  let calls = 0;
  const validate = Object.assign(async (v) => ({ status: 'valid', vat: v }), { fresh: async (v) => { calls++; return { status: 'valid', vat: v }; } });
  const { server } = createApp({ validate, secret: 'test' }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => { let sid = ''; return async (path, body) => { const r = await fetch(base + '/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: JSON.stringify(body ?? {}) }); const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0]; return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; }; };
  return { server, client, calls: () => calls };
}
async function seller(call, email) {
  assert.equal((await call('signup', { email, password: PW })).status, 200);
  assert.equal((await call('seller', { name: 'T', nif: 'B12345678', address: 'Calle 1, Madrid', country: 'ES', marketplaces: ['ES'] })).status, 200);
}

test('N1: /api/watch/run is throttled per user (429 after 20), throttled calls never reach VIES, others unaffected', async () => {
  const { server, client, calls } = await boot();
  const a = client(), b = client(); await seller(a, 'wa@x.es'); await seller(b, 'wb@x.es');
  assert.equal((await a('watch/add', { vat: 'DE811128135', label: 'x' })).status, 200);
  const codes = []; for (let i = 0; i < 40; i++) codes.push((await a('watch/run')).status);
  assert.equal(codes.filter(c => c === 200).length, 20); assert.equal(codes.indexOf(429), 20);
  assert.equal(calls(), 20, 'throttled runs never reach the VIES validator');
  const r = await a('watch/run'); assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) > 0);
  await b('watch/add', { vat: 'DE811128135', label: 'x' });
  assert.equal((await b('watch/run')).status, 200, 'another user is unaffected');
  server.close();
});

test('N1: watch/run and vat/check share one per-user budget (cannot alternate to double the drain)', async () => {
  const { server, client, calls } = await boot();
  const a = client(); await seller(a, 'wc@x.es');
  await a('watch/add', { vat: 'DE811128135', label: 'x' });
  for (let i = 0; i < 10; i++) { await a('watch/run'); await a('vat/check', { vat: 'DE811128135' }); }
  assert.equal((await a('watch/run')).status, 429); assert.equal((await a('vat/check', { vat: 'DE811128135' })).status, 429);
  assert.equal(calls(), 20);
  server.close();
});
