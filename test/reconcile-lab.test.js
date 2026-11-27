// RESEARCH LAB tests (branch research/invoiceguard-reconciliation-lab). Synthetic data only. Not part of the product.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, UNKNOWN } from '../lab/reconcile/reconcile-lab.js';

const V = (shipmentKey, orderId, itemId, gross, extra = {}) => ({ doc: 'vidr-1', line: extra.line ?? 2, shipmentKey, orderId, itemId, currency: 'EUR', gross, ...extra });
const O = (orderId, itemId, gross, extra = {}) => ({ doc: 'orders-1', line: 2, orderId, itemId, currency: 'EUR', gross, ...extra });
const I = (number, shipmentKey, gross, extra = {}) => ({ number, shipmentKey, kind: 'invoice', currency: 'EUR', gross, transactionId: 'T-' + number, ...extra });
const S = (number, status, extra = {}) => ({ doc: 'vidr-2', line: 5, number, transactionId: 'T-' + number, status, ...extra });
const row = (r, k) => r.shipments.find(s => s.shipmentKey === k);

test('clean path: expected, invoiced, accepted by a later report with number and TransactionId, nothing unexplained, nothing for a human', () => {
  const r = reconcile({ vidr: [V('S1', 'O1', 'I1', '60.50')], orders: [O('O1', 'I1', '60.50')], invoices: [I('A-1', 'S1', '60.50')], statuses: [S('A-1', 'InvoiceUploaded')] });
  const s = row(r, 'S1'); assert.deepEqual([s.expected, s.invoiced, s.accepted, s.unexplained, s.needsHuman.length], ['60.50', '60.50', 'ACCEPTED', '0.00', 0]);
  assert.ok(s.links.every(l => l.strength === 'PROVABLE')); assert.equal(r.orderLinks[0].strength, 'PROVABLE');
});
test('a status with the number but without a matching TransactionId is only a CANDIDATE and never makes ACCEPTED', () => {
  const r = reconcile({ vidr: [V('S1', 'O1', 'I1', '10.00')], invoices: [I('A-1', 'S1', '10.00')], statuses: [S('A-1', 'InvoiceUploaded', { transactionId: 'OTHER' })] });
  assert.equal(row(r, 'S1').accepted, 'NOT_CONFIRMED'); assert.ok(row(r, 'S1').links.some(l => l.strength === 'CANDIDATE'));
});
test('no status row never means accepted', () => assert.equal(row(reconcile({ vidr: [V('S1', 'O1', 'I1', '10.00')], invoices: [I('A-1', 'S1', '10.00')] }), 'S1').accepted, 'NOT_CONFIRMED'));
test('unknown never becomes zero: an unreadable amount makes expected and unexplained UNKNOWN, with the evidence kept', () => {
  const r = reconcile({ vidr: [V('S1', 'O1', 'I1', '1,234')], invoices: [I('A-1', 'S1', '10.00')] }); const s = row(r, 'S1');
  assert.equal(s.expected, UNKNOWN); assert.equal(s.unexplained, UNKNOWN); assert.deepEqual(s.evidence.lines, [{ doc: 'vidr-1', line: 2 }]);
});
test('not invoiced is its own state, never zero and never unexplained', () => { const s = row(reconcile({ vidr: [V('S1', 'O1', 'I1', '10.00')] }), 'S1'); assert.equal(s.unexplained, 'NOT_INVOICED'); assert.equal(s.invoiced, '0.00'); });
test('an amount that nothing explains is shown with its sign and goes to a human', () => {
  const s = row(reconcile({ vidr: [V('S1', 'O1', 'I1', '60.50')], invoices: [I('A-1', 'S1', '60.00')] }), 'S1'); assert.equal(s.unexplained, '0.50'); assert.ok(s.findings.some(f => f.code === 'UNEXPLAINED_AMOUNT')); assert.equal(s.needsHuman.length, 1);
});
test('a credit note explains a difference; two ordinary invoices for one shipment is a BLOCK', () => {
  const s = row(reconcile({ vidr: [V('S1', 'O1', 'I1', '60.50')], invoices: [I('A-1', 'S1', '60.50'), I('C-1', 'S1', '60.50', { kind: 'credit' })] }), 'S1'); assert.equal(s.unexplained, '60.50'); assert.ok(!s.findings.some(f => f.code === 'UNEXPLAINED_AMOUNT'), 'a credit note is the explanation');
  const d = row(reconcile({ vidr: [V('S1', 'O1', 'I1', '60.50')], invoices: [I('A-1', 'S1', '60.50'), I('A-2', 'S1', '60.50')] }), 'S1'); assert.ok(d.findings.some(f => f.code === 'DOUBLE_INVOICE' && f.severity === 'BLOCK'));
});
test('a rejection reported by Amazon is shown and needs a human; it is never read as accepted', () => {
  const s = row(reconcile({ vidr: [V('S1', 'O1', 'I1', '10.00')], invoices: [I('A-1', 'S1', '10.00')], statuses: [S('A-1', 'InvoiceRejected')] }), 'S1'); assert.equal(s.accepted, 'REJECTED'); assert.ok(s.findings.some(f => f.code === 'REJECTED_BY_AMAZON'));
});
test('order item in two shipments is a CANDIDATE link, not provable; an item that matches one shipment is PROVABLE', () => {
  const r = reconcile({ vidr: [V('S1', 'O1', 'I1', '5.00'), V('S2', 'O1', 'I1', '5.00', { line: 3 })], orders: [O('O1', 'I1', '10.00')] }); assert.equal(r.orderLinks[0].strength, 'CANDIDATE');
  const r2 = reconcile({ vidr: [V('S1', 'O1', 'I1', '5.00'), V('S2', 'O1', 'I2', '5.00', { line: 3 })], orders: [O('O1', 'I2', '5.00')] }); assert.equal(r2.orderLinks[0].strength, 'PROVABLE');
});
test('contradictions across documents are shown with both sides and neither is chosen', () => {
  const r = reconcile({ vidr: [V('S1', 'O1', 'I1', '60.50')], orders: [O('O1', 'I1', '60.00')] }); const f = row(r, 'S1').findings.find(x => x.code === 'ITEM_AMOUNT_CONTRADICTION'); assert.ok(f); assert.deepEqual([f.detail.vidr, f.detail.order], ['60.50', '60.00']);
  const c = reconcile({ vidr: [V('S1', 'O1', 'I1', '60.50')], orders: [O('O1', 'I1', '60.50', { currency: 'GBP' })] }); assert.ok(row(c, 'S1').findings.some(x => x.code === 'CURRENCY_CONTRADICTION'));
  const m = reconcile({ vidr: [V('S1', 'O1', 'I1', '1.00'), V('S1', 'O1', 'I2', '1.00', { currency: 'USD', line: 3 })] }); assert.equal(row(m, 'S1').expected, UNKNOWN);
});
test('failure cases: empty input, an order not in the VIDR, a status for a document we never issued', () => {
  assert.deepEqual(reconcile().shipments, []); assert.equal(reconcile({ orders: [O('OX', 'I', '1.00')] }).orderLinks[0].relation, 'ORDER_NOT_IN_VIDR');
  const r = reconcile({ statuses: [S('Z-9', 'InvoiceUploaded')] }); assert.equal(r.shipments[0].findings[0].code, 'STATUS_FOR_UNKNOWN_DOCUMENT'); assert.equal(r.shipments.length, 1);
});
test('reproducible and order-independent: the same input gives the same digest, whatever the row order, and the input is not changed', () => {
  const input = { vidr: [V('S2', 'O2', 'I3', '9.99', { line: 4 }), V('S1', 'O1', 'I1', '60.50'), V('S1', 'O1', 'I2', '1.00', { line: 3 })], orders: [O('O1', 'I1', '60.50')], invoices: [I('A-1', 'S1', '61.50')], statuses: [S('A-1', 'InvoiceUploaded')] };
  const frozen = JSON.stringify(input), a = reconcile(input), rev = { vidr: [...input.vidr].reverse(), orders: input.orders, invoices: input.invoices, statuses: input.statuses }, b = reconcile(rev);
  assert.equal(JSON.stringify(input), frozen); assert.equal(a.digest, reconcile(input).digest);
  const norm = (r) => JSON.stringify(r.shipments.map(s => ({ ...s, evidence: { ...s.evidence, lines: [...s.evidence.lines].sort((x, y) => x.line - y.line) }, links: [...s.links].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))) }))); assert.equal(norm(a), norm(b));
});
test('property: random synthetic worlds never produce ACCEPTED without a verbatim status, never a negative zero, and expected is UNKNOWN whenever one line is unreadable', () => {
  let seed = 7; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; }; const pick = (a) => a[Math.floor(rnd() * a.length)];
  for (let n = 0; n < 300; n++) {
    const vidr = [], invoices = [], statuses = []; const k = 1 + Math.floor(rnd() * 3); let bad = new Set();
    for (let s = 0; s < k; s++) { const key = 'S' + s, lines = 1 + Math.floor(rnd() * 3); for (let l = 0; l < lines; l++) { const g = pick(['10.00', '5.55', '0.00', '1,234', 'x', '']); if (!/^\d+\.\d\d$/.test(g)) bad.add(key); vidr.push(V(key, 'O' + s, 'I' + l, g, { line: 2 + l })); } if (rnd() < 0.7) invoices.push(I('A-' + s, key, pick(['10.00', '5.55', '15.55']))); if (rnd() < 0.5) statuses.push(S('A-' + s, pick(['InvoiceUploaded', 'InvoiceRejected', 'Other']), rnd() < 0.3 ? { transactionId: 'bad' } : {})); }
    const r = reconcile({ vidr, invoices, statuses });
    for (const s of r.shipments) { if (s.accepted === 'ACCEPTED') assert.ok(statuses.some(x => x.number && s.evidence.statuses.some(e => e.strength === 'PROVABLE'))); if (bad.has(s.shipmentKey)) assert.equal(s.expected, UNKNOWN); assert.ok(!/-0\.00/.test(JSON.stringify(s))); }
  }
});
