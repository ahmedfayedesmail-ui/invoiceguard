import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

const PW = 'Long-Enough-Pw-42!';
async function boot() {
  let calls = 0;
  const validate = Object.assign(async (v) => ({ status: 'valid', vat: v }), { fresh: async (v) => { calls++; return { status: 'valid', vat: v }; } });
  const { server, db } = createApp({ validate, secret: 'test' }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => { let sid = ''; return async (path, body, headers = {}) => { const r = await fetch(base + '/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sid, ...headers }, body: JSON.stringify(body ?? {}) }); const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0]; return { status: r.status, body: await r.json().catch(() => null) }; }; };
  return { server, db, client, calls: () => calls };
}
async function seller(call, email) {
  assert.equal((await call('signup', { email, password: PW })).status, 200);
  assert.equal((await call('seller', { name: 'T', nif: 'B12345678', address: 'Calle 1, Madrid', country: 'ES', marketplaces: ['ES'] })).status, 200);
}

test('V3: /api/vat/check is throttled per user (429 after 20 in a window); other users unaffected', async () => {
  const { server, client, calls } = await boot();
  const a = client(), b = client(); await seller(a, 'va@x.es'); await seller(b, 'vb@x.es');
  const codes = []; for (let i = 0; i < 50; i++) codes.push((await a('vat/check', { vat: 'DE811128135' })).status);
  assert.equal(codes.filter(c => c === 200).length, 20); assert.equal(codes.filter(c => c === 429).length, 30);
  assert.equal(codes.indexOf(429), 20);
  assert.equal(calls(), 20, 'throttled calls never reach the VIES validator');
  const r = await a('vat/check', { vat: 'DE811128135' }); assert.equal(r.status, 429);
  assert.equal((await b('vat/check', { vat: 'DE811128135' })).status, 200, 'another user is unaffected');
  server.close();
});

test('V9: security log records the LAST x-forwarded-for entry, not the forgeable first', async () => {
  const { server, db, client } = await boot();
  const a = client(); await a('signup', { email: 'xf@x.es', password: PW }, { 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 203.0.113.9' });
  assert.equal(db.prepare("SELECT ip FROM security_log WHERE type='signup'").get().ip, '203.0.113.9');
  await a('login', { email: 'xf@x.es', password: 'wrong-wrong-1A!' }, { 'x-forwarded-for': '9.9.9.9' });
  assert.equal(db.prepare("SELECT ip FROM security_log WHERE type='login_failed'").get().ip, '9.9.9.9');
  await a('login', { email: 'xf@x.es', password: 'wrong-wrong-2A!' });
  assert.match(db.prepare("SELECT ip FROM security_log WHERE type='login_failed' ORDER BY rowid DESC").get().ip, /127\.0\.0\.1/, 'no header: socket address');
  server.close();
});
