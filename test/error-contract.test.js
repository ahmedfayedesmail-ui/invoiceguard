// Error contract (swarm-error-handling): no driver/runtime/Amazon text reaches a client, malformed input is a 4xx, never a 500.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { explain } from '../src/pipeline.js';
import { publicError, isInternalError, INTERNAL_MESSAGE } from '../src/errors.js';

const validate = async (v) => ({ status: 'valid', vat: v });
async function setup(env = {}) {
  const { server, db } = createApp({ validate, secret: 'test', env: { ...process.env, ...env } }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body, raw) => { const r = await fetch(base + path, { method: body === undefined && raw === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* html */ } return { status: r.status, body: j, text: t }; };
  const login = async () => { await call('/api/signup', { email: 'e@b.es', password: 'Long-Enough-Pw-42!' }); await call('/api/seller', { name: 'T S.L.', nif: 'b11111111', address: 'Calle 1', marketplaces: ['ES'] }); };
  return { server, db, call, login };
}
const quiet = async (f) => { const o = console.error; console.error = () => {}; try { return await f(); } finally { console.error = o; } };

test('malformed percent-encoding in /articles is a 404, not a 500', async () => {
  const { server, call } = await setup({ OPERATOR_NAME: 'Test Operator' }); process.env.OPERATOR_NAME = 'Test Operator';
  try { for (const u of ['/articles/%E0%A4%A', '/articles/%ZZ']) { const r = await call(u); assert.equal(r.status, 404, u); } } finally { delete process.env.OPERATOR_NAME; server.close(); }
});

test('bad bodies get a readable 400/415, not terse internal words', async () => {
  const { server, call } = await setup();
  try {
    const a = await call('/api/signup', undefined, '{bad'); assert.equal(a.status, 400); assert.match(a.body.error, /not valid JSON/);
    const r = await fetch(server.address() && `http://127.0.0.1:${server.address().port}/api/me`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(r.status, 415); assert.match((await r.json()).error, /sent as JSON/);
  } finally { server.close(); }
});

test('a driver error never reaches the client: non-string key is a 400; internal errors are a generic 500', async () => {
  const { server, call, login } = await setup(); await login();
  try {
    const r = await call('/api/repairs/authorize-retry', { key: {} });
    assert.equal(r.status, 400); assert.doesNotMatch(r.text, /SQLite|bound|parameter/i);
    const w = await call('/api/wizard', { country: 'ES', marketplaces: 5 }); assert.equal(w.status, 400);
  } finally { server.close(); }
});

test('sync without a connection is a 409 with a seller-readable message', async () => {
  const { server, call, login } = await setup(); await login();
  try { const r = await call('/api/sync', {}); assert.equal(r.status, 409); assert.match(r.body.error, /Connect your account or upload an order report/); } finally { server.close(); }
});

test('publicError classifies seller messages, driver errors and Amazon errors', () => {
  assert.deepEqual(publicError(new Error('Enter a valid date'), 422), { status: 422, message: 'Enter a valid date', log: false });
  const sqlite = Object.assign(new Error('UNIQUE constraint failed: invoices.number'), { code: 'ERR_SQLITE_ERROR', errcode: 2067 });
  assert.equal(isInternalError(sqlite), true);
  const pe = publicError(sqlite, 422); assert.equal(pe.status, 500); assert.equal(pe.message, INTERNAL_MESSAGE); assert.equal(pe.log, true);
  assert.equal(publicError(new TypeError('x.map is not a function')).status, 500);
  const up = publicError(new Error('SP-API POST /feeds/2021-06-30/feeds -> 400 {"errors":[{"code":"InvalidInput","message":"secret-ish id 123"}]}'));
  assert.equal(up.status, 502); assert.doesNotMatch(up.message, /feeds|InvalidInput|123/); assert.match(up.message, /HTTP 400/);
  assert.equal(publicError(Object.assign(new Error('Too busy'), { status: 409 }), 422).status, 409);
});

test('explain: "403" only as a whole number, and Amazon error bodies are not shown to sellers', () => {
  assert.match(explain('SP-API POST /feeds -> 403 {}'), /Tax Invoicing role/);
  assert.doesNotMatch(explain('SP-API POST /feeds -> 500 {"errors":[{"message":"request id 14031122"}]}'), /Tax Invoicing role/);
  const raw = explain('SP-API POST /feeds/2021-06-30/feeds -> 400 {"errors":[{"code":"InvalidInput"}]}');
  assert.doesNotMatch(raw, /feeds|InvalidInput|\{/); assert.match(raw, /HTTP 400/);
  assert.match(explain('SP-API ... FeatureNotAvailable 79509'), /I will upload my own VAT invoices/);
  assert.equal(explain('A plain seller message'), 'A plain seller message');
});
