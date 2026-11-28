// swarm-financial audit regression tests (28 Nov 2026).
// F1: the printed VAT rate must be the real rate (fractional reduced rates exist: FR 5.5%, 2.1%).
// F2: a rectificativa by differences pairs lines by index; a removed/reordered line must refuse
//     issuance instead of pairing one product's amounts against another's description and rate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRectificativa, applyEdits, totalsOf } from '../src/invoice.js';
import { fmtRate } from '../src/pdf.js';

const original = {
  number: 'A-2026-000001', issueDate: '2026-01-10', operationDate: '2026-01-09', buyerCountry: 'ES', currency: 'EUR',
  seller: { name: 'Seller SA', nif: 'ESB1', address: 'Calle Uno' },
  buyer: { name: 'Buyer SL', vat: 'ESB2', address: ['Calle Dos'] },
  lines: [
    { description: 'ItemA', sku: 'A1', qty: 1, unitExcl: 10, rate: 0.21, excl: 10, vat: 2.1 },
    { description: 'ItemB', sku: 'B1', qty: 1, unitExcl: 20, rate: 0.21, excl: 20, vat: 4.2 },
    { description: 'ItemC', sku: 'C1', qty: 1, unitExcl: 30, rate: 0.1, excl: 30, vat: 3 },
  ],
  totals: { excl: 60, vat: 9.3, incl: 69.3 },
};
const seller = { id: 's1', country: 'ES' };
const dbStub = { prepare: () => ({ get: () => undefined, run: () => ({}) }) };
const build = (changes, mode = 'differences') =>
  buildRectificativa(dbStub, seller, original, { mode, reason: 'audit test', changes, number: 'R-2026-000001', date: new Date('2026-02-01T00:00:00Z') });

test('fmtRate prints the real rate, including fractional reduced rates', () => {
  assert.equal(fmtRate(0.21), '21%');
  assert.equal(fmtRate(0.1), '10%');
  assert.equal(fmtRate(0.04), '4%');
  assert.equal(fmtRate(0.055), '5.5%'); // was printed as "6%"
  assert.equal(fmtRate(0.021), '2.1%'); // was printed as "2%"
  assert.equal(fmtRate(0), '0%');
});

test('differences rectificativa refuses a removed line instead of mispairing amounts', () => {
  const edits = applyEdits(original, { lines: [{ index: 1, remove: true }] });
  assert.throws(() => build({ lines: edits.lines }), /cannot drop a line/);
});

test('differences rectificativa refuses a line whose identity changed at the same index', () => {
  const lines = original.lines.map(l => ({ ...l }));
  lines[1] = { ...lines[1], description: 'ItemC', sku: 'C1', excl: 25, vat: 5.25 }; // wrong identity at index 1
  assert.throws(() => build({ lines }), /changed identity/);
});

test('differences rectificativa still issues for an aligned amount edit', () => {
  const lines = original.lines.map(l => ({ ...l }));
  lines[1] = { ...lines[1], excl: 15, vat: 3.15 }; // partial return of ItemB, same index and identity
  const rect = build({ lines });
  assert.deepEqual(rect.lines, [{ description: 'ItemB', qty: 1, unitExcl: -5, rate: 0.21, excl: -5, vat: -1.05 }]);
  assert.deepEqual(rect.totals, { excl: -5, vat: -1.05, incl: -6.05 });
});

test('differences rectificativa still accepts an appended new line', () => {
  const lines = [...original.lines.map(l => ({ ...l })), { description: 'Extra', qty: 1, unitExcl: 5, rate: 0.21, excl: 5, vat: 1.05 }];
  const rect = build({ lines });
  assert.deepEqual(rect.lines, [{ description: 'Extra', qty: 1, unitExcl: 5, rate: 0.21, excl: 5, vat: 1.05 }]);
  assert.deepEqual(rect.totals, { excl: 5, vat: 1.05, incl: 6.05 });
});

test('totalsOf sums line values to the cent', () => {
  const t = totalsOf([{ excl: 10.1, vat: 2.12 }, { excl: 0.1, vat: 0.02 }, { excl: 3.33, vat: 0.7 }]);
  assert.deepEqual(t, { excl: 13.53, vat: 2.84, incl: 16.37 });
});
