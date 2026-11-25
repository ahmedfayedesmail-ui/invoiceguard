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
test('contact form: stored on our server, honeypot, validation, rate limit, admin read needs the token', async () => {
  process.env.OPERATOR_NAME = 'T'; delete process.env.CONTACT_EMAIL; process.env.ADMIN_TOKEN = 'x'.repeat(32);
  const { server } = createApp({ secret: 'test' }); await new Promise(r => server.listen(0, r)); const u = 'http://localhost:' + server.address().port;
  const html = await (await fetch(u + '/contact')).text(); assert.match(html, /<form method="post" action="\/contact">/); assert.doesNotMatch(html, /mailto:/);
  const post = (body) => fetch(u + '/contact', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  let r = await post('message=' + encodeURIComponent('Hello, I am a seller <b>x</b>') + '&email=s%40example.com&website='); assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/contact?sent=1');
  r = await post('message=bot+message+here&website=http%3A%2F%2Fspam'); assert.equal(r.headers.get('location'), '/contact?sent=1');
  r = await post('message=hi'); assert.equal(r.headers.get('location'), '/contact?err=1');
  r = await post('message=valid+message&email=notanemail'); assert.equal(r.headers.get('location'), '/contact?err=1');
  assert.match(await (await fetch(u + '/contact?sent=1')).text(), /Thank you/);
  assert.equal((await fetch(u + '/admin/messages')).status, 404); assert.equal((await fetch(u + '/admin/messages', { headers: { authorization: 'Bearer wrong' } })).status, 404);
  const a = await (await fetch(u + '/admin/messages', { headers: { authorization: 'Bearer ' + 'x'.repeat(32) } })).json();
  assert.equal(a.messages.length, 1); assert.match(a.messages[0].message, /seller/);
  await post('message=second+message'); await post('message=third+message'); r = await post('message=fourth+message'); assert.equal(r.headers.get('location'), '/contact?err=2');
  r = await fetch(u + '/contact', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' }); assert.equal(r.status, 403);
  server.close(); delete process.env.OPERATOR_NAME; delete process.env.ADMIN_TOKEN;
});
