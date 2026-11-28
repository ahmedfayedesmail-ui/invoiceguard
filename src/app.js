import { logSec, migrateSecLog, purgeSecLog, rotateKeys, passwordProblem, migrateSecurity, newRecoveryCodes, recoveryLeft, recoveryValid, recoveryConsume, totpMatch, newTotpSecret, otpauthUrl, purgeBuyerData, PW_HISTORY, PW_MAX_AGE_DAYS } from './security.js';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { applyEdits } from './invoice.js';
import { applyPendingRestore } from './restore.js';
import { openDb, migrateAuth, logEvent, verifyAudit, newRefCode, currentAttemptSeq, nextReportGen } from './db.js';
import { landing, privacy, contact, sample, faq, notFound, countryFromLang } from './site.js';
import { landingLocalized } from './landing-i18n.js';
import { ARTICLES, articlesIndex, articlePage } from './articles.js';
import { sampleRun, samplePdf, sampleRepair } from './sample.js';
import { applyBootReset } from './reset.js';
import { planUpload } from './manual.js';
import { makeZip } from './zip.js';
import { oauthRoutes } from './oauth.js';
import { hashPwAsync, checkPwAsync, hashQueueStats, Busy, encrypt, decrypt, newToken } from './auth.js';
import { cachedValidator } from './viescache.js';
import { SpApi, MARKETPLACE, marketplaceFor } from './spapi.js';
import { MockApi } from './mockamazon.js';
import { addOverride } from './verify.js';
import { SETTINGS, LANGS } from './lang.js';
import { allRuleStates, checkSources, reviewRule, legalDeadline, cleanProfile, sellerProfile } from './rules.js';
import { upsertShipment, processReport, pollFeeds, issueRectificativa, processCorrections, settleUnknownDocuments } from './pipeline.js';
import { pairHoldOpen } from './cn-gate.js';
import { authorizeUnknownRetry, detectRepairs, listRepairs, decideRepair, approveRepair, recoverStuckRepairs, recoverUncertainUploads, ensureRepairTables, recordReportSnapshot, latestReportSnapshot, markReportInFlight, clearReportInFlight, reconcileReportMarksAtBoot, markReportStorePending, storeDownloadedReport, beginManualVidr, finishManualVidr } from './repair.js';
import { validateVat } from './vies.js';
import { renderPdfCached as renderPdf } from './pdf.js';
import * as F from './features.js';
import { PACKS } from './rules.js';
import { listHolds, decideHold, addHoldNote } from './holds.js';
import { openIntelReader, sealSellerEvidence, verifyEvidenceChain, getEvidenceCoverage, buildDocumentTimeline, exportEvidenceBundle } from './intel/store.js';

const INDEX = readFileSync(new URL('../public/index.html', import.meta.url));
const FAVICON = readFileSync(new URL('../public/favicon.svg', import.meta.url));
const SAMPLE_JS = readFileSync(new URL('../public/sample.js', import.meta.url));
const LOCAL_HTML = readFileSync(new URL('../public/local/index.html', import.meta.url)), LOCAL_PAGE = readFileSync(new URL('../public/local/page.js', import.meta.url)), LOCAL_ENGINE = readFileSync(new URL('../public/local/engine.js', import.meta.url));
// Problem loop page: built in the repository, OFF unless ENABLE_LOOP_PAGE=1 (no public deployment of it without a decision).
const LOOP_FILES = { '/local/loop': ['loop.html', 'text/html; charset=utf-8'], '/local/loop.js': ['loop.js', 'text/javascript; charset=utf-8'], '/local/loop-engine.js': ['loop-engine.js', 'text/javascript; charset=utf-8'] };
const loopFile = (name) => readFileSync(new URL('../public/local/' + name, import.meta.url));
// connect-src 'none' + form-action 'none': the browser itself refuses fetch, XHR, beacons, WebSockets and form posts from the local page. frame-src blob: only shows the PDF the page made.
const LOCAL_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'none'; form-action 'none'; frame-src blob:; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";
const PACK_HOWTO = `HOW TO SEND THESE INVOICES TO AMAZON
InvoiceGuard does not connect to Amazon on this route. You upload the files yourself.

1. Open Seller Central and go to Orders, then Manage Orders.
2. Find the order (the order number is the first part of each PDF file name and is listed in manifest.csv).
3. Open the order and choose "Upload invoice". Pick the PDF and type the invoice number from manifest.csv.
   Menu names can differ by account. If you cannot find the option, look under the Orders menu for an invoice upload page, or ask Seller Support. Tell us what you see and we will update this guide.
4. When you have uploaded them, go back to InvoiceGuard and press "I uploaded these".

Check each total against the order in Seller Central before you upload. InvoiceGuard does not give tax or legal advice.
`;
const apis = new Map(); // seller_id -> api instance (mock keeps state)

export function createApp({ db = openDb(), secret = process.env.APP_SECRET ?? 'dev-secret-change-me', validate = cachedValidator(validateVat), env = process.env, oauthFetch = fetch } = {}) {
  migrateAuth(db); migrateSecurity(db); migrateSecLog(db); ensureRepairTables(db); // round-22: the pack/mark/reject routes touch the repairs table directly, so it must exist from boot, not only after the first manual upload
  const mainDbPath = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file ?? ''; // evidence sealing requires a persistent database and a separate read-only connection
  const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT ?? 400); let inflight = 0;
  const fails = new Map(); // login throttle: key -> { n, until }
  const FAIL_MAX = 8, FAIL_WINDOW = 15 * 60e3;
  const failKey = (req, email) => `${req.socket.remoteAddress}|${email}`;
  const throttled = (k, max = FAIL_MAX) => { const f = fails.get(k); if (!f) return 0; if (f.until < Date.now()) { fails.delete(k); return 0; } return f.n >= max ? Math.ceil((f.until - Date.now()) / 1000) : 0; };
  const noteFail = (k) => { const f = fails.get(k); if (!f || f.until < Date.now()) fails.set(k, { n: 1, until: Date.now() + FAIL_WINDOW }); else f.n++; if (fails.size > 50000) fails.delete(fails.keys().next().value); };
  const secureFlag = (req) => (process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  const json = (res, code, body, headers = {}) => { if (res.headersSent || res.writableEnded) { try { res.end(); } catch { /* socket already gone */ } return; } /* a late error after the reply started must not throw out of the handler */ res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
  const readBody = (req, limit = 64e3) => new Promise((ok, no) => { let d = '', big = false; const fail = (m, status) => { const e = new Error(m); e.status = status; return e; };
    req.on('data', c => { if (big) return; d += c; if (d.length > limit) { big = true; d = ''; } });
    req.on('end', () => { if (big) return no(fail('That request is too large. Uploaded PDFs can be up to 5 MB.', 413)); let v; try { v = d ? JSON.parse(d) : {}; } catch { return no(fail('bad json', 400)); } if (v === null || typeof v !== 'object' || Array.isArray(v)) return no(fail('The request must be a JSON object.', 400)); ok(v); });
    req.on('error', () => no(fail('bad request', 400))); });
  const cookie = (req, n) => (req.headers.cookie ?? '').split(/;\s*/).map(c => c.split('=')).find(([k]) => k === n)?.[1];
  const userOf = (req) => { const t = cookie(req, 'sid'); if (!t) return null; return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>=?').get(t, Date.now()) ?? null; };
  const sellerOf = (u) => u?.seller_id ? db.prepare('SELECT * FROM sellers WHERE id=?').get(u.seller_id) : null;

  const oauth = oauthRoutes({ db, secret, env, fetchImpl: oauthFetch, userOf, sellerOf, forgetApi: (id) => apis.delete(id) });
  function apiFor(seller) {
    const c = db.prepare('SELECT * FROM amazon_conn WHERE seller_id=?').get(seller.id);
    if (!c) throw new Error('Amazon is not connected');
    // Real-data gate, enforced at the execution choke point (critic round-8) and checked BEFORE the
    // client cache (critic round-9): EVERY Amazon call (sync, repair approval, correction retry,
    // settling) builds its client here, so neither a legacy live connection in the database nor a
    // cached client from an earlier flag-on moment can reach Amazon while the flag is unset - the
    // flag, not the connection row and not the cache, decides.
    if (c.mode === 'live' && env.ALLOW_LIVE_CONNECT !== '1') throw Object.assign(new Error('A direct Amazon connection is not open yet - the pilot runs on sample data only, exactly as the homepage says.'), { status: 403 });
    if (apis.has(seller.id)) return apis.get(seller.id);
    const keys = c.mode === 'demo' ? db.prepare('SELECT shipment_key FROM invoices WHERE seller_id=?').all(seller.id).map(r => String(r.shipment_key)) : [];
    // Seed BOTH sides of the mock's memory from the ledger: uploaded shipments AND uploaded credit
    // notes (REFUND:<transactionId>), so a redeploy keeps Amazon's verdicts consistent with our books.
    const api = c.mode === 'demo' ? new MockApi(keys.filter(k => k.startsWith('SHIPMENT:')).map(k => k.slice(9)), keys.filter(k => k.startsWith('REFUND:')).map(k => k.slice(7))) : c.mode === 'manual' ? { manual: true, uploadInvoice: async () => 'manual' } : new SpApi(decrypt(c.secret_enc, secret));
    apis.set(seller.id, api); return api;
  }
  // Round-8: per-seller sync lock. Both entry paths (manual "Sync now" and the hourly scheduler)
  // come through here; without the lock two overlapping syncs could race the upload claim checks.
  const syncing = new Set();
  async function sync(seller) {
    const connMode = db.prepare('SELECT mode FROM amazon_conn WHERE seller_id=?').get(seller.id)?.mode;
    if (connMode === 'manual') throw Object.assign(new Error('Manual mode has no automatic sync. Upload an order report instead.'), { status: 409 });
    if (connMode === 'live' && env.ALLOW_LIVE_CONNECT !== '1') throw Object.assign(new Error('A direct Amazon connection is not open yet - the pilot runs on sample data only, exactly as the homepage says.'), { status: 403 });
    if (syncing.has(seller.id)) throw Object.assign(new Error('A sync is already running for this account. Try again when it finishes.'), { status: 409 });
    syncing.add(seller.id);
    try { return await syncInner(seller); } finally { syncing.delete(seller.id); }
  }
  async function syncInner(seller) {
    const api = apiFor(seller), ids = JSON.parse(seller.marketplace_ids || '[]').map(c => marketplaceFor(c)).filter(Boolean);
    // all-status report: one pass detects new work AND carries Amazon's verdict (InvoiceUploaded /
    // InvoiceRejected / CreditNote*) on what we already sent - that verdict, not the feed state,
    // is what marks a document uploaded (see pollFeeds).
    // Round-14 (critic round-12): the report snapshots the seller's attempt sequence at request
    // time; its verdicts predate any attempt claimed after this snapshot. Ordering comes from the
    // monotonic sequence, never the clock (reportRequestedAt stays as secondary evidence).
    const reportRequestedAt = new Date();
    const reportAttemptSeq = currentAttemptSeq(db, seller.id);
    // Round-17 (critic round-15): report GENERATION - one per report taken in, independent of
    // upload attempts - orders proposal freshness; attempt_seq keeps ordering upload attempts.
    const reportGen = nextReportGen(db, seller.id);
    // Round-17 (P1-B): credit-note approvals are blocked while this newer report is in flight;
    // a failed sync clears the mark explicitly, so the block never sticks.
    markReportInFlight(db, seller.id, reportRequestedAt.toISOString());
    // Round-18 (critic round-16): the two failure classes are separated. BEFORE the download
    // completes, clearing the block is fine - the stored snapshot is genuinely the latest. The
    // moment the download completes, the report is stored IMMEDIATELY and the block stays up
    // while processing runs: a stale snapshot is never usable for approval once a newer report
    // has arrived. If the store itself fails, the block stays up (store_pending) until a later
    // sync stores a report - boot does not release it. A processing failure AFTER a successful
    // store lifts the block safely: approval revalidates against the newer stored report.
    let downloaded = false, stored = false;
    try {
      const rid = await api.requestVidr(ids, { all: true }); const doc = await api.waitReport(rid); const text = await api.downloadReport(doc);
      downloaded = true;
      markReportStorePending(db, seller.id);
      storeDownloadedReport(db, seller.id, { gen: reportGen, seq: reportAttemptSeq, requestedAt: reportRequestedAt.toISOString(), text });
      stored = true;
      const out = await processReport(db, seller, text, { api, validate, reportRequestedAt, reportAttemptSeq }); const corr = await processCorrections(db, seller, text, { api, validate, reportAttemptSeq }); const polled = await pollFeeds(db, seller, api); const alerts = F.radarAlerts(db, seller);
      const settled = await settleUnknownDocuments(db, seller, text, { api, validate, reportAttemptSeq }); if (settled.resubmitted.length) logEvent(db, seller.id, 'sync_settled_unknown', settled);
      let repairsProposed = 0; try { repairsProposed = detectRepairs(db, seller, text, { reportAttemptSeq, reportRequestedAt, reportGen }).proposed; } catch { /* a report without refund rows proposes nothing */ } // round-16/17: proposals carry the source report's freshness
      const result = { ...out, corrections: corr, polled, newAlerts: alerts.length, repairsProposed, at: new Date().toISOString() };
      db.prepare('UPDATE amazon_conn SET last_sync=?, last_sync_result=? WHERE seller_id=?').run(result.at, JSON.stringify({ detected: out.detected, uploaded: out.uploaded, held: out.held.length, deferred: out.deferred.length, errors: out.errors.length }), seller.id);
      clearReportInFlight(db, seller.id);
      return result;
    } catch (e) { if (!downloaded || stored) clearReportInFlight(db, seller.id); throw e; }
  }
  const DASH_LIMIT = Number(process.env.DASH_LIMIT ?? 500);
  function dashboard(seller) {
    const nowIso = new Date().toISOString();
    const k = db.prepare("SELECT count(*) total, sum(status='uploaded') uploaded, sum(status IN ('submitted','processing')) submitted, sum(status='held') held, sum(status IN ('held','rejected','error','unknown') OR (status='detected' AND due_at IS NOT NULL AND due_at < ?)) bad FROM shipments WHERE seller_id=?").get(nowIso, seller.id);
    const rows = db.prepare('SELECT key, order_id, shipping_id, buyer, buyer_vat, country, total, vat, shipment_date, due_at, status, reason FROM shipments WHERE seller_id=? ORDER BY shipment_date DESC, key LIMIT ?').all(seller.id, DASH_LIMIT);
    const inv = db.prepare('SELECT number, shipment_key, kind, rectifies, issued_at, total, upload_status FROM invoices WHERE seller_id=? ORDER BY issued_at DESC, number DESC LIMIT ?').all(seller.id, DASH_LIMIT);
    const invTotal = db.prepare('SELECT count(*) n FROM invoices WHERE seller_id=?').get(seller.id).n;
    const total = k.total ?? 0, bad = k.bad ?? 0;
    const conn = db.prepare('SELECT mode, connected_at, last_sync, last_sync_result FROM amazon_conn WHERE seller_id=?').get(seller.id);
    return { seller: { name: seller.name, nif: seller.nif, invoiceLang: seller.invoice_lang ?? 'auto', langOptions: Object.entries(LANGS) }, conn: conn && { ...conn, last_sync_result: conn.last_sync_result && JSON.parse(conn.last_sync_result) },
      kpis: { ready: db.prepare("SELECT count(*) n FROM invoices WHERE seller_id=? AND upload_status='ready'").get(seller.id).n, total, uploaded: k.uploaded ?? 0, submitted: k.submitted ?? 0, held: k.held ?? 0, estDefectPct: total ? Math.round(bad / total * 1000) / 10 : 0 },
      shown: { shipments: rows.length, shipmentsTotal: total, invoices: inv.length, invoicesTotal: invTotal },
      shipments: rows.map(r => ({ ...r, legal: r.shipment_date ? legalDeadline(r.shipment_date, seller.country ?? 'ES')?.date : null })), invoices: inv, vatChecks: db.prepare('SELECT vat, status, name, checked_at FROM vat_checks WHERE seller_id=? ORDER BY checked_at DESC LIMIT 10').all(seller.id) };
  }

  const server = http.createServer(async (req, res) => {
    if (inflight >= MAX_INFLIGHT) { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '2' }); return res.end('{"error":"The server is busy. Please try again in a few seconds."}'); }
    inflight++; res.on('close', () => { inflight--; });
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-frame-options', 'DENY');
    try {
      // CSRF root fix: a state-changing request must come from this site. Browsers always send Origin on cross-site POSTs.
      if (req.method !== 'GET' && req.method !== 'HEAD') { const o = req.headers.origin; if (o) { let same = false; try { same = new URL(o).host === req.headers.host; } catch {} if (!same) return json(res, 403, { error: 'Request blocked: it did not come from this site.' }); } }
      const url = new URL(req.url, 'http://x'), p = url.pathname;
      if (req.method === 'GET' && p === '/favicon.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }); return res.end(FAVICON); }
      if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(302, { location: '/favicon.svg', 'cache-control': 'public, max-age=86400' }); return res.end(); }
      if (req.method === 'GET' && (p === '/local' || p === '/local/' || p === '/local/page.js' || p === '/local/engine.js')) { // local engine: the page runs in the browser and is forbidden by CSP from making any network call
        const f = p === '/local/page.js' ? LOCAL_PAGE : p === '/local/engine.js' ? LOCAL_ENGINE : LOCAL_HTML;
        res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'content-security-policy': LOCAL_CSP, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }); return res.end(f);
      }
      if (req.method === 'GET' && LOOP_FILES[p] && process.env.ENABLE_LOOP_PAGE === '1') { const [f, ct] = LOOP_FILES[p]; res.writeHead(200, { 'content-type': ct, 'content-security-policy': LOCAL_CSP, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }); return res.end(loopFile(f)); }
      if (req.method === 'GET' && p === '/sample.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' }); return res.end(SAMPLE_JS); }
      // Public no-signup sample: the real pipeline on made-up orders, in a throwaway in-memory DB. Nothing is stored, nothing is sent anywhere.
      const bump = (k) => { try { db.prepare('INSERT INTO site_counters (key,n) VALUES (?,1) ON CONFLICT(key) DO UPDATE SET n=n+1').run(k); } catch { /* counting must never break a page */ } };
      const abVariant = () => { const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || 'anon'; return createHash('sha256').update('ab1|' + ip).digest()[0] % 2 ? 'b' : 'a'; };
      if (req.method === 'GET' && p === '/api/sample/run') {
        const xf = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean), ip = xf.length ? xf[xf.length - 1] : req.socket.remoteAddress, sk = 'sample|' + ip;
        const wait = Math.max(throttled(sk, 10), throttled('sample|all', 100));
        if (wait) return json(res, 429, { error: 'Too many sample runs from this network. Try again in a few minutes.' }, { 'retry-after': String(wait) });
        noteFail(sk); noteFail('sample|all');
        try { const run = await sampleRun(validate); bump('sample:run'); return json(res, 200, { seller: run.seller.name + ' (sample)', shipments: run.shipments, invoices: run.invoices }); }
        catch (e) { console.error('sample run', e); return json(res, 500, { error: 'The sample could not run right now. Try again in a minute.' }); }
      }
      if (req.method === 'GET' && p === '/api/sample/repair') {
        const xf = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean), ip = xf.length ? xf[xf.length - 1] : req.socket.remoteAddress, sk = 'sample|' + ip;
        const wait = Math.max(throttled(sk, 10), throttled('sample|all', 100));
        if (wait) return json(res, 429, { error: 'Too many sample runs from this network. Try again in a few minutes.' }, { 'retry-after': String(wait) });
        noteFail(sk); noteFail('sample|all');
        try { const { db: _inner, ...rep } = await sampleRepair(validate); if (rep.ok) bump('sample:repair'); return json(res, 200, rep); }
        catch (e) { console.error('sample repair', e); return json(res, 500, { error: 'The sample could not run right now. Try again in a minute.' }); }
      }
      const smp = p.match(/^\/api\/sample\/pdf\/([A-Z0-9-]+)$/);
      if (smp && req.method === 'GET') {
        const pdf = await samplePdf(validate, smp[1]).catch((e) => { console.error('sample pdf', e); return null; });
        if (!pdf) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${smp[1].replace(/\//g, '-')}.pdf"`, 'cache-control': 'no-store' }); return res.end(pdf);
      }
      const PUBLIC_READY = !!process.env.OPERATOR_NAME; // public pages stay off until the operator identity is set
      const PUB = { '/': landing, '/privacy': privacy, '/contact': contact, '/sample': sample, '/faq': faq };
      if (req.method === 'GET' && p === '/go/sample') { // server-side CTA click counter for the landing A/B test, no trackers
        if (!PUBLIC_READY) return json(res, 404, { error: 'Not found' });
        const v = url.searchParams.get('v') === 'b' ? 'b' : 'a';
        bump('cta:' + v); bump('cta:total');
        res.writeHead(302, { location: '/sample' }); return res.end();
      }
      if (req.method === 'GET' && p === '/robots.txt') {
        if (!PUBLIC_READY) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' });
        return res.end('User-agent: *\nAllow: /$\nAllow: /faq\nAllow: /sample\nAllow: /privacy\nAllow: /contact\nAllow: /articles\nAllow: /es$\nAllow: /de$\nAllow: /fr$\nAllow: /it$\nAllow: /nl$\nAllow: /pl$\nDisallow: /\n\nSitemap: https://' + req.headers.host + '/sitemap.xml\n');
      }
      if (req.method === 'GET' && p === '/sitemap.xml') {
        if (!PUBLIC_READY) return json(res, 404, { error: 'Not found' });
        const b = 'https://' + req.headers.host, d = new Date().toISOString().slice(0, 10);
        res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' });
        return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + ['/', '/es', '/de', '/fr', '/it', '/nl', '/pl', '/faq', '/sample', '/privacy', '/contact', '/articles', ...ARTICLES.map(a => '/articles/' + a.slug)].map(u => `<url><loc>${b}${u}</loc><lastmod>${d}</lastmod></url>`).join('') + '</urlset>\n');
      }
      if (req.method === 'GET' && (p === '/articles' || p.startsWith('/articles/'))) {
        if (!PUBLIC_READY) return json(res, 404, { error: 'Not found' });
        const html = p === '/articles' ? articlesIndex(process.env) : articlePage(decodeURIComponent(p.slice(10)).replace(/[^a-z0-9-]/g, ''), process.env);
        if (html) bump('pv:' + p);
        if (!html) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return res.end(notFound(process.env)); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'", 'cache-control': 'public, max-age=300' });
        return res.end(html);
      }
      const loc = /^\/(es|de|fr|it|nl|pl)$/.exec(p);
      if (req.method === 'GET' && loc) {
        if (!PUBLIC_READY) return json(res, 404, { error: 'Not found' });
        bump('pv:' + p);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'", 'cache-control': 'public, max-age=300' });
        return res.end(landingLocalized(loc[1], req.headers.host));
      }
      if (req.method === 'GET' && PUB[p] && !PUBLIC_READY) { if (p === '/') { res.writeHead(302, { location: '/app' }); return res.end(); } return json(res, 404, { error: 'Not found' }); }
      if (req.method === 'GET' && PUB[p]) {
        bump('pv:' + p);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'", 'cache-control': 'public, max-age=300' });
        if (p === '/contact') return res.end(contact(process.env, { sent: url.searchParams.get('sent') === '1', err: url.searchParams.get('err') }));
        if (p === '/') { const v = abVariant(); bump('pv:/:' + v); return res.end(landing(process.env, { variant: v, ctaHref: '/go/sample?v=' + v, country: countryFromLang(req.headers['accept-language']), host: req.headers.host })); }
        return res.end(PUB[p]());
      }
      if (req.method === 'POST' && p === '/contact' && PUBLIC_READY) { // plain HTML form: stored on our own server only
        const to = (loc) => { res.writeHead(303, { location: loc, 'cache-control': 'no-store' }); return res.end(); };
        if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return to('/contact?err=1');
        let raw = ''; let big = false; await new Promise(ok => { req.on('data', c => { if (big) return; raw += c; if (raw.length > 8000) { big = true; raw = ''; } }); req.on('end', ok); req.on('error', ok); });
        if (big) return to('/contact?err=1');
        const f = new URLSearchParams(raw), msg = String(f.get('message') ?? '').trim(), em = String(f.get('email') ?? '').trim();
        if (f.get('website')) return to('/contact?sent=1'); // honeypot: bots fill it, we pretend it worked and store nothing
        if (msg.length < 5 || msg.length > 2000 || em.length > 200 || (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em))) return to('/contact?err=1');
        const xf = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean), ip = xf.length ? xf[xf.length - 1] : req.socket.remoteAddress, ik = 'contact|' + ip;
        if (throttled(ik, 3) || throttled('contact|all', 60)) return to('/contact?err=2');
        noteFail(ik); noteFail('contact|all');
        db.prepare('INSERT INTO contact_messages (id, ts, email, message) VALUES (?,?,?,?)').run(randomUUID(), new Date().toISOString(), em || null, msg);
        db.prepare('DELETE FROM contact_messages WHERE ts < ?').run(new Date(Date.now() - 180 * 864e5).toISOString());
        return to('/contact?sent=1');
      }
      if (req.method === 'GET' && p === '/admin/messages') { // operator-only read of contact messages, disabled unless ADMIN_TOKEN is set
        const tok = process.env.ADMIN_TOKEN ?? '', got = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        const h = (x) => createHash('sha256').update(x).digest();
        if (tok.length < 24 || !timingSafeEqual(h(tok), h(got))) return json(res, 404, { error: 'not found' });
        return json(res, 200, { messages: db.prepare('SELECT ts, email, message FROM contact_messages ORDER BY ts DESC LIMIT 200').all() });
      }
      if (req.method === 'GET' && p === '/admin/counters') { // operator-only aggregated counters: no IPs, no user agents, no per-visitor data
        const tok = process.env.ADMIN_TOKEN ?? '', got = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        const h = (x) => createHash('sha256').update(x).digest();
        if (tok.length < 24 || !timingSafeEqual(h(tok), h(got))) return json(res, 404, { error: 'not found' });
        return json(res, 200, { counters: Object.fromEntries(db.prepare('SELECT key, n FROM site_counters ORDER BY key').all().map(r => [r.key, r.n])) });
      }
      if (req.method === 'GET' && p === '/admin/ingest-health') { // prototype of the report-ingest monitor: aggregates only
        const tok = process.env.ADMIN_TOKEN ?? '', got = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        const h = (x) => createHash('sha256').update(x).digest();
        if (tok.length < 24 || !timingSafeEqual(h(tok), h(got))) return json(res, 404, { error: 'not found' });
        const since = new Date(Date.now() - 7 * 864e5).toISOString(), rows = db.prepare('SELECT type, detail FROM events WHERE ts >= ?').all(since);
        const byType = {}, ingest = { reports: 0, rows: 0, issued: 0, held: 0 };
        for (const r of rows) { byType[r.type] = (byType[r.type] ?? 0) + 1; if (r.type === 'report_uploaded') { try { const d = JSON.parse(r.detail); ingest.reports++; ingest.rows += d.rows ?? 0; ingest.issued += d.issued ?? 0; ingest.held += d.held ?? 0; } catch { /* skip malformed */ } } }
        return json(res, 200, { windowDays: 7, eventsByType: byType, ingest });
      }
      if (req.method === 'GET' && p === '/admin/db-snapshot') { // operator-only consistent DB backup (VACUUM INTO), for the W6 data-loss fallback
        const tok = process.env.ADMIN_TOKEN ?? '', got = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        const h = (x) => createHash('sha256').update(x).digest();
        if (tok.length < 24 || !timingSafeEqual(h(tok), h(got))) return json(res, 404, { error: 'not found' });
        try {
          const tmp = `/tmp/ig-snapshot-${Date.now()}.db`;
          db.exec(`VACUUM INTO '${tmp}'`);
          const data = readFileSync(tmp); (await import('node:fs')).rmSync(tmp, { force: true });
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="invoiceguard-snapshot-${new Date().toISOString().slice(0, 10)}.db"`, 'content-length': data.length, 'cache-control': 'no-store' });
          return res.end(data);
        } catch (e) { console.error('snapshot failed', e.message); return json(res, 500, { error: 'Snapshot failed. Nothing was changed.' }); }
      }
      if (req.method === 'POST' && p === '/admin/db-restore') { // operator-only: validate and STAGE a snapshot; it is applied at the next restart
        const tok = process.env.ADMIN_TOKEN ?? '', got = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        const h = (x) => createHash('sha256').update(x).digest();
        if (tok.length < 24 || !timingSafeEqual(h(tok), h(got))) return json(res, 404, { error: 'not found' });
        const chunks = []; let n = 0; const LIM = 200e6;
        for await (const c of req) { n += c.length; if (n > LIM) return json(res, 413, { error: 'snapshot too large' }); chunks.push(c); }
        const { stageRestore } = await import('./restore.js');
        const r = stageRestore(Buffer.concat(chunks), process.env.DB_FILE ?? 'invoiceguard.db');
        console.log('db-restore staging:', r.ok ? 'validated and staged' : 'refused: ' + r.reason);
        return json(res, r.ok ? 200 : 422, r.ok ? { ok: true, staged: true, counts: r.counts, next: 'Restart or redeploy the service to apply it. The current database is kept as backups/pre-restore-*.db.' } : { ok: false, error: r.reason });
      }
      if (req.method === 'GET' && p === '/admin/weekly-summary') { // operator half of the weekly summary: aggregates only
        const tok = process.env.ADMIN_TOKEN ?? '', got = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        const h = (x) => createHash('sha256').update(x).digest();
        if (tok.length < 24 || !timingSafeEqual(h(tok), h(got))) return json(res, 404, { error: 'not found' });
        const since = new Date(Date.now() - 7 * 864e5).toISOString();
        const ev = db.prepare('SELECT type, COUNT(*) c FROM events WHERE ts >= ? GROUP BY type').all(since);
        const inv = db.prepare('SELECT upload_status st, COUNT(*) c FROM invoices WHERE issued_at >= ? GROUP BY upload_status').all(since);
        const acc = db.prepare('SELECT COUNT(*) c FROM users WHERE created_at >= ?').get(since).c;
        const counters = Object.fromEntries(db.prepare('SELECT key, n FROM site_counters ORDER BY key').all().map(r => [r.key, r.n]));
        return json(res, 200, { windowDays: 7, newAccounts: acc, eventsByType: Object.fromEntries(ev.map(r => [r.type, r.c])), invoicesByStatus: Object.fromEntries(inv.map(r => [r.st ?? 'unknown', r.c])), counters });
      }
      if (await oauth.handle(req, res, url, p)) return;
      if (req.method === 'GET' && (p === '/app' || p === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'" }); return res.end(INDEX); }
      const em = p.match(/^\/e\/([a-f0-9]{24})$/);
      if (req.method === 'GET' && em) { const html = F.explainerPage(db, em[1]); if (!html) return json(res, 404, { error: 'not found' }); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'" }); return res.end(html); }
      if (!p.startsWith('/api/')) {
        if (req.method === 'GET' && PUBLIC_READY) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'" }); return res.end(notFound(process.env)); }
        return json(res, 404, { error: 'not found' });
      }
      if (req.method !== 'GET' && !String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: 'json only' });
      const body = req.method === 'GET' ? {} : await readBody(req, p === '/api/export/external' ? 8e6 : p.startsWith('/api/manual/') ? 6e6 : 64e3);
      if (p === '/api/signup') {
        const email = String(body.email ?? '').trim().toLowerCase(), pw = String(body.password ?? '');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'Enter a valid email' });
        { const pr = passwordProblem(pw, email); if (pr) return json(res, 400, { error: pr }); }
        if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return json(res, 409, { error: 'An account with this email already exists' });
        const { salt, hash } = await hashPwAsync(pw), id = randomUUID();
        const ref = String(body.ref ?? '').trim();
        const referredBy = /^[a-f0-9]{10}$/.test(ref) && db.prepare('SELECT 1 FROM users WHERE ref_code=?').get(ref) ? ref : null;
        try { db.prepare('INSERT INTO users (id,email,salt,hash,seller_id,created_at,pw_changed_at,ref_code,referred_by) VALUES (?,?,?,?,?,?,?,?,?)').run(id, email, salt, hash, null, new Date().toISOString(), new Date().toISOString(), newRefCode(db), referredBy); db.prepare('INSERT INTO pw_history VALUES (?,?,?,?)').run(id, salt, hash, new Date().toISOString()); } catch (e) { if (/UNIQUE/.test(e.message)) return json(res, 409, { error: 'An account with this email already exists' }); throw e; }
        const recoveryCodes = newRecoveryCodes(db, id);
        bump('signup:total'); if (referredBy) { bump('signup:ref'); bump('ref:' + referredBy); }
        if (referredBy) logSec(db, req, 'signup_referred', id, email);
        logSec(db, req, 'signup', id, email); const t = newToken(); db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(t, id, Date.now() + 14 * 864e5);
        return json(res, 200, { ok: true, recoveryCodes }, { 'set-cookie': `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1209600${secureFlag(req)}` });
      }
      if (p === '/api/recover') { // signed-out password reset with a one-time recovery code; two-step sign-in (if on) stays on
        const em = String(body.email ?? '').trim().toLowerCase(), nw = String(body.next ?? ''), fk = 'rec|' + failKey(req, em), ak = 'racct|' + em, wait = Math.max(throttled(fk, 5), throttled(ak, 10));
        if (wait) return json(res, 429, { error: `Too many wrong attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` }, { 'retry-after': String(wait) });
        const u = db.prepare('SELECT * FROM users WHERE email=?').get(em);
        if (!u || !recoveryValid(db, u.id, body.code)) { logSec(db, req, 'recover_failed', u?.id ?? null, em); noteFail(fk); noteFail(ak); return json(res, 401, { error: 'That email and recovery code do not match, or the code was already used.' }); }
        const pr = passwordProblem(nw, em); if (pr) return json(res, 400, { error: pr });
        for (const h of db.prepare('SELECT salt, hash FROM pw_history WHERE user_id=? ORDER BY at DESC LIMIT ?').all(u.id, PW_HISTORY)) if (await checkPwAsync(nw, h.salt, h.hash)) return json(res, 400, { error: `Choose a password you have not used in your last ${PW_HISTORY}` });
        if (!recoveryConsume(db, u.id, body.code)) return json(res, 401, { error: 'That email and recovery code do not match, or the code was already used.' });
        const { salt, hash } = await hashPwAsync(nw), now = new Date().toISOString();
        db.prepare('UPDATE users SET salt=?, hash=?, pw_changed_at=? WHERE id=?').run(salt, hash, now, u.id); db.prepare('INSERT INTO pw_history VALUES (?,?,?,?)').run(u.id, salt, hash, now);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); fails.delete(fk); fails.delete(ak); logSec(db, req, 'password_recovered', u.id, em);
        return json(res, 200, { ok: true, codesLeft: recoveryLeft(db, u.id), twoStep: !!db.prepare('SELECT 1 FROM mfa WHERE user_id=? AND enabled=1').get(u.id) });
      }
      if (p === '/api/login') {
        const em = String(body.email ?? '').trim().toLowerCase(), fk = failKey(req, em), ak = 'acct|' + em, wait = Math.max(throttled(fk), throttled(ak, 10)); // per IP+email, and per account across all IPs
        if (wait) { logSec(db, req, 'login_locked', null, em); } if (wait) return json(res, 429, { error: `Too many wrong attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` }, { 'retry-after': String(wait) });
        const u = db.prepare('SELECT * FROM users WHERE email=?').get(em);
        const okPw = u ? await checkPwAsync(String(body.password ?? ''), u.salt, u.hash) : (await checkPwAsync(String(body.password ?? ''), 'unknown-user-salt', '0'), false); // same work either way, so timing does not reveal which emails exist
        if (!okPw) { logSec(db, req, 'login_failed', u?.id ?? null, em); noteFail(fk); noteFail(ak); return json(res, 401, { error: 'Wrong email or password' }); }
        const mf = db.prepare('SELECT * FROM mfa WHERE user_id=? AND enabled=1').get(u.id);
        if (mf) {
          const step = body.code ? totpMatch(decrypt(mf.secret_enc, secret), body.code) : null;
          if (!body.code) return json(res, 401, { error: 'Enter the 6-digit code from your authenticator app', mfa: true });
          if (step === null || step <= mf.last_step) { logSec(db, req, 'mfa_failed', u.id, em); noteFail(fk); noteFail(ak); return json(res, 401, { error: 'That code did not work. Check the time on your phone and try the next code.', mfa: true }); }
          db.prepare('UPDATE mfa SET last_step=? WHERE user_id=?').run(step, u.id);
        }
        fails.delete(fk); fails.delete(ak); logSec(db, req, 'login_ok', u.id, em);
        const t = newToken(); db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(t, u.id, Date.now() + 14 * 864e5);
        return json(res, 200, { ok: true }, { 'set-cookie': `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1209600${secureFlag(req)}` });
      }
      const user = userOf(req); if (!user) return json(res, 401, { error: 'Sign in required' });
      if (p === '/api/logout') { logSec(db, req, 'logout', user.id); db.prepare('DELETE FROM sessions WHERE token=?').run(cookie(req, 'sid')); return json(res, 200, { ok: true }, { 'set-cookie': 'sid=; Max-Age=0; Path=/' }); }
      if (p === '/api/recovery/new') { // replaces all earlier codes; needs the current password
        const fk = 'rcn|' + user.id; if (throttled(fk, 10)) return json(res, 429, { error: 'Too many wrong attempts. Try again later.' });
        if (!(await checkPwAsync(String(body.password ?? ''), user.salt, user.hash))) { noteFail(fk); return json(res, 401, { error: 'Your password is wrong' }); }
        const recoveryCodes = newRecoveryCodes(db, user.id); logSec(db, req, 'recovery_codes_new', user.id); return json(res, 200, { ok: true, recoveryCodes });
      }
      if (p === '/api/password') {
        const cur = String(body.current ?? ''), nw = String(body.next ?? ''), fk = 'pw|' + user.id; if (throttled(fk, 10)) return json(res, 429, { error: 'Too many wrong attempts. Try again later.' });
        if (!(await checkPwAsync(cur, user.salt, user.hash))) { noteFail(fk); return json(res, 401, { error: 'Your current password is wrong' }); }
        const pr = passwordProblem(nw, user.email); if (pr) return json(res, 400, { error: pr });
        for (const h of db.prepare('SELECT salt, hash FROM pw_history WHERE user_id=? ORDER BY at DESC LIMIT ?').all(user.id, PW_HISTORY)) if (await checkPwAsync(nw, h.salt, h.hash)) return json(res, 400, { error: `Choose a password you have not used in your last ${PW_HISTORY}` });
        const { salt, hash } = await hashPwAsync(nw), now = new Date().toISOString();
        db.prepare('UPDATE users SET salt=?, hash=?, pw_changed_at=? WHERE id=?').run(salt, hash, now, user.id); db.prepare('INSERT INTO pw_history VALUES (?,?,?,?)').run(user.id, salt, hash, now);
        logSec(db, req, 'password_changed', user.id); db.prepare('DELETE FROM sessions WHERE user_id=? AND token != ?').run(user.id, cookie(req, 'sid')); return json(res, 200, { ok: true });
      }
      if (p === '/api/mfa/setup') { // starts setup; two-step sign-in is only switched on after a correct code
        const mf = db.prepare('SELECT enabled FROM mfa WHERE user_id=?').get(user.id); if (mf?.enabled) return json(res, 409, { error: 'Two-step sign-in is already on' });
        if (secret === 'dev-secret-change-me') return json(res, 500, { error: 'Server is not configured: set APP_SECRET first' });
        const sec = newTotpSecret(); db.prepare('INSERT INTO mfa (user_id,secret_enc,enabled,last_step,created_at) VALUES (?,?,0,0,?) ON CONFLICT(user_id) DO UPDATE SET secret_enc=excluded.secret_enc, enabled=0, last_step=0').run(user.id, encrypt(sec, secret), new Date().toISOString());
        return json(res, 200, { secret: sec, url: otpauthUrl(user.email, sec) });
      }
      if (p === '/api/mfa/enable') {
        const mf = db.prepare('SELECT * FROM mfa WHERE user_id=?').get(user.id); if (!mf) return json(res, 400, { error: 'Start setup first' });
        const step = totpMatch(decrypt(mf.secret_enc, secret), body.code); if (step === null) return json(res, 400, { error: 'That code did not work. Check the time on your phone and try again.' });
        db.prepare('UPDATE mfa SET enabled=1, last_step=? WHERE user_id=?').run(step, user.id); logSec(db, req, 'mfa_enabled', user.id); return json(res, 200, { ok: true });
      }
      if (p === '/api/mfa/disable') {
        const mf = db.prepare('SELECT * FROM mfa WHERE user_id=? AND enabled=1').get(user.id); if (!mf) return json(res, 400, { error: 'Two-step sign-in is not on' });
        const fk = 'mfa|' + user.id; if (throttled(fk, 10)) return json(res, 429, { error: 'Too many wrong attempts. Try again later.' });
        const step = totpMatch(decrypt(mf.secret_enc, secret), body.code);
        if (!(await checkPwAsync(String(body.password ?? ''), user.salt, user.hash)) || step === null || step <= mf.last_step) { noteFail(fk); return json(res, 401, { error: 'Password or code is wrong' }); }
        db.prepare('DELETE FROM mfa WHERE user_id=?').run(user.id); logSec(db, req, 'mfa_disabled', user.id); return json(res, 200, { ok: true });
      }
      if (p === '/api/referrals') {
        const em = String(body.email ?? '').trim().toLowerCase();
        if (em.length > 200 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return json(res, 400, { error: 'Enter a valid email' });
        if (em === user.email) return json(res, 400, { error: 'That is your own email' });
        if (throttled('ref|' + user.id, 5)) return json(res, 429, { error: 'Too many. Try again later.' });
        noteFail('ref|' + user.id);
        if (db.prepare('SELECT 1 FROM referrals WHERE user_id=? AND email=?').get(user.id, em)) return json(res, 409, { error: 'Already noted' });
        if (db.prepare('SELECT COUNT(*) n FROM referrals WHERE user_id=?').get(user.id).n >= 20) return json(res, 400, { error: 'Enough for now, thank you' });
        db.prepare('INSERT INTO referrals (id, ts, user_id, email) VALUES (?,?,?,?)').run(randomUUID(), new Date().toISOString(), user.id, em);
        logSec(db, req, 'referral_added', user.id);
        return json(res, 200, { ok: true });
      }
      if (p === '/api/me') { const s = sellerOf(user); const c = s && db.prepare('SELECT mode FROM amazon_conn WHERE seller_id=?').get(s.id); return json(res, 200, { email: user.email, referralCode: user.ref_code ?? null, oauth: oauth.available(), security: { twoStep: !!db.prepare('SELECT 1 FROM mfa WHERE user_id=? AND enabled=1').get(user.id), passwordAgeDays: user.pw_changed_at ? Math.floor((Date.now() - Date.parse(user.pw_changed_at)) / 864e5) : null, passwordMaxAgeDays: PW_MAX_AGE_DAYS, recoveryLeft: recoveryLeft(db, user.id) }, seller: s && { country: s.country ?? 'ES', name: s.name, nif: s.nif, address: s.address, marketplaces: JSON.parse(s.marketplace_ids), profile: sellerProfile(s) }, amazon: c?.mode ?? null, features: { referrals: process.env.REFERRALS_UI === '1' } }); }
      if (p === '/api/seller') {
        const { name, nif, address, marketplaces } = body; const cc = String(body.country ?? 'ES').toUpperCase(); if (!/^[A-Z]{2}$/.test(cc)) return json(res, 400, { error: 'Choose the country you issue invoices from' }); const mk = (marketplaces ?? []).filter(m => MARKETPLACE[m]);
        if (!name || !nif || !address || !mk.length) return json(res, 400, { error: 'Name, tax ID, address and at least one marketplace are required' });
        const id = user.seller_id ?? randomUUID();
        db.prepare('INSERT INTO sellers (id,name,nif,address,email,marketplace_ids,created_at,country) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET country=excluded.country, name=excluded.name, nif=excluded.nif, address=excluded.address, marketplace_ids=excluded.marketplace_ids')
          .run(id, name, String(nif).toUpperCase(), address, user.email, JSON.stringify(mk), new Date().toISOString(), cc);
        db.prepare('UPDATE users SET seller_id=? WHERE id=?').run(id, user.id); return json(res, 200, { ok: true });
      }
      const seller = sellerOf(user); if (!seller) return json(res, 409, { error: 'Complete your seller profile first' });

      // Sealed evidence is an explicitly requested, seller-scoped advisory snapshot.
      // It never feeds back into invoice, hold, claim, repair, upload or decision paths.
      const intelTablesReady = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='intel_evidence_chain'").get());
      if (p === '/api/intel/seal') {
        if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
        if (!mainDbPath) return json(res, 503, { code: 'PERSISTENT_DATABASE_REQUIRED', error: 'Evidence sealing is available only when InvoiceGuard is using its persistent database. No financial records were changed.' });
        let reader = null;
        try {
          reader = openIntelReader(mainDbPath);
          const result = sealSellerEvidence({ writerDb: db, readerDb: reader, sellerId: seller.id });
          return json(res, 200, {
            ok: true,
            added: result.added,
            head: result.head,
            verification: result.verification,
            coverage: result.coverage,
            sourceCount: result.sourceCount,
            authority: 'ADVISORY_ONLY',
            changesFinancialState: false
          });
        } catch (e) {
          if (e?.busy) throw e;
          console.error('intel evidence seal refused', e?.message || e);
          return json(res, 409, { code: 'EVIDENCE_SEAL_REFUSED', error: 'The evidence snapshot could not be sealed. No invoice or financial decision was changed.' });
        } finally {
          try { reader?.close(); } catch {}
        }
      }
      if (p === '/api/intel/timeline') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Use GET.' });
        const number = String(url.searchParams.get('number') ?? '').trim();
        if (!number || number.length > 200) return json(res, 400, { error: 'Choose a valid invoice number.' });
        if (!db.prepare('SELECT 1 FROM invoices WHERE seller_id=? AND number=?').get(seller.id, number)) return json(res, 404, { error: 'Invoice not found.' });
        if (!intelTablesReady()) return json(res, 409, { code: 'EVIDENCE_NOT_SEALED', error: 'No sealed evidence snapshot exists yet.' });
        const verification = verifyEvidenceChain(db, seller.id);
        if (!verification.valid) return json(res, 409, { code: 'EVIDENCE_CHAIN_INVALID', error: 'The sealed evidence chain did not verify. Do not rely on this timeline.' });
        const timeline = buildDocumentTimeline(db, seller.id, number);
        return json(res, 200, {
          ...timeline,
          checkpoint: { sellerId: seller.id, sequence: verification.sequence, hash: verification.hash },
          verification,
          authority: 'ADVISORY_ONLY',
          changesFinancialState: false
        });
      }
      if (p === '/api/intel/export') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Use GET.' });
        if (!intelTablesReady()) return json(res, 409, { code: 'EVIDENCE_NOT_SEALED', error: 'No sealed evidence snapshot exists yet.' });
        const verification = verifyEvidenceChain(db, seller.id);
        if (!verification.valid) return json(res, 409, { code: 'EVIDENCE_CHAIN_INVALID', error: 'The sealed evidence chain did not verify. Export refused.' });
        const bundle = exportEvidenceBundle(db, seller.id);
        const filename = 'invoiceguard-evidence-' + new Date().toISOString().slice(0, 10) + '.json';
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="' + filename + '"',
          'cache-control': 'no-store',
          'x-invoiceguard-checkpoint': verification.hash
        });
        return res.end(JSON.stringify(bundle, null, 2));
      }
      if (p === '/api/seller/profile') { const c = cleanProfile(body); if (c.errors.length) return json(res, 400, { error: c.errors.join('. ') }); db.prepare('UPDATE sellers SET profile=? WHERE id=?').run(JSON.stringify(c.profile), seller.id); logEvent(db, seller.id, 'profile_updated', { fields: Object.keys(c.profile) }); return json(res, 200, { ok: true, profile: c.profile }); }
      if (p === '/api/amazon/oauth/start') { if (env.ALLOW_LIVE_CONNECT !== '1') return json(res, 403, { error: 'A direct Amazon connection is not open yet - the pilot runs on sample data only, exactly as the homepage says.' }); const r = oauth.start(user, seller, body); return json(res, r.code, r.body); }
      if (p === '/api/amazon/connect') {
        let mode, enc = null;
        if (body.demo) mode = 'demo'; else if (body.manual) mode = 'manual';
        else mode = 'live';
        // Real-data gate (pilot): until we have tested on a real Seller Central file, the public app
        // runs on made-up sample data only - the homepage and FAQ promise exactly that. Opening real
        // uploads or a live connection is a deliberate env switch, never an accident.
        if (mode === 'live' && env.ALLOW_LIVE_CONNECT !== '1') return json(res, 403, { error: 'A direct Amazon connection is not open yet - the pilot runs on sample data only, exactly as the homepage says.' });
        if (mode === 'manual' && env.ALLOW_MANUAL_UPLOAD !== '1') return json(res, 403, { error: 'Uploading your own report is not open yet - the pilot runs on made-up sample data only, exactly as the homepage says.' });
        if (mode === 'live') { if (secret === 'dev-secret-change-me') return json(res, 500, { error: 'Server is not configured for live credentials: set APP_SECRET to a long random value first' }); const { clientId, clientSecret, refreshToken } = body; if (!clientId || !clientSecret || !refreshToken) return json(res, 400, { error: 'Client ID, client secret and refresh token are required' }); mode = 'live'; enc = encrypt({ clientId, clientSecret, refreshToken, region: 'EU' }, secret); }
        if (mode === 'manual' && db.prepare('SELECT mode FROM amazon_conn WHERE seller_id=?').get(seller.id)?.mode === 'demo') { // leaving the simulated demo: remove its made-up data so it never mixes with real invoices
          db.exec('BEGIN'); try { for (const t of ['shipments', 'invoices', 'vat_checks', 'counters', 'audit', 'alerts', 'vat_watch', 'vat_watch_log', 'ext_docs']) { try { db.prepare(`DELETE FROM ${t} WHERE seller_id=?`).run(seller.id); } catch (e) { if (!/no such table/.test(e.message)) throw e; } } db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
          logEvent(db, seller.id, 'demo_data_removed', {});
        }
        db.prepare('INSERT INTO amazon_conn (seller_id,mode,secret_enc,connected_at) VALUES (?,?,?,?) ON CONFLICT(seller_id) DO UPDATE SET mode=excluded.mode, secret_enc=excluded.secret_enc, connected_at=excluded.connected_at').run(seller.id, mode, enc, new Date().toISOString());
        apis.delete(seller.id); logEvent(db, seller.id, 'amazon_connected', { mode }); return json(res, 200, { ok: true, mode });
      }
      if (p === '/api/settings') { if (!SETTINGS.includes(body.invoiceLang)) return json(res, 400, { error: 'Unknown invoice language setting' }); db.prepare('UPDATE sellers SET invoice_lang=? WHERE id=?').run(body.invoiceLang, seller.id); return json(res, 200, { ok: true }); }
      if (p === '/api/audit/verify') { const r = verifyAudit(db, seller.id); return json(res, 200, { ...r, entries: db.prepare('SELECT COUNT(*) n FROM audit WHERE seller_id=?').get(seller.id).n }); }
      if (p === '/api/export.csv') {
        const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const rows = db.prepare('SELECT number, kind, rectifies, issued_at, total, vat, shipment_key, upload_status FROM invoices WHERE seller_id=? ORDER BY number').all(seller.id);
        const csv = ['number,type,rectifies,issued_at,total_eur,vat_eur,shipment,amazon_upload', ...rows.map(r => [r.number, r.kind, r.rectifies, r.issued_at, r.total, r.vat, r.shipment_key, r.upload_status].map(q).join(','))].join('\n');
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="invoices.csv"' }); return res.end(csv);
      }
      if (p === '/api/radar') return json(res, 200, { ...F.radar(db, seller, new Date(), 500), alerts: F.listAlerts(db, seller) });
      if (p === '/api/wizard') return json(res, 200, F.wizard(db, { country: seller.country ?? 'ES', ...body, marketplaces: body.marketplaces ?? JSON.parse(seller.marketplace_ids || '[]') }));
      const mt = p.match(/^\/api\/invoices\/([A-Z]-\d{4}-\d{6})\/trail$/);
      if (mt) { // per-order evidence trail: every recorded step for this invoice and its order, oldest first
        const num = mt[1], inv = db.prepare('SELECT shipment_key, number, rectifies, issued_at, uploaded_at FROM invoices WHERE seller_id=? AND number=?').get(seller.id, num);
        if (!inv) return json(res, 404, { error: 'not found' });
        const ship = inv.shipment_key ? db.prepare('SELECT order_id AS orderId, due_at, shipment_date FROM shipments WHERE seller_id=? AND key=?').get(seller.id, inv.shipment_key) : null;
        const match = (d) => d && (d.key === inv.shipment_key || d.number === num || d.rect === num || d.rectifies === num || d.original === num);
        const events = db.prepare('SELECT ts, type, detail FROM events WHERE seller_id=? ORDER BY ts').all(seller.id)
          .filter(e => { try { return match(JSON.parse(e.detail)); } catch { return false; } })
          .map(e => ({ ts: e.ts, type: e.type, detail: JSON.parse(e.detail) }));
        return json(res, 200, { number: num, orderId: ship?.orderId ?? null, shipmentDate: ship?.shipment_date ?? null, dueAt: ship?.due_at ?? null, issuedAt: inv.issued_at, uploadedAt: inv.uploaded_at, events });
      }
      const mc = p.match(/^\/api\/invoices\/([A-Z]-\d{4}-\d{6})\/checks$/);
      if (mc) { const r = db.prepare('SELECT json FROM invoices WHERE seller_id=? AND number=?').get(seller.id, mc[1]); return r ? json(res, 200, { warnings: F.buyerCountryCheck(JSON.parse(r.json), seller.country ?? 'ES') }) : json(res, 404, { error: 'not found' }); }
      if (p === '/api/export.zip') { try { const x = await F.buildExport(db, seller, body.from, body.to); res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="invoices-${body.from}-to-${body.to}.zip"`, 'x-count': String(x.count) }); return res.end(x.zip); } catch (e) { return json(res, 400, { error: e.message }); } }
      if (p === '/api/export/external') { try { return json(res, 200, F.addExternalDoc(db, seller, body)); } catch (e) { return json(res, 400, { error: e.message }); } }
      if (p === '/api/buyer/message') return json(res, 200, F.buyerMessage(String(body.orderId ?? ''), body.country));
      if (p === '/api/b2c') { try { return json(res, 200, F.convertToConsumerInvoice(db, seller, String(body.key), seller.email ?? seller.name)); } catch (e) { return json(res, 400, { error: e.message }); } }
      if (p === '/api/watch') return json(res, 200, F.watchReport(db, seller));
      if (p === '/api/watch/add') { try { return json(res, 200, F.watchAdd(db, seller, body.vat, body.label)); } catch (e) { return json(res, 400, { error: e.message }); } }
      if (p === '/api/watch/remove') { F.watchRemove(db, seller, body.vat); return json(res, 200, { ok: true }); }
      if (p === '/api/watch/run') return json(res, 200, { changes: await F.watchRun(db, seller, validate.fresh ?? validate, { force: true }) });
      if (p === '/api/explainer') return json(res, 200, F.explainerState(db, seller));
      if (p === '/api/explainer/review') return json(res, 200, F.explainerReview(db, seller, seller.email ?? seller.name));
      if (p === '/api/explainer/unpublish') { F.explainerUnpublish(db, seller); return json(res, 200, { ok: true }); }
      const OPERATORS = new Set(String(process.env.OPERATOR_EMAILS ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean));
      const isOperator = OPERATORS.has(String(seller.email ?? '').toLowerCase());
      if (p === '/api/rules') return json(res, 200, { packs: allRuleStates(db, undefined, undefined, { operator: isOperator }), notResearched: ['GB', 'CH'], disclaimer: 'Reference data with official sources. Not legal or tax advice: have a gestor or lawyer review it before you rely on it.' });
      if (p === '/api/rules/check') { const r = await checkSources(db, { only: body.rule }); return json(res, 200, { checked: r.length, unreachable: r.filter(x => x.fetch !== 'ok').length, missing: r.filter(x => x.missing.length).map(x => x.id) }); }
      if (p === '/api/rules/review') { if (!isOperator) return json(res, 403, { error: 'Only the InvoiceGuard operator can mark a rule as reviewed.' }); try { reviewRule(db, String(body.rule), seller.email ?? seller.name, body.note); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); } }
      if (p === '/api/manual/preview' || p === '/api/manual/issue') {
        if (env.ALLOW_MANUAL_UPLOAD !== '1') return json(res, 403, { error: 'Uploading your own report is not open yet - the pilot runs on made-up sample data only, exactly as the homepage says.' });
        const plan = planUpload(String(body.text ?? ''));
        if (!plan.ok) return json(res, 400, { error: plan.error, format: plan.format ?? null });
        const bad = plan.invalidRows ?? []; // quarantined rows: line numbers and counts only, never cell content
        const invalidRows = bad.slice(0, 50).map(x => ({ line: x.line, reason: x.reason, cells: x.cells, expected: x.expected }));
        const warning = bad.length ? `${bad.length} ${bad.length === 1 ? 'line' : 'lines'} of your file could not be read and ${bad.length === 1 ? 'was' : 'were'} not used (a line break inside a cell splits a row). No invoice was made from ${bad.length === 1 ? 'it' : 'them'}. Download the report again and check ${bad.length === 1 ? 'that line' : 'those lines'}: ${bad.slice(0, 10).map(x => x.line).join(', ')}${bad.length > 10 ? ' and more' : ''}.` : null;
        const view = { invalidRowsCount: bad.length, invalidRows, warning, format: plan.format, formatName: plan.formatName, rows: plan.rows, truncated: plan.truncated, willIssue: plan.shipments.length, held: plan.held.map(h => ({ orderId: h.orderId, reason: h.reason })).slice(0, 100), heldCount: plan.held.length, skippedCount: plan.skipped.length, skipped: plan.skipped.slice(0, 20),
          sample: plan.shipments.slice(0, 20).map(x => ({ orderId: x.orderId, buyer: x.buyerCompany, buyerVat: x.buyerVat, currency: x.currency, total: x.incl, vat: x.vat })) };
        if (p === '/api/manual/preview') return json(res, 200, view);
        if (body.attest !== true) return json(res, 400, { error: 'Please confirm the two checks first.' });
        // Round-22 (critic round-19): for a VIDR the protection is recorded and the report stored the moment it is accepted, BEFORE the first await (processReport); in_flight stays up through processing. An Order Report carries no refund evidence: it never touches the stored VIDR snapshot or any block (P2).
        const isVidr = plan.format === 'vidr', mText = String(body.text ?? '');
        const stamp = { gen: isVidr ? nextReportGen(db, seller.id) : null, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date().toISOString() };
        if (isVidr) { try { beginManualVidr(db, seller, mText, stamp); } catch (e) { console.error('manual report store', e); return json(res, 500, { error: 'The report could not be stored, so nothing was issued and credit-note approvals stay blocked. Upload the report again.' }); } }
        try {
        const prev = (key) => db.prepare('SELECT status, reason FROM shipments WHERE seller_id=? AND key=?').get(seller.id, key);
        for (const h of plan.held) { const st = h.s ?? { key: `ORDER:${h.orderId}`, orderId: h.orderId, shippingId: h.orderId, buyerVat: null, buyerCompany: null, shipCountry: null, incl: null, vat: null, shipmentDate: null, orderDate: null, manual: true }; const pv = prev(st.key); const alreadyHeld = pv?.status === 'held' && pv?.reason === h.reason; if (!pv) logEvent(db, seller.id, 'detected', { key: st.key, orderId: st.orderId }); if (!alreadyHeld && !['ready', 'uploaded', 'submitted'].includes(pv?.status)) { upsertShipment(db, seller.id, st, 'held', h.reason); logEvent(db, seller.id, 'held', { key: st.key, reason: h.reason }); } }
        const out = await processReport(db, seller, '', { api: { manual: true, uploadInvoice: async () => 'manual' }, validate, shipments: plan.shipments });
        logEvent(db, seller.id, 'report_uploaded', { format: plan.format, rows: plan.rows, issued: out.uploaded, held: out.held.length + plan.held.length });
        let repairsProposed = 0;
        if (isVidr) {
          // Round-23 (critic round-20): by now the invoices are recorded and the report is stored; if proposal detection fails, say exactly that (never the generic "nothing was changed"). Approvals stay protected by the freshness check against the stored report.
          try { repairsProposed = finishManualVidr(db, seller, mText, stamp); } // quiet only when the report has no refund rows; database errors are loud
          catch (e) { console.error('manual repair detection', e); return json(res, 500, { error: 'The invoices from this upload were recorded and the report itself is stored, but the credit-note suggestions could not be checked this time. Nothing is lost: credit-note approvals stay protected by the freshness check. Upload the report again to refresh the suggestions.', issued: out.uploaded, reportStored: true, suggestionsFailed: true }); }
        }
          return json(res, 200, { ...view, heldReasons: out.held.map(h => h.reason), issued: out.uploaded, skippedAlready: out.skipped, heldNow: out.held.length + plan.held.length, deferred: out.deferred.length, errors: out.errors.length, repairsProposed });
        } finally { if (isVidr) clearReportInFlight(db, seller.id); } // the report is already stored: success or failure, approval revalidates against it
      }
      if (p === '/api/holds') { const holds = listHolds(db, seller.id, { includeClosed: url.searchParams.get('all') === '1' }); return json(res, 200, { holds, truncated: !!holds.truncated }); } // expedition W2-2: the review queue for HOLD and BLOCK findings
      if (p === '/api/holds/decide') {
        if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
        try { const r = decideHold(db, seller.id, body, user.email ?? user.id); logEvent(db, seller.id, 'hold_decided', { key: body.key, code: body.code }); return json(res, 200, r); } catch (e) { if (e?.busy) throw e; return json(res, 422, { error: e.message }); }
      }
      if (p === '/api/holds/note') { // ruling 5: investigation notes never change state
        if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
        try { return json(res, 200, addHoldNote(db, seller.id, body, user.email ?? user.id)); } catch (e) { if (e?.busy) throw e; return json(res, 422, { error: e.message }); }
      }
      if (p === '/api/repairs') { // review queue: proposed first, then the recent history
        const snap = latestReportSnapshot(db, seller.id); // round-16/17: the review shows each proposal's freshness, ordered by report generation
        const proposed = listRepairs(db, seller.id, 'proposed').map(r => ({ ...r, fresher: snap != null && snap.gen != null && snap.gen > (r.report_gen ?? -1) }));
        const history = ['issued', 'exported', 'uploaded', 'rejected', 'approved', 'dismissed', 'held'].flatMap(st => listRepairs(db, seller.id, st)).slice(0, 50);
        return json(res, 200, { proposed, history });
      }
      if (p === '/api/repairs/authorize-retry') {
        if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
        try { const r = authorizeUnknownRetry(db, seller.id, body.key, body, user.email ?? user.id); return json(res, 200, r); } catch (e) { if (e?.busy) throw e; return json(res, 422, { error: e.message }); }
      }
      if (p === '/api/repairs/approve' || p === '/api/repairs/dismiss') {
        if (typeof body.key !== 'string' || !body.key || body.key.length > 200) return json(res, 400, { error: 'Choose a repair first.' });
        try {
          if (p === '/api/repairs/dismiss') { decideRepair(db, seller.id, body.key, 'dismissed', body, user.email ?? user.id); logEvent(db, seller.id, 'repair_dismissed', { key: body.key }); return json(res, 200, { ok: true }); }
          const r = await approveRepair(db, seller, body.key, { api: apiFor(seller), validate });
          logEvent(db, seller.id, 'repair_issued', { key: body.key, rect: r.rectNumber, rectifies: r.original });
          return json(res, 200, r);
        } catch (e) { if (e?.busy) throw e; return json(res, 422, { error: e.message }); }
      }
      if (p === '/api/invoices/mark') {
        const nums = body.all === true ? db.prepare("SELECT number FROM invoices WHERE seller_id=? AND upload_status='ready'").all(seller.id).map(r => r.number) : (Array.isArray(body.numbers) ? body.numbers.map(String).slice(0, 5000) : []);
        let n = 0, heldBack = 0; const now = new Date().toISOString();
        for (const num of nums) { const r = db.prepare("SELECT shipment_key, kind, rectifies FROM invoices WHERE seller_id=? AND number=? AND upload_status='ready'").get(seller.id, num); if (!r) continue; if (r.kind === 'rectificativa' && pairHoldOpen(db, seller.id, r.rectifies, r.shipment_key)) { heldBack++; continue; } db.prepare("UPDATE invoices SET upload_status='uploaded', uploaded_at=? WHERE seller_id=? AND number=?").run(now, seller.id, num); db.prepare("UPDATE shipments SET status='uploaded' WHERE seller_id=? AND key=? AND status='ready'").run(seller.id, r.shipment_key); db.prepare("UPDATE repairs SET state='uploaded' WHERE seller_id=? AND rect_number=? AND state IN ('issued','exported')").run(seller.id, num); logEvent(db, seller.id, 'uploaded', { number: num }); n++; }
        if (n) logEvent(db, seller.id, 'marked_uploaded', { count: n }); return json(res, 200, { ok: true, marked: n, heldBack, ...(heldBack ? { note: `${heldBack} correction document(s) were not marked: an open credit-note hold needs a decision first (Documents > Holds).` } : {}) });
      }
      if (p === '/api/invoices/reject') { // manual product: Amazon refused an upload; keep the error, close nothing, offer the fix path
        const num = String(body.number ?? ''); if (!num || num.length > 40) return json(res, 400, { error: 'Which invoice?' });
        const reason = String(body.error ?? '').trim().slice(0, 500); if (!reason) return json(res, 400, { error: 'Paste the message Amazon showed you.' });
        const inv = db.prepare('SELECT shipment_key, upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, num);
        if (!inv) return json(res, 404, { error: `No invoice ${num}.` });
        if (!['ready', 'uploaded', 'submitted'].includes(inv.upload_status)) return json(res, 409, { error: `Invoice ${num} is ${inv.upload_status}, not waiting on an Amazon upload.` });
        db.prepare("UPDATE invoices SET upload_status='rejected', error=? WHERE seller_id=? AND number=?").run(reason, seller.id, num);
        db.prepare("UPDATE shipments SET status='rejected' WHERE seller_id=? AND key=? AND status IN ('ready','uploaded')").run(seller.id, inv.shipment_key);
        db.prepare("UPDATE repairs SET state='rejected' WHERE seller_id=? AND rect_number=? AND state IN ('issued','exported','uploaded')").run(seller.id, num);
        logEvent(db, seller.id, 'rejected', { number: num, error: reason.slice(0, 120) });
        return json(res, 200, { ok: true });
      }
      if (p === '/api/pack') {
        const rows = db.prepare("SELECT number, issued_at, total, vat, json FROM invoices WHERE seller_id=? AND upload_status='ready' ORDER BY number LIMIT 2000").all(seller.id);
        if (!rows.length) return json(res, 404, { error: 'No invoices are waiting. Upload an order report first.' });
        // Closure trail: every issued correction travelling in this pack moves to 'exported'.
        db.prepare("UPDATE repairs SET state='exported' WHERE seller_id=? AND state='issued' AND rect_number IN (SELECT number FROM invoices WHERE seller_id=? AND upload_status='ready')").run(seller.id, seller.id);
        for (const r of rows) logEvent(db, seller.id, 'exported', { number: r.number }); // per-order evidence: the pack left us
        const safe = (x) => String(x ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60), cell = (v) => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
        const files = [], man = ['invoice_number,order_id,buyer,buyer_vat,issue_date,currency,total_incl_vat,vat,file'];
        for (const r of rows) { const inv = JSON.parse(r.json), name = `${safe(inv.orderId)}_${safe(r.number)}.pdf`; files.push({ name, data: await renderPdf(inv) }); man.push([r.number, inv.orderId, inv.buyer?.name, inv.buyer?.vat, String(inv.issueDate ?? '').slice(0, 10), inv.currency, r.total, r.vat, name].map(cell).join(',')); }
        files.push({ name: 'manifest.csv', data: Buffer.from('\uFEFF' + man.join('\r\n') + '\r\n') }, { name: 'HOW-TO-UPLOAD.txt', data: Buffer.from(PACK_HOWTO) });
        const zip = makeZip(files); res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="invoiceguard-pack-${new Date().toISOString().slice(0, 10)}.zip"`, 'cache-control': 'no-store', 'content-length': zip.length }); return res.end(zip);
      }
      if (p === '/api/sync') return json(res, 200, await sync(seller));
      if (p === '/api/dashboard') return json(res, 200, dashboard(seller));
      if (p === '/api/vat/check') { const v = await (validate.fresh ?? validate)(String(body.vat ?? '')); return json(res, 200, v); }
      const m = p.match(/^\/api\/invoices\/([A-Z]-\d{4}-\d{6})\/pdf$/);
      if (m) { const r = db.prepare('SELECT json FROM invoices WHERE seller_id=? AND number=?').get(seller.id, m[1]); if (!r) return json(res, 404, { error: 'not found' }); const pdf = await renderPdf(JSON.parse(r.json)); res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${m[1]}.pdf"` }); return res.end(pdf); }
      const mj = p.match(/^\/api\/invoices\/([A-Z]-\d{4}-\d{6})\/json$/);
      if (mj) { const r = db.prepare('SELECT json FROM invoices WHERE seller_id=? AND number=?').get(seller.id, mj[1]); return r ? json(res, 200, JSON.parse(r.json)) : json(res, 404, { error: 'not found' }); }
      if (p === '/api/rectify') {
        const { number, mode, reason } = body; const row = db.prepare('SELECT json FROM invoices WHERE seller_id=? AND number=?').get(seller.id, String(number));
        if (!row) return json(res, 404, { error: 'Invoice not found' });
        let changes; try { changes = applyEdits(JSON.parse(row.json), body); } catch (e) { return json(res, 400, { error: e.message }); }
        if (!changes.changed) return json(res, 400, { error: 'Nothing to correct. Change at least one field.' });
        if (mode === 'differences' && !changes.amountChanged) return json(res, 400, { error: 'The differences method needs an amount change. Use substitution for data-only corrections.' });
        let r; try { r = await issueRectificativa(db, seller, number, { mode: mode ?? 'substitution', reason, changes }, { api: apiFor(seller), validate }); } catch (e) { if (e?.busy) throw e; return json(res, 422, { error: e.message }); } // a refusal by a rule pack: shown to the user, not a server fault
        return json(res, 200, { number: r.rect.number, documentType: r.documentType });
      }
      if ((p === '/api/release' || p === '/api/retry') && (typeof body.key !== 'string' || !body.key || body.key.length > 200)) return json(res, 400, { error: 'Choose a shipment first.' });
      if (p === '/api/release') { // operator vouches for the buyer data after a name/census mismatch hold; recorded in the event log
        const row = db.prepare("SELECT reason FROM shipments WHERE seller_id=? AND key=? AND status='held'").get(seller.id, body.key); if (!row) return json(res, 404, { error: 'No held shipment with that key' });
        const id = /VIES registers/.test(row.reason) ? 'vies_name' : /AEAT census/.test(row.reason) ? 'census' : null; if (!id) return json(res, 400, { error: 'This hold cannot be released. Fix the underlying data instead.' });
        addOverride(db, seller.id, body.key, id, seller.email ?? seller.name); logEvent(db, seller.id, 'hold_released', { key: body.key, check: id });
        db.prepare("UPDATE shipments SET status='detected', reason=NULL WHERE seller_id=? AND key=?").run(seller.id, body.key); return json(res, 200, { ok: true });
      }
      if (p === '/api/retry') { // re-run a held shipment after the buyer fixed their VAT: clears hold so the next sync re-checks it
        { const r = db.prepare('SELECT buyer_vat FROM shipments WHERE seller_id=? AND key=?').get(seller.id, body.key); if (r?.buyer_vat) validate.forget?.(r.buyer_vat); } // the buyer fixed it: ask VIES again, do not reuse the old answer
        db.prepare("UPDATE shipments SET status='detected', reason=NULL WHERE seller_id=? AND key=? AND status IN ('held','error','rejected')").run(seller.id, body.key); return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) { if (e?.busy) return json(res, 503, { error: e.message }, { 'retry-after': '3' }); if (e?.status) return json(res, e.status, { error: e.message }); console.error('internal error', req.method, req.url, e?.stack || e); return json(res, 500, { error: 'Something went wrong on our side. Nothing was changed. Please try again.' }); }
  });
  server.requestTimeout = 60e3; server.headersTimeout = 15e3; server.keepAliveTimeout = 65e3;
  return { server, db, sync, stats: () => ({ inflight, ...hashQueueStats(), vies: validate.stats?.() }) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Last-resort net for the real server only: a stray error in a timer or an unawaited promise is logged instead of taking the whole service down.
  process.on('unhandledRejection', (e) => console.error('unhandled rejection (logged, process kept alive):', e?.stack || e));
  process.on('uncaughtException', (e) => console.error('uncaught exception (logged, process kept alive):', e?.stack || e));
  applyPendingRestore(process.env.DB_FILE ?? 'invoiceguard.db'); // before the database is opened
  const { server, db, sync } = createApp({ db: openDb(process.env.DB_FILE ?? 'invoiceguard.db') });
  // Automatic backups: a checkpoint-consistent snapshot on boot and every 6 h, kept on the same
  // volume (newest 14). Off-host copies stay an operator task - there is no free external storage
  // in this deployment, and we say so in the runbook instead of pretending.
  if (!process.env.BACKUPS_OFF) {
    const { backupNow, anchorLog } = await import('./backup.js');
    const snap = () => { try { const r = backupNow(process.env.DB_FILE ?? 'invoiceguard.db'); if (!r.ok) { console.error('backup skipped:', r.reason); return; } anchorLog(db); console.log(`backup: ${r.dest} (${r.bytes} bytes)`); } catch (e) { console.error('backup failed', e.message); } };
    setTimeout(snap, 60e3).unref(); setInterval(snap, 6 * 3600e3).unref();
  }
  const purge = () => { try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); } catch (e) { console.error('session purge failed', e.message); } };
  db.exec('CREATE TABLE IF NOT EXISTS contact_messages (id TEXT PRIMARY KEY, ts TEXT, email TEXT, message TEXT)');
  // Crash recovery: only repairs provably not issued return to the review queue; a repair whose
  // document was already created/submitted before the crash is held for human review instead of
  // blindly re-approvable (which would hit the idempotency guard and wedge the repair forever).
  try { recoverStuckRepairs(db); } catch { /* repairs table is created on first use */ }
  reconcileReportMarksAtBoot(db); // round-20: a crashed run cannot prove no newer report arrived - leftover in-flight marks become store_pending and block approvals until a successful store; a failure here fails boot loudly rather than leaving a gap
  // Documents caught in the crash window between Amazon accepting an upload and the local write of
  // its result ('sending') become 'unknown' with a human-visible hold; the next report settles them.
  // A claim younger than 10 minutes may belong to another live process (overlapping deploy): leave it, and sweep again once it is old enough.
  const UPLOAD_GRACE_MS = 10 * 60 * 1000;
  try { recoverUncertainUploads(db, { minAgeMs: UPLOAD_GRACE_MS }); } catch { /* invoices table is created on first use */ }
  const sweep = setTimeout(() => { try { recoverUncertainUploads(db, { minAgeMs: UPLOAD_GRACE_MS }); } catch { /* ignore */ } }, UPLOAD_GRACE_MS + 5000); sweep.unref?.();
  applyBootReset(db); rotateKeys(db, process.env.APP_SECRET ?? 'dev-secret-change-me', process.env.APP_SECRET_PREVIOUS); purgeSecLog(db); setInterval(() => { try { purgeSecLog(db); } catch (e) { console.error(e.message); } }, 24 * 3600e3).unref(); purge(); const piiPurge = () => { try { const n = purgeBuyerData(db); if (n) console.log(`buyer data removed from ${n} shipment record(s)`); } catch (e) { console.error('buyer-data purge failed', e.message); } }; piiPurge(); setInterval(piiPurge, 6 * 3600e3).unref(); setInterval(purge, 3600e3).unref();
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => console.log(`InvoiceGuard on http://localhost:${port}`));
  const recheck = async () => { try { const r = await checkSources(db); console.log(`rule re-check: ${r.length} sources, ${r.filter(x => x.missing.length).length} with missing anchor text`); } catch (e) { console.error('rule re-check failed', e.message); } };
  if (!process.env.NO_RULE_CHECK) { setTimeout(recheck, 30e3).unref(); setInterval(recheck, 24 * 3600e3).unref(); }
  setInterval(async () => { let all = []; try { all = db.prepare('SELECT * FROM sellers').all(); } catch (e) { console.error('watch list failed', e.message); } for (const s of all) { try { await F.watchRun(db, s, validateVat); } catch (e) { console.error('watch failed', e.message); } } }, 24 * 3600e3).unref();
  setInterval(async () => { // scheduler: Amazon's report is requested every 12 h in their SLA guidance; we poll hourly
    let sellers; try { sellers = db.prepare('SELECT s.*, c.mode AS conn_mode FROM sellers s JOIN amazon_conn c ON c.seller_id=s.id WHERE c.mode != ?').all('manual'); } catch (e) { console.error('scheduler query failed', e.message); return; } // a failure here must never take the process down
    for (const s of sellers) {
      // Real-data gate (critic round-8): a legacy live connection is never synced while the flag is unset.
      if (s.conn_mode === 'live' && env.ALLOW_LIVE_CONNECT !== '1') continue;
      try { await sync(s); } catch (e) { console.error('sync failed', s.id, e.message); } }
  }, 3600e3).unref();
}
