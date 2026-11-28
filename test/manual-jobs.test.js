// api-load F1 (owner 18:48 ruling): POST /api/manual/issue enqueues a background job (202 + job
// id), a chunked in-process worker keeps the event loop responsive, GET /api/manual/jobs/:id
// reports status + progress + final result, and the results match the synchronous path exactly
// (same invoices, holds, idempotency). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { runManualIssue, enqueueJob, migrateJobs, getJob } from '../src/manual-jobs.js';
import { issueAndWait } from './helpers/issue-job.mjs';

const HEAD = ['order-id', 'order-item-id', 'shipping-id', 'fulfilled-by', 'order-date', 'marketplace-id', 'recipient-name', 'buyer-name', 'ship-country', 'shipment-date', 'billing-name', 'bill-address-1', 'bill-city', 'bill-postal-code', 'bill-country', 'ship-from-country', 'sku', 'product-name', 'quantity-purchased', 'currency', 'item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'item-vat-rate', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount', 'shipping-vat-rate', 'transaction-id', 'transaction-type', 'is-amazon-invoiced', 'invoice-status', 'is-business-order', 'seller-vat-number', 'buyer-vat-number', 'buyer-company-name', 'buyer-tax-registration-type', 'citation-es'];
const rowOf = (i, over = {}) => {
  const id = String(i);
  const r = { 'order-id': '405-' + id + '-7710365', 'order-item-id': '', 'shipping-id': 'S' + id, 'fulfilled-by': 'MFN', 'order-date': '', 'marketplace-id': 'ES', 'recipient-name': '', 'buyer-name': '', 'ship-country': 'ES', 'shipment-date': '2026-11-24T08:00:00Z', 'billing-name': 'Buyer SL ' + id, 'bill-address-1': 'Calle Mayor 12', 'bill-city': 'Valencia', 'bill-postal-code': '46001', 'bill-country': 'ES', 'ship-from-country': 'ES', sku: 'SKU-A', 'product-name': 'Cable HDMI 2.1 2m', 'quantity-purchased': '2', currency: 'EUR', 'item-vat-incl-amount': '48.40', 'item-vat-amount': '8.40', 'item-vat-excl-amount': '40.00', 'item-vat-rate': '0.21', 'shipping-vat-incl-amount': '6.05', 'shipping-vat-amount': '1.05', 'shipping-vat-excl-amount': '5.00', 'shipping-vat-rate': '0.21', 'transaction-id': 'S' + id, 'transaction-type': 'SHIPMENT', 'is-amazon-invoiced': 'FALSE', 'invoice-status': 'InvoicePending', 'is-business-order': 'TRUE', 'seller-vat-number': 'ESB11111119', 'buyer-vat-number': 'ESB12345674', 'buyer-company-name': 'Buyer SL ' + id, 'buyer-tax-registration-type': 'VAT', 'citation-es': '', ...over };
  return HEAD.map(h => r[h]).join('\t');
};
const vidrOf = (n, start = 1000000) => [HEAD.join('\t'), ...Array.from({ length: n }, (_, i) => rowOf(start + i))].join('\n');

async function boot(email) {
  const db = openDb();
  const { server } = createApp({ db, secret: 'test', validate: async (v) => ({ status: 'valid', vat: v }), env: { ALLOW_MANUAL_UPLOAD: '1' } });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) }); const sc = r.headers.get('set-cookie'); if (sc) sid = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) }; };
  await call('signup', { email, password: 'Long-Enough-Pw-42!' });
  await call('seller', { name: 'Tienda Demo S.L.', nif: 'b11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] });
  await call('amazon/connect', { manual: true });
  return { db, server, call, seller: db.prepare('SELECT * FROM sellers').get() };
}

test('F1: 3000-row issue answers 202 fast, the loop stays responsive, and the result matches the synchronous path', async () => {
  const text = vidrOf(3000);
  const a = await boot('f1-a@x.es');
  const t0 = Date.now();
  const r = await a.call('manual/issue', { text, attest: true });
  const postMs = Date.now() - t0;
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.ok(r.body.jobId, 'a job id');
  assert.ok(postMs < 2000, `POST answered in ${postMs} ms (limit 2000)`);
  let maxLag = 0, done = null; const t1 = Date.now();
  for (;;) {
    const t = Date.now();
    const j = await a.call('manual/jobs/' + r.body.jobId);
    maxLag = Math.max(maxLag, Date.now() - t);
    if (j.body.status === 'done' || j.body.status === 'error') { done = j.body; break; }
    if (Date.now() - t1 > 120000) assert.fail('job did not finish in 120 s');
    await new Promise(r2 => setTimeout(r2, 25));
  }
  assert.ok(maxLag < 500, `worst loop-lag probe while processing: ${maxLag} ms (limit 500)`);
  assert.equal(done.status, 'done', JSON.stringify(done.result).slice(0, 300));
  assert.equal(done.result.issued, 3000);
  assert.equal(done.result.heldNow, 0);
  assert.equal(done.result.errors, 0);
  assert.equal(done.result.willIssue, 3000);
  // Equivalence with the synchronous path (same function without pacing): same invoices and shipments.
  const b = await boot('f1-b@x.es');
  const direct = await runManualIssue(b.db, b.seller, text, { validate: async (v) => ({ status: 'valid', vat: v }) });
  assert.equal(direct.status, 200);
  assert.equal(direct.body.issued, done.result.issued);
  assert.equal(direct.body.heldNow, done.result.heldNow);
  assert.equal(direct.body.skippedAlready, done.result.skippedAlready);
  const invA = a.db.prepare("SELECT number, shipment_key, total, vat, upload_status FROM invoices WHERE kind='invoice' ORDER BY number").all();
  const invB = b.db.prepare("SELECT number, shipment_key, total, vat, upload_status FROM invoices WHERE kind='invoice' ORDER BY number").all();
  assert.deepEqual(invA, invB);
  const shipA = a.db.prepare('SELECT key, status, reason FROM shipments ORDER BY key').all();
  const shipB = b.db.prepare('SELECT key, status, reason FROM shipments ORDER BY key').all();
  assert.deepEqual(shipA, shipB);
  a.server.close(); b.server.close();
});

test('F1: holds and duplicate-issue protection are preserved; a job is tenant-scoped', async () => {
  const text = [HEAD.join('\t'), rowOf(1), rowOf(2), rowOf(3, { 'is-business-order': '' })].join('\n'); // 2 issuable + 1 UNKNOWN flag -> held
  const a = await boot('f1-c@x.es');
  const first = await issueAndWait(a.call, { text, attest: true });
  assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300));
  assert.equal(first.body.issued, 2);
  assert.equal(first.body.heldNow, 1);
  assert.match(first.body.held[0].reason, /is-business-order/);
  const again = await issueAndWait(a.call, { text, attest: true });
  assert.equal(again.status, 200);
  assert.equal(again.body.issued, 0, 're-uploading the same report issues nothing twice');
  assert.equal(again.body.skippedAlready, 2);
  assert.equal(again.body.heldNow, 1);
  assert.equal(a.db.prepare("SELECT count(*) c FROM invoices WHERE kind='invoice'").get().c, 2, 'no duplicate invoices');
  // Tenant isolation: another seller cannot read the job.
  const b = await boot('f1-d@x.es');
  const posted = await a.call('manual/issue', { text, attest: true });
  assert.equal(posted.status, 202);
  assert.equal((await b.call('manual/jobs/' + posted.body.jobId)).status, 404);
  await issueAndWait(a.call, { text, attest: true });
  a.server.close(); b.server.close();
});

test('F1: validation and error surfacing (attest, bad format, restart recovery)', async () => {
  const a = await boot('f1-e@x.es');
  assert.equal((await a.call('manual/issue', { text: 'x' })).status, 400, 'attest is still required up front');
  const bad = await a.call('manual/issue', { text: 'hello world', attest: true });
  assert.equal(bad.status, 202);
  const j = await issueAndWait(a.call, { text: 'a,b,c\n1,2,3', attest: true });
  assert.equal(j.status, 400);
  assert.match(j.body.error, /tab-separated/);
  a.server.close();
  // Restart recovery: a job left queued or running is failed loudly, its text dropped.
  const db = openDb(); migrateJobs(db);
  const seller = { id: 's1' };
  db.prepare('INSERT INTO sellers (id, name) VALUES (?, ?)').run('s1', 'S');
  const id1 = enqueueJob(db, seller, 'x');
  const id2 = enqueueJob(db, seller, 'y');
  db.prepare("UPDATE manual_jobs SET status='running' WHERE id=?").run(id2);
  migrateJobs(db); // a second boot: interrupted jobs must not be retried silently
  for (const id of [id1, id2]) {
    const j = getJob(db, seller, id);
    assert.equal(j.status, 'error');
    assert.match(j.error, /interrupted by a server restart/);
    assert.equal(db.prepare('SELECT report_text FROM manual_jobs WHERE id=?').get(id).report_text, null, 'the stored report text is dropped with the terminal state');
  }
});
