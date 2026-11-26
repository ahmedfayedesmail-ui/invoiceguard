// Round-11: external critic round-9 findings on 2be6158 + b1b358a.
// P1: VIDR-vs-feed priority conflict in syncInner(). processReport/processCorrections apply the
//   VIDR document-level verdict (InvoiceProcessing/CreditNoteProcessing -> 'processing'), then
//   pollFeeds ran over 'processing' documents and a FATAL feed flipped them back to unknown+hold,
//   a CANCELLED feed to rejected+retry - feed-level state erased document-level state. Fix: a
//   CURRENT VIDR processing verdict (vidr_processing_at) wins; a conflicting feed state is logged
//   as a feed_conflict event (evidence for a human), never a state change toward resend. The
//   verdict is cleared on every fresh upload attempt, so a stale verdict from a previous cycle
//   can never protect a retry's feed. Inverse direction preserved (G2): without a current VIDR
//   verdict, FATAL still means unknown + human hold.
// Hardening: apiFor checks ALLOW_LIVE_CONNECT before the client cache; /oauth/amazon/login and
//   /oauth/amazon/continue are gated while the feature is closed; the duplicate preflight names
//   the actual document numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, migrateAuth } from '../src/db.js';
import { processReport, pollFeeds } from '../src/pipeline.js';
import { createApp } from '../src/app.js';
import { listRepairs, approveRepair, proposeRejectedRetry } from '../src/repair.js';
import { encrypt } from '../src/auth.js';

const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'selR11', name: 'Test S.L.', nif: 'B1', address: 'x', country: 'ES' };
const vies = async (v) => ({ status: 'valid', vat: v });

function seedSeller(db) {
  migrateAuth(db);
  db.prepare('INSERT INTO sellers (id,name,nif,address,marketplace_ids,region,created_at,country) VALUES (?,?,?,?,?,?,?,?)')
    .run(seller.id, seller.name, seller.nif, seller.address, '["ES"]', 'EU', new Date().toISOString(), 'ES');
}
const withDesc = (head, row, patch) => {
  const c = head.split('\t'); const ix = (n) => c.indexOf(n); const r = [...row];
  while (r.length < c.length) r.push('');
  let desc = '';
  for (const [k, v] of Object.entries(patch)) { if (k === 'invoice-status-description') { desc = v ?? ''; continue; } r[ix(k)] = v; }
  r.push(desc); // invoice-status-description column
  return [head + '\tinvoice-status-description', r.join('\t')].join('\n');
};
const statusOf = (db, number) => db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, number)?.upload_status;
const vidrAt = (db, number) => db.prepare('SELECT vidr_processing_at FROM invoices WHERE seller_id=? AND number=?').get(seller.id, number)?.vidr_processing_at;
const events = (db, type, number) => db.prepare('SELECT detail FROM events WHERE seller_id=? AND type=?').all(seller.id, type).filter(e => !number || String(e.detail).includes(number));

// Upload the fixture's first shipment with a distinct feed id; every other feed reports DONE.
async function uploadFirst(db, targetFeed = 'feed-TARGET') {
  const uploads = [];
  const api = {
    uploadInvoice: async (a) => { uploads.push(a.number); return uploads.length === 1 ? targetFeed : 'feed-ok-' + uploads.length; },
    feedStatus: async (id) => id === targetFeed ? { status: 'FATAL', resultDocumentId: 'rdT' } : { status: 'DONE' },
    downloadFeedResult: async () => 'record-status\tmessage\nerror\tfeed died partway',
    listFeeds: async () => [],
  };
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT * FROM invoices WHERE seller_id=? AND kind='invoice' AND feed_id=?").get(seller.id, targetFeed);
  assert.ok(inv, 'the target invoice exists');
  return { api, uploads, inv };
}
const processingReport = () => {
  const [head, ...rows] = text.trim().split('\n');
  return withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceProcessing' });
};

// ---------- the P1: VIDR document-level verdict wins over feed-level state ----------

test('R9-1: VIDR InvoiceProcessing + feed FATAL -> document stays processing, no hold re-opened', async () => {
  const db = openDb(); seedSeller(db);
  const { api, uploads, inv } = await uploadFirst(db);
  // VIDR states document-level processing, then the SAME sync's feed poll sees the feed FATAL.
  await processReport(db, seller, processingReport(), { api, validate: vies });
  assert.equal(statusOf(db, inv.number), 'processing');
  assert.ok(vidrAt(db, inv.number), 'the verdict is recorded with its timestamp');
  const p = await pollFeeds(db, seller, api);
  assert.equal(statusOf(db, inv.number), 'processing', 'the feed FATAL must not erase the document-level state');
  assert.equal(p.conflicts, 1, 'the conflict is counted');
  assert.ok(!listRepairs(db, seller.id).some(r => r.event_key.includes(inv.number) || r.shipment_key === inv.shipment_key), 'no hold re-opened');
  assert.equal(events(db, 'feed_conflict', inv.number).length, 1, 'the conflict is logged as evidence');
  assert.equal(events(db, 'feed_result', inv.number).length, 1, 'the FATAL report is still fetched and logged as evidence');
  assert.equal(uploads.length, db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='invoice'").get(seller.id).c, 'nothing was resent');
});

test('R9-2: VIDR CreditNoteProcessing + feed FATAL -> credit note stays processing, never resent', async () => {
  const db = openDb(); seedSeller(db);
  const uploads = [];
  const api = { uploadInvoice: async (a) => { uploads.push(a.number); return 'feed-CN'; }, feedStatus: async () => ({ status: 'FATAL', resultDocumentId: 'rdC' }), downloadFeedResult: async () => 'error\tfatal', listFeeds: async () => [] };
  const inv = { number: 'A-2026-000001', rectifies: null };
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,json,feed_id,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(seller.id, inv.number, 'SHIPMENT:SH1', 'invoice', new Date().toISOString(), 121, 21, '{}', 'f0', 'uploaded');
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,rectifies,issued_at,total,vat,json,feed_id,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(seller.id, 'R-2026-000001', 'REFUND:TX9', 'rectificativa', 'A-2026-000001', new Date().toISOString(), -121, -21, '{}', 'feed-CN', 'submitted');
  const [head, ...rows] = text.trim().split('\n');
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'transaction-type': 'REFUND', 'transaction-id': 'TX9', 'invoice-status': 'CreditNoteProcessing' }), { api, validate: vies });
  assert.equal(statusOf(db, 'R-2026-000001'), 'processing');
  assert.ok(vidrAt(db, 'R-2026-000001'));
  const p = await pollFeeds(db, seller, api);
  assert.equal(statusOf(db, 'R-2026-000001'), 'processing', 'the credit note must not regress to unknown');
  assert.equal(p.conflicts, 1);
  assert.equal(uploads.length, 0, 'never resent');
  assert.ok(!listRepairs(db, seller.id).some(r => r.shipment_key === 'REFUND:TX9'), 'no hold re-opened');
  assert.equal(events(db, 'feed_conflict', 'R-2026-000001').length, 1);
});

test('R9-3: VIDR InvoiceProcessing + feed CANCELLED -> no automatic rejected, no retry proposal', async () => {
  const db = openDb(); seedSeller(db);
  const { api, inv } = await uploadFirst(db);
  await processReport(db, seller, processingReport(), { api, validate: vies });
  assert.equal(statusOf(db, inv.number), 'processing');
  const cancelled = { ...api, feedStatus: async (id) => ({ status: id === inv.feed_id ? 'CANCELLED' : 'DONE' }) };
  const p = await pollFeeds(db, seller, cancelled);
  assert.equal(statusOf(db, inv.number), 'processing', 'no automatic rejected from the feed side');
  assert.equal(p.conflicts, 1);
  assert.equal(p.rejected, 0);
  assert.equal(listRepairs(db, seller.id).length, 0, 'no retry proposal - the conflict is NOT resolved automatically');
  assert.equal(events(db, 'feed_conflict', inv.number).length, 1);
  assert.equal(events(db, 'confirmed_rejected', inv.number).length, 0);
});

// ---------- inverse direction: G2 discipline intact without a CURRENT VIDR verdict ----------

test('R9-4: processing from a DONE feed (NO VIDR verdict) + FATAL -> unknown + hold, as before', async () => {
  const db = openDb(); seedSeller(db);
  const { api, inv } = await uploadFirst(db);
  const done = { ...api, feedStatus: async (id) => ({ status: 'DONE' }) };
  await pollFeeds(db, seller, done);
  assert.equal(statusOf(db, inv.number), 'processing', 'feed DONE moves it to processing');
  assert.equal(vidrAt(db, inv.number), null, 'no VIDR verdict recorded');
  const p = await pollFeeds(db, seller, api); // target feed now FATAL
  assert.equal(statusOf(db, inv.number), 'unknown', 'without a current VIDR verdict the FATAL discipline stands');
  assert.ok(listRepairs(db, seller.id).some(r => r.kind === 'unknown_outcome' && r.shipment_key === inv.shipment_key), 'the human hold exists');
  assert.equal(p.conflicts, 0);
});

test('R9-5: a verdict from a PREVIOUS cycle never protects a retry - cleared on resubmission', async () => {
  const db = openDb(); seedSeller(db);
  const { api, inv } = await uploadFirst(db);
  await processReport(db, seller, processingReport(), { api, validate: vies });
  assert.ok(vidrAt(db, inv.number), 'cycle 1: verdict recorded');
  // Amazon then REJECTS the document (document-level) and the human approves the reviewed retry.
  const [head, ...rows] = text.trim().split('\n');
  await processReport(db, seller, withDesc(head, rows[0].split('\t'), { 'invoice-status': 'InvoiceRejected', 'invoice-status-description': 'Internal processing error' }), { api, validate: vies });
  assert.equal(statusOf(db, inv.number), 'rejected');
  const q = listRepairs(db, seller.id).find(r => r.kind === 'rejected_invoice');
  assert.ok(q, 'a reviewed retry was proposed');
  const api2 = { ...api, uploadInvoice: async () => 'feed-RETRY' };
  await approveRepair(db, seller, q.event_key, { api: api2, validate: vies });
  assert.equal(statusOf(db, inv.number), 'submitted', 'the retry resubmitted the same document');
  assert.equal(vidrAt(db, inv.number), null, 'the stale verdict was cleared on the fresh upload attempt');
  const p = await pollFeeds(db, seller, { ...api, feedStatus: async (id) => id === 'feed-RETRY' ? { status: 'FATAL', resultDocumentId: 'rdR' } : { status: 'DONE' } });
  assert.equal(statusOf(db, inv.number), 'unknown', 'the retry cycle gets the normal FATAL discipline');
  assert.ok(listRepairs(db, seller.id).some(r => r.kind === 'unknown_outcome'), 'the human hold exists again');
  assert.equal(p.conflicts, 0, 'no false protection from the stale verdict');
});

// ---------- hardening 1: apiFor checks the flag before the client cache ----------

const ENV_LIVE = { SPAPI_APP_ID: 'amzn1.sellerapps.app.TEST', SPAPI_CLIENT_ID: 'cid', SPAPI_CLIENT_SECRET: 'csec', SPAPI_REDIRECT_URI: 'https://ig.example/oauth/amazon/redirect' };
async function boot(env) {
  const oauthFetch = async () => ({ ok: true, json: async () => ({ refresh_token: 'Atzr|REFRESH' }) });
  const { server, db } = createApp({ validate: vies, secret: 'test-secret', env, oauthFetch });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) }); const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0]; let b = null; try { b = await r.json(); } catch { } return { status: r.status, body: b }; };
  await call('signup', { email: 'r11@x.es', password: 'Correct-Horse-42!' });
  await call('seller', { name: 'S', nif: 'B12345678', address: 'A', marketplaces: ['ES'], country: 'ES' });
  return { server, db, call, base };
}

test('R9-6: a warm apiFor cache never skips the flag check', async () => {
  const env = { ...ENV_LIVE, ALLOW_LIVE_CONNECT: '1' };
  const { server, db, call } = await boot(env);
  const sellerId = db.prepare('SELECT id FROM sellers LIMIT 1').get().id;
  db.prepare("INSERT INTO amazon_conn (seller_id,mode,secret_enc,connected_at) VALUES (?,?,?,?)")
    .run(sellerId, 'live', encrypt({ clientId: 'a', clientSecret: 'b', refreshToken: 'c', region: 'EU' }, 'test-secret'), new Date().toISOString());
  // Flag ON: a sync builds and caches the live client (the Amazon call itself fails on fake
  // credentials - what matters is the client is now warm in the cache).
  await call('sync', {});
  // Flag OFF: the very next apiFor call must be refused BEFORE the cache is consulted.
  env.ALLOW_LIVE_CONNECT = '0';
  const sellerRow = db.prepare('SELECT * FROM sellers WHERE id=?').get(sellerId);
  proposeRejectedRetry(db, sellerRow, { eventKey: 'REJECTED:SHIPMENT:X', kind: 'rejected_invoice', number: 'A-2026-000001', shipmentKey: 'SHIPMENT:X', action: 'retry_upload', reason: 'test' });
  const r = await call('repairs/approve', { key: 'REJECTED:SHIPMENT:X' });
  assert.match(String(r.body?.error ?? ''), /not open yet/, 'the flag decides, not the warm cache');
  server.close();
});

// ---------- hardening 1b: the Amazon-sent flow entries are gated too ----------

test('R9-7: /oauth/amazon/login and /oauth/amazon/continue are gated while the feature is closed', async () => {
  const { server, db, base } = await boot(ENV_LIVE); // oauth config available, flag unset
  const cb = encodeURIComponent('https://sellercentral-europe.amazon.com/apps/authorize/confirm/xyz');
  const r1 = await fetch(`${base}/oauth/amazon/login?amazon_callback_uri=${cb}&amazon_state=abc`, { redirect: 'manual' });
  const t1 = await r1.text();
  assert.match(t1, /not open yet/, 'login refuses to start the flow');
  assert.equal(db.prepare('SELECT count(*) c FROM oauth_pending').get().c, 0, 'no pending row was written while closed');
  const r2 = await fetch(`${base}/oauth/amazon/continue?t=whatever`, { redirect: 'manual' });
  assert.match(await r2.text(), /not open yet/, 'continue refuses too');
  server.close();
  // Sanity: with the flag ON the same login request starts the flow (proves the flag is the gate).
  const up = await boot({ ...ENV_LIVE, ALLOW_LIVE_CONNECT: '1' });
  const r3 = await fetch(`${up.base}/oauth/amazon/login?amazon_callback_uri=${cb}&amazon_state=abc`, { redirect: 'manual' });
  assert.equal(r3.status, 200);
  assert.equal(up.db.prepare('SELECT count(*) c FROM oauth_pending').get().c, 1, 'the flow starts when the flag is on');
  up.server.close();
});

// ---------- hardening 2: the duplicate preflight names the document numbers ----------

test('R9-8: the duplicate preflight names the actual document numbers', async () => {
  const f = `/tmp/ig-r11-${process.pid}.db`;
  let d2 = openDb(f);
  d2.exec('DROP INDEX uniq_invoice_per_shipment');
  const inv = (n) => d2.prepare("INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,json,upload_status) VALUES (?,?,?,?,?,1,0,'{}','uploaded')").run('s1', n, 'SHIPMENT:X', 'invoice', new Date().toISOString());
  inv('A-2026-000007'); inv('A-2026-000008');
  d2.close();
  assert.throws(() => openDb(f), /Refusing to start: duplicate financial documents.*A-2026-000007.*A-2026-000008/s, 'the diagnostics name the documents to resolve');
  try { (await import('node:fs')).unlinkSync(f); } catch { }
});
