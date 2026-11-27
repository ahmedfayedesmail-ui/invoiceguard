// Gap tests found while inventorying every reader of is-amazon-invoiced and is-business-order (docs/FLAG-READERS-INVENTORY.md). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/loop/sha256.js';
import { project } from '../src/loop/project.js';
import * as F from '../tools/make-loop-fixtures.mjs';
import { createApp } from '../src/app.js';

const imp = (id, kind, text, declared, importedAt, profile) => ({ id, kind, text, declared, importedAt, fileName: id, sha256: sha256(text), profile });
const V = (text) => imp('v', 'vidr', text, F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z');
const L = (text) => imp('l1', 'ledger', text, F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), '2026-11-21T11:01:00Z', F.PROFILE);
const set = (text, name, value) => { const h = text.split('\n')[0].split('\t'), i = h.indexOf(name); return text.split('\n').map((l, k) => { if (k !== 1) return l; const c = l.split('\t'); c[i] = value; return c.join('\t'); }).join('\n'); };
const one = (status = 'InvoiceUploaded') => F.vidr([{ n: 1, status, num: 'AMZ-1' }]);
const confident = (r) => r.issues.filter(i => i.state === 'ACTION_REQUIRED');

for (const [label, text] of [['is-amazon-invoiced BLANK', set(one(), 'is-amazon-invoiced', '')], ['is-business-order BLANK', set(one(), 'is-business-order', '')], ['both BLANK', set(set(one(), 'is-business-order', ''), 'is-amazon-invoiced', '')], ['is-amazon-invoiced CONFLICT (TRUE with InvoiceUploaded)', set(one(), 'is-amazon-invoiced', 'TRUE')], ['is-amazon-invoiced UNREADABLE', set(one(), 'is-amazon-invoiced', 'banana')]]) {
  test(`loop, ledger side: a books document for an order whose flag is unknown (${label}) raises no UNMATCHED_DOCUMENT, no confident finding and no closure`, () => {
    const books = F.ledger([F.L.row('AMZ-1', '2026-11-18', '2026-11-17', F.O(1)), F.L.row('X-OTHER', '2026-11-18', '2026-11-17', F.O(99))]);
    const r = project({ imports: [V(text), L(books)], events: [] });
    assert.deepEqual(confident(r).filter(i => i.subject?.orderId === F.O(1) || i.family === 'UNMATCHED_DOCUMENT' && /AMZ-1/.test(JSON.stringify(i.subject))).map(i => i.family), []);
    assert.ok(!r.issues.some(i => i.state === 'VERIFIED_CLOSED'), 'nothing is closed on an unknown flag');
  });
}
test('loop: both flags BLANK is one undetermined transaction counted once, in no scope figure', () => {
  const r = project({ imports: [V(set(set(one('InvoicePending'), 'is-business-order', ''), 'is-amazon-invoiced', '')), L(F.ledger([F.L.row('X', '2026-11-18', '2026-11-17', F.O(99))]))], events: [] });
  assert.equal(r.coverage.undetermined.count, 1); assert.equal(r.coverage.scope.count, 0); assert.equal(r.coverage.outsideScope.byReason.AMAZON_INVOICED, 0);
  assert.equal(r.coverage.transactionsTotal, r.coverage.scope.count + r.coverage.undetermined.count + r.coverage.outsideScope.count);
});
test('app route: a seller declaration sent to the route is ignored, real booleans or not: the Order Report stays held and nothing can be issued from it', async () => {
  const { server } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test', env: { ALLOW_MANUAL_UPLOAD: '1' } }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(base + '/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: JSON.stringify(body) }); const c = r.headers.get('set-cookie'); if (c) sid = c.split(';')[0]; return { status: r.status, body: await r.json() }; };
  await call('signup', { email: 'inv@x.es', password: 'Long-Enough-Pw-42!' }); await call('seller', { name: 'Tienda Demo S.L.', nif: 'b11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] }); await call('amazon/connect', { manual: true });
  const H = ['order-id', 'order-item-id', 'purchase-date', 'buyer-name', 'sku', 'product-name', 'quantity-purchased', 'currency', 'item-price', 'item-tax', 'recipient-name', 'ship-address-1', 'ship-city', 'ship-postal-code', 'ship-country', 'sales-channel', 'buyer-company-name', 'buyer-tax-registration-id', 'buyer-tax-registration-country'];
  const v = ['M1', '1', '2026-11-20T10:00:00+00:00', 'Ann', 'S1', 'W', '2', 'EUR', '121.00', '21.00', 'Ann', 'Calle 1', 'Madrid', '28001', 'ES', 'Amazon.es', 'Acme SL', '12345674', 'ES'];
  const text = H.join('\t') + '\n' + v.join('\t');
  const bad = (await call('manual/preview', { text, useDeliveryAddress: true, sellerDeclaration: { isBusiness: 'true', isAmazonInvoiced: 'false' } })).body; assert.equal(bad.willIssue, 0); assert.equal(bad.heldCount, 1);
  const good = (await call('manual/preview', { text, useDeliveryAddress: true, sellerDeclaration: { isBusiness: true, isAmazonInvoiced: false } })).body; assert.equal(good.willIssue, 0); assert.equal(good.heldCount, 1);
  server.close();
});
