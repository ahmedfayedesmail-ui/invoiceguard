// Money precision: the stored amount and the printed amount must always be the same cent.
// Squad: swarm-money-precision. Every assertion here is arithmetic, not a mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { r2, toCents, isWholeCents } from '../src/money.js';
import { applyEdits, totalsOf } from '../src/invoice.js';
import { parseVidr } from '../src/vidr.js';
import { parseAmount } from '../src/integrity-core.js';

// Exactly what src/pdf.js prints for an amount (Intl es-ES, two decimals).
const printed = (n) => Number(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

test('r2 rounds half away from zero on the decimal value, so it matches the printed cent', () => {
  // These are the values where Math.round(n*100)/100 rounds the BINARY value down while the
  // two-decimal display rounds the decimal value up: stored 8.16, printed 8,17.
  const cases = [[4.515, 4.52], [8.165, 8.17], [4.015, 4.02], [2.675, 2.68], [1.005, 1.01], [12.5, 12.5], [0.1 + 0.2, 0.3], [-4.515, -4.52], [0, 0]];
  for (const [n, want] of cases) {
    assert.equal(r2(n), want, `r2(${n})`);
    assert.equal(printed(r2(n)), printed(want), `printed r2(${n})`);
  }
  assert.equal(toCents(4.515), 452);
  assert.equal(toCents(-4.515), -452);
  assert.equal(isWholeCents(12.5), true);
  assert.equal(isWholeCents(3.3333), false);
});

test('every two-decimal base x VAT rate stores the cent its decimal value rounds to', () => {
  // The defect this guards: 21.50 at 21% is 4.515; the old rule stored 4.51 (a cent below what half
  // up and half even both give) because it rounded the binary approximation of the product.
  const rates = [0.21, 0.20, 0.19, 0.10, 0.09, 0.07, 0.05, 0.25];
  let checked = 0;
  for (const rate of rates) {
    for (let c = 50; c <= 50000; c += 50) {
      const base = c / 100, product = base * rate;
      assert.equal(printed(r2(product)), printed(product), `base ${base} rate ${rate}`);
      checked++;
    }
  }
  assert.ok(checked > 5000, `checked ${checked} pairs`);
});

test('a manual correction line rounds its VAT half up and the document adds up to the cent', () => {
  const original = {
    type: 'invoice', series: 'A', number: 'A-2026-000001', issueDate: '2026-11-20', operationDate: '2026-11-20', currency: 'EUR', langs: ['es'], buyerCountry: 'ES',
    seller: { name: 'Synthetic Seller SL', nif: 'ESB11111119', address: 'Calle 1' },
    buyer: { name: 'Buyer SL', vat: 'ESB12345674', address: ['Calle 2', '28001 Madrid', 'España'] },
    lines: [{ description: 'Item X', sku: 'SKU-X', qty: 1, unitExcl: 12.5, rate: 0.21, excl: 12.5, vat: 2.62 }],
    totals: totalsOf([{ description: 'Item X', qty: 1, unitExcl: 12.5, rate: 0.21, excl: 12.5, vat: 2.62 }]),
  };
  const edit = applyEdits(original, { lines: [{ index: 0, qty: 1, unitExcl: 21.5 }] });
  const line = edit.lines[0];
  assert.equal(line.excl, 21.5);
  assert.equal(line.vat, 4.52, 'VAT of 21,50 at 21% is 4,515 and rounds to 4,52, not to 4,51');
  const totals = totalsOf(edit.lines);
  assert.equal(totals.vat, 4.52);
  assert.equal(totals.incl, 26.02);
  // The printed invoice adds up: base + VAT = total, in cents.
  assert.equal(toCents(totals.excl) + toCents(totals.vat), toCents(totals.incl));
  assert.equal(printed(line.vat), '4,52');
});

test('a sub-cent unit price or VAT rate is refused before anything is issued', () => {
  const original = {
    type: 'invoice', series: 'A', number: 'A-2026-000001', issueDate: '2026-11-20', currency: 'EUR',
    seller: { name: 'S', nif: 'B1', address: 'x' }, buyer: { name: 'B', address: ['a'] },
    lines: [{ description: 'Item', sku: 'S', qty: 1, unitExcl: 10, rate: 0.21, excl: 10, vat: 2.1 }], totals: { excl: 10, vat: 2.1, incl: 12.1 },
  };
  assert.throws(() => applyEdits(original, { lines: [{ index: 0, unitExcl: 3.3333 }] }), /whole cents/);
  assert.throws(() => applyEdits(original, { newLines: [{ description: 'N', qty: 1, unitExcl: 0.005, rate: 0.21 }] }), /whole cents/);
  assert.throws(() => applyEdits(original, { lines: [{ index: 0, rate: 0.075 }] }), /two decimals of a percent/);
  // Ordinary values still pass.
  const ok = applyEdits(original, { lines: [{ index: 0, qty: 3, unitExcl: 3.33, rate: 0.21 }] });
  assert.equal(ok.lines[0].excl, 9.99);
  assert.equal(ok.lines[0].vat, 2.1);
});

test('the builder reads an amount token exactly as the integrity gate reads it', () => {
  // parseAmount (BigInt cents) is the gate; parseVidr (float) is the builder. A token the gate
  // accepts must not be issued as a different number.
  const tokens = ['1.234.567', '123.456.789', '1.234.567,89', '12.345.678,90', '1,234,567.89', '1234567.89', '1234,56', '1234.56', '0,5', '+1.234,56', '1.234,5'];
  const head = ['order-id', 'order-item-id', 'shipping-id', 'order-date', 'shipment-date', 'currency', 'sku', 'product-name', 'quantity-purchased',
    'item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'item-vat-rate', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount', 'shipping-vat-rate',
    'transaction-id', 'transaction-type', 'is-amazon-invoiced', 'invoice-status', 'is-business-order', 'seller-vat-number', 'buyer-vat-number', 'buyer-company-name', 'bill-country', 'ship-country', 'ship-from-country', 'billing-name', 'bill-address-1', 'bill-city', 'bill-postal-code'];
  const row = (tok, i) => {
    const cells = { 'order-id': '403-0000001-0000001', 'order-item-id': 'I' + i, 'shipping-id': 'S' + i, 'shipment-date': '2026-11-24T08:00:00Z', currency: 'EUR', sku: 'SKU', 'product-name': 'P', 'quantity-purchased': '1',
      'item-vat-incl-amount': tok, 'item-vat-amount': tok, 'item-vat-excl-amount': tok, 'item-vat-rate': '', 'shipping-vat-incl-amount': '', 'shipping-vat-amount': '', 'shipping-vat-excl-amount': '', 'shipping-vat-rate': '',
      'transaction-id': 'S' + i, 'transaction-type': 'SHIPMENT', 'is-amazon-invoiced': 'FALSE', 'invoice-status': 'InvoicePending', 'is-business-order': 'TRUE', 'seller-vat-number': 'ESB11111119', 'buyer-vat-number': 'ESB12345674', 'buyer-company-name': 'Buyer SL', 'bill-country': 'ES', 'ship-country': 'ES', 'ship-from-country': 'ES', 'billing-name': 'Buyer SL', 'bill-address-1': 'Calle 1', 'bill-city': 'Madrid', 'bill-postal-code': '28001' };
    return head.map(h => cells[h] ?? '');
  };
  const tsv = [head.join('\t'), ...tokens.map((t, i) => row(t, i).join('\t'))].join('\n');
  const shipments = parseVidr(tsv);
  assert.equal(shipments.length, tokens.length);
  tokens.forEach((tok, i) => {
    const gate = parseAmount(tok);
    assert.equal(gate.state, 'VALID', `gate reading of ${tok}`);
    assert.equal(toCents(shipments[i].incl), Number(gate.cents), `builder vs gate for ${tok}`);
  });
});
