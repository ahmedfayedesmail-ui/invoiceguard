// Round-10: external critic round-8 findings on 32d2266.
// G1 (P0): the live-Amazon gate was not comprehensive - oauth/start, the OAuth callback, sync()
//   and the hourly scheduler bypassed ALLOW_LIVE_CONNECT, so a legacy live connection or SP-API
//   env vars could reach Amazon with the flag unset. Fix: guards at oauth start AND callback AND
//   the apiFor execution choke point AND sync entry AND the scheduler.
// G2 (P0): a KNOWN FATAL feed (its id saved on the document) was excluded from the orphan
//   cross-check, so "VIDR still pending" could trigger a resend although the FATAL feed was never
//   resolved at document level. Fix: blocked_feed_id recorded on the document; the settle check
//   keeps the human hold until document-level evidence (CANCELLED feed, or a processing report
//   proving failure) lifts it.
// G3 (P1): unique-index migration failures were logged and boot continued unprotected. Fix:
//   duplicate preflight + fail fast + post-migration verification.
// A-series residual: first-invoice number allocation moved inside the issuance txImm - a
//   concurrent collision no longer burns an A number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, migrateAuth } from '../src/db.js';
import { processReport, settleUnknownDocuments, unknownSettleCheck } from '../src/pipeline.js';
import { createApp } from '../src/app.js';
import { listRepairs, decideRepair, proposeRejectedRetry } from '../src/repair.js';
import { encrypt } from '../src/auth.js';

const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'selR10', name: 'Test S.L.', nif: 'B1', address: 'x', country: 'ES' };
const vies = async (v) => ({ status: 'valid', vat: v });

function seedSeller(db) {
  migrateAuth(db);
  db.prepare('INSERT INTO sellers (id,name,nif,address,marketplace_ids,region,created_at,country) VALUES (?,?,?,?,?,?,?,?)')
    .run(seller.id, seller.name, seller.nif, seller.address, '["ES"]', 'EU', new Date().toISOString(), 'ES');
}
const withDesc = (head, row, patch) => {
  const c = head.split('\t'); const ix = (n) => c.indexOf(n); const r = [...row];
  while (r.length < c.length) r.push('');
  for (const [k, v] of Object.entries(patch)) r[ix(k)] = v;
  r.push(''); // invoice-status-description column
  return [head + '\tinvoice-status-description', r.join('\t')].join('\n');
};

// ---------- G1: the gate is comprehensive ----------
const ENV_LIVE = { SPAPI_APP_ID: 'amzn1.sellerapps.app.TEST', SPAPI_CLIENT_ID: 'cid', SPAPI_CLIENT_SECRET: 'csec', SPAPI_REDIRECT_URI: 'https://ig.example/oauth/amazon/redirect' }; // no ALLOW_LIVE_CONNECT
async function boot(env) {
  const calls = []; const oauthFetch = async (u, o) => { calls.push(String(u)); return { ok: true, json: async () => ({ refresh_token: 'Atzr|REFRESH' }) }; };
  const { server, db } = createApp({ validate: vies, secret: 'test-secret', env, oauthFetch });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) }); const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0]; let b = null; try { b = await r.json(); } catch { } return { status: r.status, body: b }; };
  await call('signup', { email: 'g@x.es', password: 'Correct-Horse-42!' });
  await call('seller', { name: 'S', nif: 'B12345678', address: 'A', marketplaces: ['ES'], country: 'ES' });
  return { server, db, call, base, sid: () => sid, calls };
}

test('G1: a legacy LIVE connection cannot sync while the flag is unset', async () => {
  const { server, db, call } = await boot(ENV_LIVE);
  db.prepare("INSERT INTO amazon_conn (seller_id,mode,secret_enc,connected_at) VALUES (?,?,?,?)")
    .run(db.prepare('SELECT id FROM sellers LIMIT 1').get().id, 'live', encrypt({ clientId: 'a', clientSecret: 'b', refreshToken: 'c', region: 'EU' }, 'test-secret'), new Date().toISOString());
  const r = await call('sync', {});
  assert.notEqual(r.status, 200);
  assert.match(String(r.body?.error ?? ''), /not open yet/);
  server.close();
});

test('G1: oauth start is refused while the flag is unset', async () => {
  const { server, call } = await boot(ENV_LIVE);
  const r = await call('amazon/oauth/start', { country: 'ES' });
  assert.equal(r.status, 403);
  assert.match(String(r.body?.error ?? ''), /not open yet/);
  server.close();
});

test('G1: the OAuth callback refuses to persist a live connection while the flag is unset', async () => {
  const { server, db, base, calls } = await boot(ENV_LIVE);
  const sellerId = db.prepare('SELECT id FROM sellers LIMIT 1').get().id;
  db.prepare('INSERT INTO oauth_state (token, seller_id, expires_at) VALUES (?,?,?)').run('state1', sellerId, Date.now() + 60e3);
  const r = await fetch(`${base}/oauth/amazon/redirect?state=state1&spapi_oauth_code=CODE1&selling_partner_id=A1`, { redirect: 'manual' });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0, 'Amazon token exchange must not even be attempted');
  assert.equal(db.prepare('SELECT count(*) c FROM amazon_conn').get().c, 0, 'no live connection saved');
  server.close();
});

// ---------- G2: a known FATAL feed blocks resend by itself ----------
function seedUnknownCorrection(db, opts = {}) {
  seedSeller(db);
  const s = { key: 'SHIPMENT:SH1', orderId: 'O1', shippingId: 'SH1', marketplace: 'ES', transactionId: 'SH1', billing: { name: 'Buyer SA', lines: ['Calle 1'], city: 'Madrid', postal: '28001', country: 'ES' }, buyerVat: null, buyerCompany: 'Buyer SA', shipCountry: 'ES', incl: 121, vat: 21, shipmentDate: '2026-11-20T00:00:00Z' };
  db.prepare(`INSERT INTO shipments (seller_id,key,order_id,shipping_id,buyer_vat,buyer,country,total,vat,shipment_date,due_at,status,reason,raw,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(seller.id, s.key, s.orderId, s.shippingId, null, s.buyerCompany, 'ES', 121, 21, s.shipmentDate, null, 'uploaded', null, JSON.stringify(s), new Date().toISOString());
  const inv = { number: 'A-2026-000001', type: 'invoice', series: 'A', issueDate: '2026-11-20', operationDate: '2026-11-20', orderId: 'O1', buyer: { name: 'Buyer SA', vat: null, address: ['Calle 1'] }, buyerCountry: 'ES', seller: { name: 'Test S.L.', nif: 'B1', address: 'x' }, currency: 'EUR', langs: ['es'], lines: [{ description: 'W', sku: 'S', qty: 1, unitExcl: 100, excl: 100, vat: 21, rate: 21 }], totals: { excl: 100, vat: 21, incl: 121 } };
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,json,feed_id,upload_status) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(seller.id, inv.number, s.key, 'invoice', new Date().toISOString(), 121, 21, JSON.stringify(inv), 'f0', 'uploaded');
  const rect = { ...inv, number: 'R-2026-000001', type: 'rectificativa', series: 'R', rectifies: { number: 'A-2026-000001' }, totals: { excl: -100, vat: -21, incl: -121 } };
  const sendingAt = new Date(Date.now() - 3600e3).toISOString();
  db.prepare('INSERT INTO invoices (seller_id,number,shipment_key,kind,rectifies,issued_at,total,vat,json,feed_id,upload_status,blocked_feed_id,sending_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(seller.id, rect.number, 'REFUND:TX9', 'rectificativa', 'A-2026-000001', new Date().toISOString(), -121, -21, JSON.stringify(rect), 'feed-F1', 'unknown', opts.blocked === undefined ? 'feed-F1' : opts.blocked, sendingAt);
  log_event(db);
  return rect.number;
}
function log_event(db) { // the recovery event the settle check anchors on
  db.prepare('INSERT INTO events (ts, seller_id, type, detail) VALUES (?,?,?,?)').run(new Date(Date.now() - 3500e3).toISOString(), seller.id, 'upload_unknown_outcome', JSON.stringify({ number: 'R-2026-000001', error: 'feed feed-F1 ended FATAL' }));
}
const pendingReport = () => { // VIDR still lists the credit note as due
  const [head, ...rows] = text.trim().split('\n');
  return withDesc(head, rows[0].split('\t'), { 'transaction-type': 'REFUND', 'transaction-id': 'TX9', 'invoice-status': 'CreditNotePending' });
};

test('G2 (his verbatim scenario): known FATAL feed + VIDR still Pending + same FATAL feed in the list -> NO resend', async () => {
  const db = openDb(); const rectNumber = seedUnknownCorrection(db);
  const uploads = [];
  const api = {
    uploadInvoice: async (a) => { uploads.push(a.number); return 'feed-NEW'; },
    feedStatus: async () => ({ status: 'FATAL' }),
    listFeeds: async () => [{ feedId: 'feed-F1', status: 'FATAL', createdTime: new Date(Date.now() - 3500e3).toISOString() }],
  };
  const out = await settleUnknownDocuments(db, seller, pendingReport(), { api, validate: vies });
  assert.deepEqual(out.resubmitted, [], 'nothing resent');
  assert.ok(out.waiting.includes(rectNumber));
  assert.equal(uploads.length, 0, 'no upload reached Amazon');
  const block = await unknownSettleCheck(db, seller, api, rectNumber);
  assert.match(String(block), /never resolved at document level/);
});

test('G2 (round-10c contract): report text NEVER lifts the block - only CANCELLED or a human', async () => {
  const apiF = { uploadInvoice: async () => 'feed-N', feedStatus: async () => ({ status: 'FATAL', resultDocumentId: 'doc1' }), listFeeds: async () => [] };
  // CANCELLED: the feed provably never ran -> the SAME document is resent.
  let db = openDb(); const n1 = seedUnknownCorrection(db);
  const apiC = { uploadInvoice: async () => 'feed-N', feedStatus: async () => ({ status: 'CANCELLED' }), listFeeds: async () => [{ feedId: 'feed-F1', status: 'CANCELLED', createdTime: new Date(Date.now() - 3500e3).toISOString() }] };
  const out1 = await settleUnknownDocuments(db, seller, pendingReport(), { api: apiC, validate: vies });
  assert.deepEqual(out1.resubmitted, [n1]);
  // Every report phrasing - including a genuine failure verdict, every reviewer repro, and
  // realistic layouts - keeps the hold with ZERO uploads. Report text is human evidence only.
  for (const [label, line] of [
    ['genuine failure verdict', (n) => `original-doc-id\tdoc-id\terror-code\nTX9\t${n}\terror: totals mismatch - record failed`],
    ['accepted', (n) => `TX9\t${n}\taccepted successfully`],
    ['zero error count', (n) => `${n}\tprocessed successfully, 0 errors`],
    ['negated errors', (n) => `${n}\tcompleted - no errors found`],
    ['mixed markers', (n) => `${n}\taccepted; earlier errors corrected`],
    ['reversed negation (reviewer repro)', (n) => `${n}\tOK\tErrors: 0`],
    ['validation none (reviewer repro)', (n) => `${n}\tvalidation errors: none`],
    ['TSV layout (reviewer repro)', (n) => `OK\t${n} Errors: 0`],
    ['ambiguous', (n) => `processing summary for batch ${n}`],
  ]) {
    const db2 = openDb(); const n = seedUnknownCorrection(db2); const uploads = [];
    const api = { ...apiF, uploadInvoice: async () => { uploads.push(n); return 'feed-N'; } };
    db2.prepare('INSERT INTO events (ts, seller_id, type, detail) VALUES (?,?,?,?)').run(new Date().toISOString(), seller.id, 'feed_result', JSON.stringify({ number: n, feedId: 'feed-F1', report: line(n) }));
    const out = await settleUnknownDocuments(db2, seller, pendingReport(), { api, validate: vies });
    assert.deepEqual(out.resubmitted, [], `${label}: report text must never lift the block`);
    assert.equal(uploads.length, 0, `${label}: nothing reached Amazon`);
  }
  // The human path: dismiss the hold after checking Seller Central -> the next sync resends.
  db = openDb(); const n3 = seedUnknownCorrection(db);
  proposeRejectedRetry(db, seller, { eventKey: 'UNKNOWN:REFUND:TX9', kind: 'unknown_outcome', number: n3, originalNumber: 'A-2026-000001', shipmentKey: 'REFUND:TX9', rectNumber: n3, action: 'hold', reason: 'test hold' });
  const hold = listRepairs(db, seller.id).find(r => r.kind === 'unknown_outcome');
  decideRepair(db, seller.id, hold.event_key, 'dismissed');
  const out3 = await settleUnknownDocuments(db, seller, pendingReport(), { api: apiF, validate: vies });
  assert.deepEqual(out3.resubmitted, [n3], 'a human dismissal clears the same-document resend');
});

test('G2: a crash-window document (no blocking feed recorded) still uses the orphan cross-check', async () => {
  const db = openDb(); const rectNumber = seedUnknownCorrection(db, { blocked: null });
  const api = { uploadInvoice: async () => 'feed-N', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [{ feedId: 'feed-ORPHAN', status: 'DONE', createdTime: new Date(Date.now() - 3500e3).toISOString() }] };
  const out = await settleUnknownDocuments(db, seller, pendingReport(), { api, validate: vies });
  assert.deepEqual(out.resubmitted, [], 'orphan feed in the window blocks resend');
  assert.ok((await unknownSettleCheck(db, seller, api, rectNumber)).includes('feed-ORPHAN'));
});

// ---------- G3: migration never starts unprotected ----------
test('G3: fresh databases get both indexes; a legacy duplicate fails fast with diagnostics', async () => {
  const db = openDb(); migrateAuth(db);
  for (const idx of ['uniq_invoice_per_shipment', 'uniq_rect_per_event'])
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(idx), idx);
  // Simulate a legacy DB that predates the indexes and already holds a duplicate: the migration
  // lives in openDb, so re-opening the same file must fail fast with diagnostics.
  const f = `/tmp/ig-r10-${process.pid}.db`;
  let d2 = openDb(f);
  d2.exec('DROP INDEX uniq_invoice_per_shipment');
  const inv = (n) => d2.prepare("INSERT INTO invoices (seller_id,number,shipment_key,kind,issued_at,total,vat,json,upload_status) VALUES (?,?,?,?,?,1,0,'{}','uploaded')").run('s1', n, 'SHIPMENT:X', 'invoice', new Date().toISOString());
  inv('A-2026-000001'); inv('A-2026-000002');
  d2.close();
  assert.throws(() => openDb(f), /Refusing to start.*duplicate financial documents/s);
  try { (await import('node:fs')).unlinkSync(f); } catch { }
});

// ---------- A-series: concurrent issue burns no number ----------
test('A-series: two overlapping syncs issue ONE invoice per shipment and the counter has no gap', async () => {
  const db = openDb(); seedSeller(db);
  const uploads = [];
  const api = { requestVidr: async () => 'r', waitReport: async () => 'd', downloadReport: async () => text, uploadInvoice: async (a) => { uploads.push(a.number); return 'feed-' + uploads.length; }, feedStatus: async () => ({ status: 'DONE' }) };
  await Promise.allSettled([processReport(db, seller, text, { api, validate: vies }), processReport(db, seller, text, { api, validate: vies })]);
  const invs = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number").all(seller.id).map(r => r.number);
  const counter = db.prepare("SELECT n FROM counters WHERE seller_id=? AND series='A'").get(seller.id)?.n ?? 0;
  assert.equal(counter, invs.length, `counter ${counter} vs invoices ${JSON.stringify(invs)} - a collision burned a number`);
  assert.equal(uploads.length, invs.length, 'each issued invoice uploaded exactly once');
});
