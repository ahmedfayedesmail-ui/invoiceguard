// Round-22: external critic round-19 on 6829050 - manual-upload protection timing + VIDR-only release.
// P1: the in-flight/store-pending protection is recorded and the VIDR stored the moment a manual
//     report is accepted, BEFORE processReport's first await; a concurrent approval is refused.
// P2: an Order Report never touches the stored VIDR snapshot or releases a block.
// Note: detectRepairs errors are no longer swallowed by the manual path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { openDb, currentAttemptSeq, nextReportGen } from '../src/db.js';
import { detectRepairs, listRepairs, recordReportSnapshot, latestReportSnapshot, ensureRepairTables } from '../src/repair.js';

const HEAD = ['order-id', 'order-item-id', 'purchase-date', 'buyer-name', 'sku', 'product-name', 'quantity-purchased', 'currency', 'item-price', 'item-tax', 'shipping-price', 'shipping-tax', 'item-promotion-discount', 'ship-promotion-discount', 'recipient-name', 'ship-address-1', 'ship-city', 'ship-postal-code', 'ship-country', 'sales-channel', 'buyer-company-name', 'buyer-tax-registration-type', 'buyer-tax-registration-country', 'buyer-tax-registration-id'];
const row = (o) => HEAD.map(h => o[h] ?? '').join('\t');
const base = { 'order-item-id': '1', 'purchase-date': '2026-11-20T10:00:00+00:00', 'buyer-name': 'Ann', sku: 'S1', 'product-name': 'Widget', 'quantity-purchased': '2', currency: 'EUR', 'item-price': '121.00', 'item-tax': '21.00', 'shipping-price': '0', 'shipping-tax': '0', 'recipient-name': 'Ann', 'ship-address-1': 'Calle 1', 'ship-city': 'Madrid', 'ship-postal-code': '28001', 'ship-country': 'ES', 'sales-channel': 'Amazon.es', 'buyer-company-name': 'Cliente SL', 'buyer-tax-registration-type': 'VAT', 'buyer-tax-registration-country': 'ES', 'buyer-tax-registration-id': 'B12345674' };
const file = (...rs) => [HEAD.join('\t'), ...rs.map(r => row({ ...base, ...r }))].join('\n');

const vidrText = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
function refundReport(scale = 1) {
  const [head, ...rows] = vidrText.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const ref = rows[0].split('\t'); ref[ix('transaction-type')] = 'REFUND'; ref[ix('transaction-id')] = 'r-100-1'; ref[ix('invoice-status')] = 'CreditNotePending';
  ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { ref[ix(n)] = String(-Math.abs(Number(ref[ix(n)])) * scale); });
  return [head, ref.join('\t')].join('\n');
}

async function boot(validate) {
  const db = openDb();
  const { server } = createApp({ db, validate, secret: 'test', env: { ALLOW_MANUAL_UPLOAD: '1' } }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) }); const sc = r.headers.get('set-cookie'); if (sc) sid = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) }; };
  await call('signup', { email: 'r19@x.es', password: 'Long-Enough-Pw-42!' });
  await call('seller', { name: 'Tienda Demo S.L.', nif: 'b11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] });
  await call('amazon/connect', { manual: true });
  return { db, server, call, seller: db.prepare('SELECT * FROM sellers').get() };
}
const rectCount = (db) => db.prepare("SELECT count(*) c FROM invoices WHERE kind='rectificativa'").get().c;

async function seedProposal(env) {
  const { db, call, seller } = env;
  assert.equal((await call('manual/issue', { text: vidrText, attest: true })).status, 200, 'baseline VIDR upload');
  const gen = nextReportGen(db, seller.id);
  detectRepairs(db, seller, refundReport(), { reportAttemptSeq: currentAttemptSeq(db, seller.id), reportRequestedAt: new Date().toISOString(), reportGen: gen });
  recordReportSnapshot(db, seller.id, { gen, seq: currentAttemptSeq(db, seller.id), requestedAt: new Date().toISOString(), text: refundReport() });
  const [p] = listRepairs(db, seller.id); assert.ok(p, 'a proposal exists');
  return p;
}

test('R19-1 (P1): a concurrent approval DURING a slow manual VIDR is refused; the report is stored early; in_flight lifts after processing', async () => {
  let gate = null;
  const env = await boot(async (v) => { if (gate) await gate.promise; return { status: 'valid', vat: v }; });
  const { db, server, call, seller } = env;
  const p = await seedProposal(env);
  let open; gate = { promise: new Promise(r => { open = r; }) };
  // A NEW shipment (new ids) so processReport must verify the buyer VAT and therefore awaits the gated validator.
  const newText = vidrText.replaceAll('S1001', 'S9999').replaceAll('405-3318842-7710365', '405-3318842-7710999').replaceAll('FALSE\tInvoicePending', 'FALSE\tInvoicePending');
  const slow = call('manual/issue', { text: newText, attest: true });
  let snap; for (let i = 0; i < 100; i++) { snap = latestReportSnapshot(db, seller.id); if (snap?.in_flight) break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(snap.in_flight, 1, 'the mark was recorded while processReport is still awaiting');
  assert.equal(snap.text, newText, 'the new VIDR was stored EARLY, before processing finished');
  const during = await call('repairs/approve', { key: p.event_key });
  assert.equal(during.status, 422); assert.match(during.body.error, /sync is running/);
  assert.equal(rectCount(db), 0, 'nothing issued during the delay');
  open(); const done = await slow; assert.equal(done.status, 200);
  assert.equal(latestReportSnapshot(db, seller.id).in_flight, 0, 'lifted after processing');
  assert.equal(rectCount(db), 0);
  server.closeAllConnections(); server.close();
});

test('R19-2 (P2): an Order Report upload never replaces the stored VIDR snapshot nor releases a block', async () => {
  const env = await boot(async (v) => ({ status: 'valid', vat: v }));
  const { db, server, call, seller } = env;
  await seedProposal(env);
  const before = latestReportSnapshot(db, seller.id);
  db.prepare('UPDATE report_snapshots SET in_flight=1, store_pending=1 WHERE seller_id=?').run(seller.id); // a standing crash block
  const r = await call('manual/issue', { text: file({ 'order-id': 'ORD-1' }), attest: true, useDeliveryAddress: true });
  assert.equal(r.status, 200);
  const after = latestReportSnapshot(db, seller.id);
  assert.equal(after.text, before.text, 'the stored VIDR is untouched');
  assert.equal(after.gen, before.gen, 'and its generation');
  assert.equal(after.store_pending, 1, 'the block is NOT released by an Order Report');
  assert.equal(after.in_flight, 1);
  server.closeAllConnections(); server.close();
});

test('R19-3: a failed VIDR store answers 500 BEFORE issuing anything, and keeps the block', async () => {
  const env = await boot(async (v) => ({ status: 'valid', vat: v }));
  const { db, server, call, seller } = env;
  ensureRepairTables(db);
  db.exec("CREATE TRIGGER fail_store BEFORE INSERT ON report_snapshots BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  db.exec("CREATE TRIGGER fail_store_u BEFORE UPDATE ON report_snapshots BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  const r = await call('manual/issue', { text: vidrText, attest: true });
  assert.equal(r.status, 500); assert.match(r.body.error, /nothing was issued/);
  assert.equal(db.prepare('SELECT count(*) c FROM invoices').get().c, 0, 'no invoice was issued');
  server.closeAllConnections(); server.close();
});

test('R20-1 (critic round-20 P2): processReport succeeds, then proposal detection fails on a DB error - the response says the invoices WERE recorded and the report is stored; in_flight cleared; protection intact', async () => {
  const env = await boot(async (v) => ({ status: 'valid', vat: v }));
  const { db, server, call, seller } = env;
  ensureRepairTables(db);
  db.exec("CREATE TRIGGER fail_repairs BEFORE INSERT ON repairs BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  const [head, ...rows] = vidrText.trim().split('\n');
  const withRefund = [head, rows[0], refundReport().split('\n')[1]].join('\n'); // a shipment (issues an invoice) + a refund row (makes detectRepairs insert)
  const r = await call('manual/issue', { text: withRefund, attest: true });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /invoices from this upload were recorded/);
  assert.match(r.body.error, /report itself is stored/);
  assert.doesNotMatch(r.body.error, /Nothing was changed/);
  assert.equal(r.body.suggestionsFailed, true); assert.ok(r.body.issued >= 1, 'the response reports the issued invoices');
  assert.ok(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind != 'rectificativa'").get(seller.id).c >= 1, 'the invoice really was recorded');
  const snap = latestReportSnapshot(db, seller.id);
  assert.equal(snap.text, withRefund, 'the report is stored'); assert.equal(snap.in_flight, 0, 'in_flight was cleared'); assert.equal(snap.store_pending, 0);
  // Protection intact: the stored report carries a generation, so any older proposal is revalidated against it at approval (the freshness gate proven in round17/18 tests).
  assert.ok(snap.gen > 0, 'the stored report has a generation');
  assert.equal(rectCount(db), 0, 'no credit note issued');
  server.closeAllConnections(); server.close();
});
