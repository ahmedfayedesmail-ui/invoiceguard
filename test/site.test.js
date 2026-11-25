import test from 'node:test'; import assert from 'node:assert/strict';
import { landing, privacy, contact, faq } from '../src/site.js'; import { createApp } from '../src/app.js';
test('public pages: no scripts, no third-party requests, operator details escaped', () => {
  const env = { OPERATOR_NAME: 'A <b>Co</b>', CONTACT_EMAIL: 'hi@example.com' };
  for (const f of [landing, privacy, contact, faq]) { const h = f(env); assert.ok(!/<script/i.test(h)); assert.ok(!/https?:\/\/(?!www\.w3)/.test(h.replace(/href="mailto:[^"]*"/g, ''))); assert.ok(!h.includes('<b>Co</b>')); }
  assert.match(privacy(env), /hi@example\.com/); assert.match(contact(env), /A &lt;b&gt;Co&lt;\/b&gt;/);
  assert.match(landing({}), /Honest status/); assert.match(privacy({}), /contact page/);
});
test('routes: / privacy contact are public once the operator is set, app moved to /app', async () => {
  process.env.OPERATOR_NAME = 'T'; process.env.CONTACT_EMAIL = 't@example.com';
  const { server } = createApp({ secret: 'test' }); await new Promise(r => server.listen(0, r)); const u = 'http://localhost:' + server.address().port;
  for (const [p, re] of [['/', /Honest status/], ['/privacy', /Privacy notice/], ['/contact', /Contact/], ['/faq', /Frequently asked/], ['/app', /<div id="app"|id="app"/]]) { const r = await fetch(u + p); assert.equal(r.status, 200, p); assert.match(await r.text(), re, p); assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/); }
  server.close();
});
test('robots.txt and sitemap.xml exist when the operator is set, 404 when not', async () => {
  process.env.OPERATOR_NAME = 'T';
  let h = createApp({ secret: 'test' }); await new Promise(r => h.server.listen(0, r)); let u = 'http://localhost:' + h.server.address().port;
  const rob = await fetch(u + '/robots.txt'); assert.equal(rob.status, 200); const rt = await rob.text(); assert.match(rt, /Disallow: \//); assert.match(rt, /Sitemap: /);
  const sm = await fetch(u + '/sitemap.xml'); assert.equal(sm.status, 200); const st = await sm.text(); assert.match(st, /urlset/); for (const p2 of ['/faq', '/sample', '/privacy', '/contact']) assert.ok(st.includes(p2 + '</loc>'), p2);
  h.server.close();
  delete process.env.OPERATOR_NAME;
  h = createApp({ secret: 'test' }); await new Promise(r => h.server.listen(0, r)); u = 'http://localhost:' + h.server.address().port;
  assert.equal((await fetch(u + '/robots.txt')).status, 404); assert.equal((await fetch(u + '/sitemap.xml')).status, 404);
  h.server.close();
});

test('unknown public path gets the branded 404 when the operator is set, JSON otherwise', async () => {
  process.env.OPERATOR_NAME = 'T';
  let h = createApp({ secret: 'test' }); await new Promise(r => h.server.listen(0, r)); let u = 'http://localhost:' + h.server.address().port;
  const r = await fetch(u + '/nope'); assert.equal(r.status, 404); assert.match(await r.text(), /That page does not exist/);
  h.server.close();
  delete process.env.OPERATOR_NAME;
  h = createApp({ secret: 'test' }); await new Promise(r => h.server.listen(0, r)); u = 'http://localhost:' + h.server.address().port;
  const r2 = await fetch(u + '/nope'); assert.equal(r2.status, 404); assert.match(r2.headers.get('content-type'), /json/);
  h.server.close();
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
test('articles: index and article pages render when the operator is set, 404 when not, unknown slug 404', async () => {
  process.env.OPERATOR_NAME = 'T';
  let h = createApp({ secret: 'test' }); await new Promise(r => h.server.listen(0, r)); const u = 'http://localhost:' + h.server.address().port;
  const idx = await fetch(u + '/articles'); assert.equal(idx.status, 200); const it = await idx.text(); assert.match(it, /Plain-language notes/); assert.ok(it.includes('/articles/verifactu-amazon-sellers-october-2028'));
  for (const s of ['verifactu-amazon-sellers-october-2028', 'amazon-credit-notes-rectificativas', 'amazon-business-invoice-not-generated', 'pan-eu-vat-number-on-invoice']) {
    const r = await fetch(u + '/articles/' + s); assert.equal(r.status, 200, s); const t = await r.text();
    assert.match(t, /<h2>/, s); assert.match(t, /not tax or legal advice|not tax advice/i, s); assert.ok(!/<script/i.test(t), s); assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  const a4 = await (await fetch(u + '/articles/verifactu-amazon-sellers-october-2028')).text(); assert.match(a4, /6 October 2028/); assert.match(a4, /BOE-A-2026-24701/);
  assert.equal((await fetch(u + '/articles/nope')).status, 404);
  const sm = await (await fetch(u + '/sitemap.xml')).text(); assert.ok(sm.includes('/articles</loc>')); assert.ok(sm.includes('/articles/pan-eu-vat-number-on-invoice</loc>'));
  h.server.close();
  delete process.env.OPERATOR_NAME;
  h = createApp({ secret: 'test' }); await new Promise(r => h.server.listen(0, r)); const u2 = 'http://localhost:' + h.server.address().port;
  assert.equal((await fetch(u2 + '/articles')).status, 404); assert.equal((await fetch(u2 + '/articles/pan-eu-vat-number-on-invoice')).status, 404);
  h.server.close();
});
test('counters + landing A/B: page views, CTA clicks, signups counted; admin endpoint gated', async () => {
  process.env.OPERATOR_NAME = 'T'; process.env.ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
  const { server } = createApp({ secret: 'test' }); await new Promise(r => server.listen(0, r)); const u = 'http://localhost:' + server.address().port;
  const h = await (await fetch(u + '/')).text();
  assert.ok(/without the hand-made part|one-business-day invoice deadline/.test(h), 'H1 is variant A or B');
  const v = h.includes('one-business-day') ? 'b' : 'a';
  assert.ok(h.includes('/go/sample?v=' + v), 'CTA carries the variant');
  const go = await fetch(u + '/go/sample?v=' + v, { redirect: 'manual' }); assert.equal(go.status, 302); assert.equal(go.headers.get('location'), '/sample');
  await fetch(u + '/faq'); await fetch(u + '/articles');
  assert.equal((await fetch(u + '/go/sample?v=x', { redirect: 'manual' })).headers.get('location'), '/sample'); // bad variant falls back to a
  const noAuth = await fetch(u + '/admin/counters'); assert.equal(noAuth.status, 404);
  const c = await (await fetch(u + '/admin/counters', { headers: { authorization: 'Bearer test-admin-token-0123456789abcdef' } })).json();
  assert.equal(c.counters['pv:/'], 1); assert.equal(c.counters['pv:/:' + v], 1); assert.equal(c.counters['cta:' + v] >= 1, true); assert.equal(c.counters['pv:/faq'], 1); assert.equal(c.counters['pv:/articles'], 1);
  const su = await fetch(u + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ab-test@example.com', password: 'Throwaway-Pass-99!' }) }); assert.equal(su.status, 200);
  const c2 = await (await fetch(u + '/admin/counters', { headers: { authorization: 'Bearer test-admin-token-0123456789abcdef' } })).json();
  assert.equal(c2.counters['signup:total'], 1);
  server.close(); delete process.env.ADMIN_TOKEN;
});
