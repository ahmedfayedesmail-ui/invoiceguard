// N4: the special-territory exclusion keys on the SHIP destination (ship-postal-code), not the billing postal. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { intraEUShape, isIntraEUExempt } from '../src/invoice.js';
import { parseVidr } from '../src/vidr.js';

const base = (o = {}) => ({ vat: 0, excl: 100, buyerVat: 'ESB11111119', shipCountry: 'ES', shipFromCountry: 'DE', citation: null, billing: { country: 'DE', postal: '10178' }, ...o });

test('N4: shipped to Canary/Ceuta/Melilla but billed in Germany is NOT intra-EU exempt', () => {
  for (const shipPostal of ['35001', '38001', '51001', '52001', '35 001']) {
    const s = base({ shipPostal });
    assert.equal(intraEUShape(s), false, shipPostal); assert.equal(isIntraEUExempt(s), false, shipPostal);
  }
});
test('N4: ship to mainland ES (28xxx) billed elsewhere stays intra-EU exempt, even if the billing postal looks like a territory', () => {
  assert.equal(isIntraEUExempt(base({ shipPostal: '28001' })), true);
  assert.equal(isIntraEUExempt(base({ shipPostal: '28001', billing: { country: 'ES', postal: '35001' } })), true, 'billing postal must not decide when ship postal is known');
});
test('N4: billing==ship country with a territory ship postal is excluded (previous behavior kept)', () => {
  assert.equal(isIntraEUExempt(base({ shipPostal: '38001', billing: { country: 'ES', postal: '38001' } })), false);
});
test('N4: no ship postal in the file falls back to the old billing rule (billing country == ship country only)', () => {
  assert.equal(isIntraEUExempt(base({ billing: { country: 'ES', postal: '35001' } })), false);
  assert.equal(isIntraEUExempt(base({ billing: { country: 'DE', postal: '35001' } })), true, 'documented residual: no ship postal and foreign billing cannot be told apart');
});
test('N4: conflicting ship postals across rows refuse the exempt shape', () => {
  assert.equal(isIntraEUExempt(base({ shipPostal: '28001', shipPostalConflict: true })), false);
});
test('N4: other territories keyed on ship postal (FR 97xxx, FI 22xxx, DE 78266)', () => {
  assert.equal(isIntraEUExempt(base({ shipCountry: 'FR', buyerVat: 'FR12345678901', shipPostal: '97100' })), false);
  assert.equal(isIntraEUExempt(base({ shipCountry: 'DE', shipFromCountry: 'ES', buyerVat: 'DE811128135', shipPostal: '78266' })), false);
  assert.equal(isIntraEUExempt(base({ shipCountry: 'DE', shipFromCountry: 'ES', buyerVat: 'DE811128135', shipPostal: '10115' })), true);
});

// parser: the column is read and kept on the shipment
const HEAD = ['order-id', 'order-item-id', 'shipping-id', 'transaction-id', 'transaction-type', 'currency', 'quantity-purchased', 'item-vat-excl-amount', 'item-vat-amount', 'item-vat-incl-amount', 'ship-country', 'ship-from-country', 'ship-postal-code', 'bill-country', 'bill-postal-code', 'is-business-order', 'buyer-vat-number'];
const row = (o) => { const b = { 'order-id': '111-1111111-1111111', 'order-item-id': '1', 'shipping-id': 'S1', 'transaction-id': 'T1', 'transaction-type': 'SHIPMENT', currency: 'EUR', 'quantity-purchased': '1', 'item-vat-excl-amount': '100', 'item-vat-amount': '0', 'item-vat-incl-amount': '100', 'ship-country': 'ES', 'ship-from-country': 'DE', 'ship-postal-code': '35001', 'bill-country': 'DE', 'bill-postal-code': '10178', 'is-business-order': 'TRUE', 'buyer-vat-number': 'ESB11111119', ...o }; return HEAD.map(h => b[h] ?? '').join('\t'); };
test('N4 parser: ship-postal-code is read onto the shipment; disagreeing rows set shipPostalConflict', () => {
  const one = parseVidr([HEAD.join('\t'), row({})].join('\n'));
  const sh = (one.shipments ?? one)[0] ?? Object.values(one.shipments ?? one)[0];
  assert.equal(sh.shipPostal, '35001'); assert.ok(!sh.shipPostalConflict);
  const two = parseVidr([HEAD.join('\t'), row({}), row({ 'order-item-id': '2', 'ship-postal-code': '28001' })].join('\n'));
  const s2 = (two.shipments ?? two)[0] ?? Object.values(two.shipments ?? two)[0];
  assert.equal(s2.shipPostalConflict, true);
});
