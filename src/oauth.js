// "Connect with Amazon" for a public SP-API app (Login with Amazon, OAuth 2.0).
// Follows Amazon's docs: developer-docs.amazon.com/sp-api/docs/authorize-public-applications and the website and
// Appstore authorization workflow pages. Disabled until the four SPAPI_* variables are set after Amazon approves the app.
//   SPAPI_APP_ID        application id (amzn1.sellerapps.app...)    SPAPI_CLIENT_ID / SPAPI_CLIENT_SECRET   LWA credentials of the app
//   SPAPI_REDIRECT_URI  full https URL of /oauth/amazon/redirect on this site (must be registered with Amazon)
//   SPAPI_BETA=1        authorize the app while it is still a Draft
import { randomBytes } from 'node:crypto';
import { encrypt } from './auth.js';
import { logEvent } from './db.js';

// Seller Central host per EU country, from Amazon's "Seller Central URLs" page.
export const SELLER_CENTRAL = { ES: 'https://sellercentral-europe.amazon.com', FR: 'https://sellercentral-europe.amazon.com', DE: 'https://sellercentral-europe.amazon.com', IT: 'https://sellercentral-europe.amazon.com', GB: 'https://sellercentral-europe.amazon.com',
  IE: 'https://sellercentral.amazon.ie', BE: 'https://sellercentral.amazon.com.be', NL: 'https://sellercentral.amazon.nl', SE: 'https://sellercentral.amazon.se', PL: 'https://sellercentral.amazon.pl' };
export const STATE_TTL = 10 * 60e3;

export const oauthConfig = (env = process.env) => {
  const c = { appId: env.SPAPI_APP_ID, clientId: env.SPAPI_CLIENT_ID, clientSecret: env.SPAPI_CLIENT_SECRET, redirectUri: env.SPAPI_REDIRECT_URI, beta: env.SPAPI_BETA === '1' };
  let ok = !!(c.appId && c.clientId && c.clientSecret && c.redirectUri);
  if (ok) { try { ok = new URL(c.redirectUri).protocol === 'https:'; } catch { ok = false; } }
  return { ...c, available: ok };
};

/** Where Amazon may send the seller back to. Anything else is refused, so the login URI can never be used as an open redirect. */
export function isAmazonCallback(u) {
  let x; try { x = new URL(u); } catch { return false; }
  return x.protocol === 'https:' && !x.username && !x.password && !x.port && /(^|\.)amazon\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2,3})$/.test(x.hostname) && x.pathname.startsWith('/apps/authorize/confirm/');
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} - InvoiceGuard</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#f6f8f8;color:#1c2b2b;margin:0}main{max-width:480px;margin:60px auto;background:#fff;border:1px solid #dde5e5;border-radius:12px;padding:28px}h1{font-size:22px;margin:0 0 12px}a.btn{display:inline-block;background:#0f766e;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:12px}p{color:#4a5b5b}</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;

export function migrateOauth(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_state (token TEXT PRIMARY KEY, user_id TEXT, seller_id TEXT, beta INTEGER, expires_at INTEGER);
  CREATE TABLE IF NOT EXISTS oauth_pending (token TEXT PRIMARY KEY, callback TEXT, amazon_state TEXT, beta INTEGER, expires_at INTEGER);`);
}

export function oauthRoutes({ db, secret, env = process.env, fetchImpl = fetch, userOf, sellerOf, forgetApi = () => {} }) {
  migrateOauth(db);
  const tok = () => randomBytes(32).toString('hex'), now = () => Date.now();
  const sweep = () => { db.prepare('DELETE FROM oauth_state WHERE expires_at < ?').run(now()); db.prepare('DELETE FROM oauth_pending WHERE expires_at < ?').run(now()); };
  const cfg = () => { const c = oauthConfig(env); return secret === 'dev-secret-change-me' ? { ...c, available: false } : c; };
  const html = (res, code, title, body, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", ...headers }); res.end(page(title, body)); };
  const fail = (res, msg) => html(res, 400, 'Connection not completed', `<p>${esc(msg)}</p><a class="btn" href="/app">Back to InvoiceGuard</a>`);

  /** Seller presses "Connect with Amazon" inside the app. Returns the Amazon consent URL. */
  function start(user, seller, body) {
    const c = cfg(); if (!c.available) return { code: 503, body: { error: 'Connecting with Amazon is not open yet. It opens after Amazon approves our application.' } };
    const cc = String(body.country ?? '').toUpperCase(), mk = JSON.parse(seller.marketplace_ids ?? '[]');
    if (!SELLER_CENTRAL[cc] || !mk.includes(cc)) return { code: 400, body: { error: 'Choose one of your Amazon stores' } };
    sweep(); const t = tok();
    db.prepare('INSERT INTO oauth_state VALUES (?,?,?,?,?)').run(t, user.id, seller.id, c.beta ? 1 : 0, now() + STATE_TTL);
    const u = new URL(SELLER_CENTRAL[cc] + '/apps/authorize/consent'); u.searchParams.set('application_id', c.appId); u.searchParams.set('state', t); if (c.beta) u.searchParams.set('version', 'beta');
    return { code: 200, body: { url: u.toString() } };
  }

  /** GET routes. Returns true when handled. */
  async function handle(req, res, url, p) {
    if (req.method !== 'GET' || !p.startsWith('/oauth/amazon/')) return false;
    const c = cfg(); sweep();
    if (!c.available) { html(res, 503, 'Not open yet', '<p>Connecting with Amazon opens after Amazon approves our application.</p>'); return true; }
    const q = (k) => String(url.searchParams.get(k) ?? '').slice(0, 2048);
    if (p === '/oauth/amazon/redirect') { // Amazon sends the seller here with an authorization code
      const st = db.prepare('SELECT * FROM oauth_state WHERE token=?').get(q('state')); if (st) db.prepare('DELETE FROM oauth_state WHERE token=?').run(st.token); // single use
      if (!st || st.expires_at < now()) { fail(res, 'This link expired or was already used. Please start again from InvoiceGuard.'); return true; }
      if (q('error') || !q('spapi_oauth_code')) { fail(res, 'Amazon did not grant access. Nothing was connected.'); return true; }
      // Real-data gate (critic round-8): the callback is a write path too - it must not persist a
      // live connection while the pilot is sample-only, even with a valid Amazon code.
      if (env.ALLOW_LIVE_CONNECT !== '1') { fail(res, 'A direct Amazon connection is not open yet - the pilot runs on sample data only. Nothing was connected.'); return true; }
      let j; try { const r = await fetchImpl('https://api.amazon.com/auth/o2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: q('spapi_oauth_code'), redirect_uri: c.redirectUri, client_id: c.clientId, client_secret: c.clientSecret }) }); j = await r.json(); if (!r.ok || !j.refresh_token) j = null; } catch { j = null; }
      if (!j) { fail(res, 'Amazon did not accept the code. It may have expired (codes last five minutes). Please start again.'); return true; }
      const enc = encrypt({ clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: j.refresh_token, region: 'EU', sellingPartnerId: q('selling_partner_id') || null }, secret);
      db.prepare("INSERT INTO amazon_conn (seller_id,mode,secret_enc,connected_at) VALUES (?,?,?,?) ON CONFLICT(seller_id) DO UPDATE SET mode=excluded.mode, secret_enc=excluded.secret_enc, connected_at=excluded.connected_at").run(st.seller_id, 'live', enc, new Date().toISOString());
      forgetApi(st.seller_id); logEvent(db, st.seller_id, 'amazon_connected', { mode: 'live', via: 'oauth' });
      html(res, 200, 'Amazon connected', '<p>Your Amazon account is connected. Amazon asks you to renew this permission once a year and will email you a reminder first.</p><a class="btn" href="/app">Open InvoiceGuard</a>'); return true;
    }
    if (p === '/oauth/amazon/login') { // Amazon Appstore sends the seller here first
      // Real-data gate (critic round-9): do not even START the auth flow while the feature is
      // closed - no pending row, no consent page.
      if (env.ALLOW_LIVE_CONNECT !== '1') { fail(res, 'A direct Amazon connection is not open yet - the pilot runs on sample data only. Nothing was started.'); return true; }
      const cb = q('amazon_callback_uri'), as = q('amazon_state');
      if (!isAmazonCallback(cb) || !as) { fail(res, 'This request did not come from Amazon in the expected form, so we stopped.'); return true; }
      const t = tok(); db.prepare('INSERT INTO oauth_pending VALUES (?,?,?,?,?)').run(t, cb, as, q('version') === 'beta' ? 1 : 0, now() + STATE_TTL);
      html(res, 200, 'Connect your Amazon account', `<p>Continue to give InvoiceGuard permission to read your VAT invoice data and upload invoices for your Amazon store. You can take this permission back in Seller Central at any time.</p><a class="btn" href="/oauth/amazon/continue?t=${t}">Continue</a>`); return true;
    }
    if (p === '/oauth/amazon/continue') {
      if (env.ALLOW_LIVE_CONNECT !== '1') { fail(res, 'A direct Amazon connection is not open yet - the pilot runs on sample data only. Nothing was started.'); return true; }
      const pend = db.prepare('SELECT * FROM oauth_pending WHERE token=?').get(q('t')); if (!pend || pend.expires_at < now()) { fail(res, 'This link expired. Please start again from Amazon.'); return true; }
      const user = userOf(req), seller = user && sellerOf(user);
      if (!user) { html(res, 200, 'Sign in first', `<p>Sign in or create your InvoiceGuard account. You will be sent straight back to finish connecting Amazon.</p><a class="btn" href="/app?oauth=${pend.token}">Sign in</a>`); return true; }
      if (!seller) { fail(res, 'Finish your seller details in InvoiceGuard first, then start again from Amazon.'); return true; }
      db.prepare('DELETE FROM oauth_pending WHERE token=?').run(pend.token);
      const t = tok(); db.prepare('INSERT INTO oauth_state VALUES (?,?,?,?,?)').run(t, user.id, seller.id, pend.beta, now() + STATE_TTL);
      const u = new URL(pend.callback); u.searchParams.set('redirect_uri', c.redirectUri); u.searchParams.set('amazon_state', pend.amazon_state); u.searchParams.set('state', t); if (pend.beta) u.searchParams.set('version', 'beta');
      res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' }); res.end(); return true;
    }
    return false;
  }
  return { start, handle, available: () => cfg().available };
}
