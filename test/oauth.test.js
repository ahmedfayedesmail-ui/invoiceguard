import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { isAmazonCallback, oauthConfig } from '../src/oauth.js';
import { decrypt } from '../src/auth.js';

test('only genuine Amazon confirm URLs are accepted as a callback', () => {
  assert.equal(isAmazonCallback('https://amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.X'), true);
  assert.equal(isAmazonCallback('https://sellercentral-europe.amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.X'), true);
  assert.equal(isAmazonCallback('https://sellercentral.amazon.com.be/apps/authorize/confirm/x'), true);
  for (const bad of ['http://amazon.com/apps/authorize/confirm/x', 'https://evil.com/apps/authorize/confirm/x', 'https://amazon.com.evil.com/apps/authorize/confirm/x', 'https://evilamazon.com/apps/authorize/confirm/x', 'https://amazon.com@evil.com/apps/authorize/confirm/x', 'https://amazon.com/other', 'https://amazon.com:8443/apps/authorize/confirm/x', 'javascript:alert(1)', '', 'not a url'])
    assert.equal(isAmazonCallback(bad), false, bad);
});
test('oauth stays off until every setting is present', () => {
  assert.equal(oauthConfig({}).available, false);
  assert.equal(oauthConfig({ SPAPI_APP_ID: 'a', SPAPI_CLIENT_ID: 'b', SPAPI_CLIENT_SECRET: 'c', SPAPI_REDIRECT_URI: 'http://x/y' }).available, false, 'redirect must be https');
  assert.equal(oauthConfig({ SPAPI_APP_ID: 'a', SPAPI_CLIENT_ID: 'b', SPAPI_CLIENT_SECRET: 'c', SPAPI_REDIRECT_URI: 'https://x/y' }).available, true);
});

const ENV = { SPAPI_APP_ID: 'amzn1.sellerapps.app.TEST', SPAPI_CLIENT_ID: 'cid', SPAPI_CLIENT_SECRET: 'csec', SPAPI_REDIRECT_URI: 'https://ig.example/oauth/amazon/redirect' };
async function boot(env = ENV, lwa) {
  const calls = []; const oauthFetch = async (u, o) => { calls.push({ u, body: String(o.body) }); return lwa ? lwa() : { ok: true, json: async () => ({ refresh_token: 'Atzr|REFRESH', access_token: 'a', expires_in: 3600 }) }; };
  const { server, db } = createApp({ validate: async v => ({ status: 'valid', vat: v }), secret: 'test-secret', env, oauthFetch }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) }); const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0]; return { status: r.status, body: await r.json() }; };
  const get = (path, withCookie = true) => fetch(base + path, { redirect: 'manual', headers: withCookie ? { cookie: sid } : {} });
  await call('signup', { email: 'o@x.es', password: 'Correct-Horse-42!' });
  await call('seller', { name: 'S', nif: 'B12345678', address: 'A', marketplaces: ['ES', 'DE'], country: 'ES' });
  return { server, db, call, get, calls };
}

test('website flow: consent URL, single-use state, code exchange, encrypted token stored', async () => {
  const { server, db, call, get, calls } = await boot();
  assert.equal((await call('me')).body.oauth, true);
  assert.equal((await call('amazon/oauth/start', { country: 'FR' })).status, 400, 'a store the seller did not choose');
  const s = await call('amazon/oauth/start', { country: 'ES' }); assert.equal(s.status, 200);
  const u = new URL(s.body.url); assert.equal(u.origin, 'https://sellercentral-europe.amazon.com'); assert.equal(u.pathname, '/apps/authorize/consent');
  assert.equal(u.searchParams.get('application_id'), ENV.SPAPI_APP_ID); const state = u.searchParams.get('state'); assert.equal(state.length, 64);
  assert.match((await get('/oauth/amazon/redirect?state=bogus&spapi_oauth_code=c&selling_partner_id=A1')).status + '', /400/); assert.equal(calls.length, 0, 'unknown state never reaches Amazon');
  const r = await get(`/oauth/amazon/redirect?state=${state}&spapi_oauth_code=CODE1&selling_partner_id=A1SELLER`, false); // Amazon's redirect carries no cookie
  assert.equal(r.status, 200); assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(calls[0].body, /grant_type=authorization_code/); assert.match(calls[0].body, /code=CODE1/); assert.match(calls[0].body, /redirect_uri=https%3A%2F%2Fig.example/);
  const row = db.prepare('SELECT * FROM amazon_conn').get(); assert.equal(row.mode, 'live'); assert.doesNotMatch(row.secret_enc, /REFRESH/);
  const d = decrypt(row.secret_enc, 'test-secret'); assert.equal(d.refreshToken, 'Atzr|REFRESH'); assert.equal(d.sellingPartnerId, 'A1SELLER');
  assert.equal((await get(`/oauth/amazon/redirect?state=${state}&spapi_oauth_code=CODE1`)).status, 400, 'state is single use');
  server.close();
});

test('website flow: failed exchange and denied access connect nothing', async () => {
  const { server, db, call, get } = await boot(ENV, () => ({ ok: false, json: async () => ({ error: 'invalid_grant' }) }));
  const st = new URL((await call('amazon/oauth/start', { country: 'ES' })).body.url).searchParams.get('state');
  assert.equal((await get(`/oauth/amazon/redirect?state=${st}&spapi_oauth_code=X`)).status, 400); assert.equal(db.prepare('SELECT count(*) n FROM amazon_conn').get().n, 0);
  const st2 = new URL((await call('amazon/oauth/start', { country: 'ES' })).body.url).searchParams.get('state');
  assert.equal((await get(`/oauth/amazon/redirect?state=${st2}&error=access_denied`)).status, 400); assert.equal(db.prepare('SELECT count(*) n FROM amazon_conn').get().n, 0);
  server.close();
});

test('Appstore flow: login URI validates the callback, continue needs a signed-in seller, then redirects to Amazon with our state', async () => {
  const { server, get } = await boot();
  const bad = await get('/oauth/amazon/login?amazon_callback_uri=' + encodeURIComponent('https://evil.com/apps/authorize/confirm/x') + '&amazon_state=s', false); assert.equal(bad.status, 400);
  const cb = 'https://sellercentral-europe.amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.TEST';
  const ok = await get('/oauth/amazon/login?amazon_callback_uri=' + encodeURIComponent(cb) + '&amazon_state=AMZSTATE&selling_partner_id=A1', false); assert.equal(ok.status, 200);
  const link = (await ok.text()).match(/href="(\/oauth\/amazon\/continue\?t=[a-f0-9]+)"/)[1];
  const anon = await get(link, false); const at = await anon.text(); assert.match(at, /Sign in first/); assert.match(at, new RegExp('href="/app\\?oauth=' + link.split('t=')[1] + '"'));
  const go = await get(link); assert.equal(go.status, 302);
  const loc = new URL(go.headers.get('location')); assert.equal(loc.origin + loc.pathname, cb);
  assert.equal(loc.searchParams.get('amazon_state'), 'AMZSTATE'); assert.equal(loc.searchParams.get('redirect_uri'), ENV.SPAPI_REDIRECT_URI); assert.equal(loc.searchParams.get('state').length, 64);
  assert.equal((await get(link)).status, 400, 'pending link is single use');
  server.close();
});

test('everything is closed when not configured', async () => {
  const { server, call, get } = await boot({});
  assert.equal((await call('me')).body.oauth, false);
  assert.equal((await call('amazon/oauth/start', { country: 'ES' })).status, 503);
  assert.equal((await get('/oauth/amazon/login?amazon_callback_uri=x&amazon_state=y')).status, 503);
  server.close();
});
