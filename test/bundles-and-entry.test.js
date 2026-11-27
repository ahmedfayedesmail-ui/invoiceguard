// (1) The committed browser bundles (public/local/*.js) must equal what their sources build. A hand-rebuilt bundle can no longer be shipped stale: this fails loudly and names the file.
// (2) The web entry and the committed bundle never turn an Order Report into a ready invoice, whatever option is passed. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('bundles: public/local/engine.js and loop-engine.js are exactly what node tools/build-local.mjs builds from the current sources', () => {
  try { execFileSync('node', ['tools/build-local.mjs', '--check'], { stdio: 'pipe', encoding: 'utf8' }); }
  catch (e) { assert.fail('STALE BUNDLE. ' + String(e.stderr || e.message).trim()); }
});

const HEAD = ['order-id', 'order-item-id', 'purchase-date', 'buyer-name', 'sku', 'product-name', 'quantity-purchased', 'currency', 'item-price', 'item-tax', 'shipping-price', 'shipping-tax', 'recipient-name', 'ship-address-1', 'ship-city', 'ship-postal-code', 'ship-country', 'sales-channel', 'buyer-company-name', 'buyer-tax-registration-id', 'buyer-tax-registration-country', 'buyer-tax-registration-type'];
const v = ['111-1111111-1111111', '1', '2026-11-20T10:00:00+00:00', 'Ann', 'S1', 'Widget', '2', 'EUR', '121.00', '21.00', '0', '0', 'Ann', 'Calle 1', 'Madrid', '28001', 'ES', 'Amazon.es', 'Acme SL', 'B12345674', 'ES', 'VAT'];
const orderReport = HEAD.join('\t') + '\n' + v.join('\t');
for (const [label, path] of [['web/engine-entry.js (source)', '../web/engine-entry.js'], ['public/local/engine.js (committed bundle)', '../public/local/engine.js']]) {
  const load = () => import(path);
  test(`${label}: an Order Report without a declaration is HELD with the reason; nothing is ready`, async () => {
    const r = await (await load()).analyze(orderReport, { useDeliveryAddress: true });
    assert.equal(r.ok, true); assert.equal((r.ready ?? []).length, 0); assert.equal(r.held.length, 1);
    assert.match(r.held[0].reason, /does not carry/); assert.match(r.held[0].reason, /load the VAT Invoice Data Report/i);
  });
  test(`${label}: a seller declaration passed to analyze() is not a route to a ready invoice: the order stays held`, async () => {
    const r = await (await load()).analyze(orderReport, { useDeliveryAddress: true, sellerDeclaration: { isBusiness: true, isAmazonInvoiced: false } });
    assert.equal(r.ready.length, 0); assert.equal(r.held.length, 1); assert.match(r.held[0].reason, /VAT Invoice Data Report/);
  });
  test(`${label}: a partial declaration still holds the order`, async () => {
    const r = await (await load()).analyze(orderReport, { useDeliveryAddress: true, sellerDeclaration: { isBusiness: true } });
    assert.equal(r.ready.length, 0); assert.match(r.held[0].reason, /is-amazon-invoiced/);
  });
}
