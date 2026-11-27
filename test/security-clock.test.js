// Injected-clock proof for the one-off sign-in failure (expected 401, got 200). Local. Synthetic data only.
// Cause under test: the old test read the clock fresh for every code. When a 30 s step boundary fell between "enable" and "login", the login computed a NEW step's code, which is a legitimate fresh code (200), not a replay.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { totpAt } from '../src/security.js';

const STEP = 30000, T0 = Math.floor(Date.UTC(2026, 10, 27, 12, 0, 0) / STEP) * STEP; // an exact step start
async function boot(email) {
  const { server } = createApp({ validate: async v => ({ status: 'valid', vat: v }), secret: 'test-secret' }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) }); const sc = r.headers.get('set-cookie'); if (sc) sid = sc.split(';')[0]; return { status: r.status, body: await r.json() }; };
  const pw = 'Correct-Horse-42!'; await call('signup', { email, password: pw });
  return { server, call, pw, clear: () => { sid = ''; } };
}
const step = () => Math.floor(Date.now() / STEP);
async function enable(h) { const su = await h.call('mfa/setup', {}); const code = totpAt(su.body.secret, step()); assert.equal((await h.call('mfa/enable', { code })).status, 200); h.clear(); return { secret: su.body.secret, code }; }

test('same code used twice inside one step: rejected, clock frozen mid-step (deterministic)', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 + 10000 });
  const h = await boot('c1@x.es');
  try {
    const { secret, code } = await enable(h);
    assert.equal((await h.call('login', { email: 'c1@x.es', password: h.pw, code })).status, 401, 'the code that enabled two-step is spent');
    assert.equal((await h.call('login', { email: 'c1@x.es', password: h.pw, code: totpAt(secret, step() + 1) })).status, 200, 'the next step code is fresh');
  } finally { h.server.close(); mock.timers.reset(); }
});
test('a step boundary between enable and login: the NEW step code is accepted (this was the one-off 200), the OLD one stays refused', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 + 29900 });
  const h = await boot('c2@x.es');
  try {
    const { secret, code } = await enable(h); const s0 = step();
    mock.timers.setTime(T0 + 30100); assert.equal(step(), s0 + 1, 'boundary crossed');
    assert.equal((await h.call('login', { email: 'c2@x.es', password: h.pw, code })).status, 401, 'old step code is still a replay after the boundary');
    assert.equal((await h.call('login', { email: 'c2@x.es', password: h.pw, code: totpAt(secret, step()) })).status, 200, 'the new step code is a legitimate fresh code');
  } finally { h.server.close(); mock.timers.reset(); }
});
