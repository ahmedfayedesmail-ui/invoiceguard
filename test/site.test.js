import test from 'node:test'; import assert from 'node:assert/strict';
import { landing, privacy, contact } from '../src/site.js'; import { createApp } from '../src/app.js';
test('public pages: no scripts, no third-party requests, operator details escaped', () => {
  const env = { OPERATOR_NAME: 'A <b>Co</b>', CONTACT_EMAIL: 'hi@example.com' };
  for (const f of [landing, privacy, contact]) { const h = f(env); assert.ok(!/<script/i.test(h)); assert.ok(!/https?:\/\/(?!www\.w3)/.test(h.replace(/href="mailto:[^"]*"/g, ''))); assert.ok(!h.includes('<b>Co</b>')); }
  assert.match(privacy(env), /hi@example\.com/); assert.match(contact(env), /A &lt;b&gt;Co&lt;\/b&gt;/);
  assert.match(landing({}), /Honest status/); assert.match(privacy({}), /contact page/);
});
test('routes: / privacy contact are public once the operator is set, app moved to /app', async () => {
  process.env.OPERATOR_NAME = 'T'; process.env.CONTACT_EMAIL = 't@example.com';
  const { server } = createApp({ secret: 'test' }); await new Promise(r => server.listen(0, r)); const u = 'http://localhost:' + server.address().port;
  for (const [p, re] of [['/', /Honest status/], ['/privacy', /Privacy notice/], ['/contact', /Contact/], ['/app', /<div id="app"|id="app"/]]) { const r = await fetch(u + p); assert.equal(r.status, 200, p); assert.match(await r.text(), re, p); assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/); }
  server.close();
});
test('public pages stay off until the operator identity is set', async () => {
  delete process.env.OPERATOR_NAME; delete process.env.CONTACT_EMAIL;
  const { server } = createApp({ secret: 'test' }); await new Promise(r => server.listen(0, r)); const u = 'http://localhost:' + server.address().port;
  const r = await fetch(u + '/', { redirect: 'manual' }); assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/app');
  assert.equal((await fetch(u + '/privacy')).status, 404); assert.equal((await fetch(u + '/contact')).status, 404); assert.equal((await fetch(u + '/app')).status, 200);
  server.close();
});
