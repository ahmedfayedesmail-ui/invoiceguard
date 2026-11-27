// Phase A, materiality. Test-first. Rules from Ahmed's decision 10 (18:02) and design section 7.2a.
// One absolute threshold per currency, declared by the seller, no default. At or above: MATERIAL. Below: IMMATERIAL. None declared (or other currency): UNDETERMINED and REVIEW.
// Identity fields (tax id, currency): MATERIAL by nature. Date: MATERIAL only when it changes the candidate tax period. Ledger integrity and B2B are never lowered by materiality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessMateriality, actionabilityFromMateriality, declareThresholds, summarizeImmaterial } from '../src/loop/materiality.js';
import { project } from '../src/loop/project.js';
import { sha256 } from '../src/loop/sha256.js';
import * as F from '../tools/make-loop-fixtures.mjs';

const T = declareThresholds({ EUR: '5.00' }); // 500 minor units
const amt = (minor, currency = 'EUR') => assessMateriality({ domain: 'DATA_RECONCILIATION', fieldClass: 'AMOUNT_TAX', difference: { minor, currency }, thresholds: T });

test('threshold declared in decimal text becomes minor units, with no default and no invention', () => {
  assert.deepEqual(T, { EUR: 500 }); assert.deepEqual(declareThresholds({}), {}); assert.deepEqual(declareThresholds(undefined), {});
  for (const bad of [{ EUR: '0' }, { EUR: '-1' }, { EUR: '1.234' }, { EUR: 'five' }, { EU: '5' }, { eur: '5' }]) assert.throws(() => declareThresholds(bad), /threshold/, JSON.stringify(bad));
});
test('amount above the declared threshold is MATERIAL and the action is SELLER_ACTION', () => {
  const m = amt(501); assert.equal(m.status, 'MATERIAL'); assert.equal(m.thresholdMinor, 500); assert.equal(m.amountMinor, 501);
  assert.deepEqual(actionabilityFromMateriality(m), { actionability: 'SELLER_ACTION', summaryOnly: false });
});
test('amount exactly equal to the threshold is MATERIAL (at or above)', () => { assert.equal(amt(500).status, 'MATERIAL'); assert.equal(amt(-500).status, 'MATERIAL', 'the sign does not matter'); });
test('amount below the threshold is IMMATERIAL: no finding, kept in the per-currency summary', () => {
  const m = amt(499); assert.equal(m.status, 'IMMATERIAL'); assert.deepEqual(actionabilityFromMateriality(m), { actionability: 'NONE', summaryOnly: true });
  assert.equal(amt(1).status, 'IMMATERIAL', 'one cent: proven and immaterial');
});
test('no declared threshold is UNDETERMINED with REVIEW, the amount is shown, nothing is escalated', () => {
  const m = assessMateriality({ domain: 'DATA_RECONCILIATION', fieldClass: 'AMOUNT_TAX', difference: { minor: 1000000, currency: 'EUR' }, thresholds: {} });
  assert.equal(m.status, 'UNDETERMINED'); assert.equal(m.amountMinor, 1000000); assert.equal(m.currency, 'EUR'); assert.match(m.reason, /no materiality threshold declared for EUR/);
  assert.deepEqual(actionabilityFromMateriality(m), { actionability: 'REVIEW', summaryOnly: false });
});
test('a EUR threshold does not apply to USD, and no conversion is made', () => {
  const m = amt(1000000, 'USD'); assert.equal(m.status, 'UNDETERMINED'); assert.match(m.reason, /no materiality threshold declared for USD/);
  assert.equal(assessMateriality({ domain: 'DATA_RECONCILIATION', fieldClass: 'AMOUNT_TAX', difference: { minor: 1, currency: 'USD' }, thresholds: declareThresholds({ EUR: '5.00', USD: '5.00' }) }).status, 'IMMATERIAL', 'a declared USD threshold applies to USD');
});
test('identity differences (tax id, currency) are MATERIAL by nature, whatever the threshold', () => {
  for (const field of ['buyerTaxId', 'currency']) { const m = assessMateriality({ domain: 'DATA_RECONCILIATION', fieldClass: 'IDENTIFYING', field, thresholds: {} }); assert.equal(m.status, 'MATERIAL', field); assert.equal(actionabilityFromMateriality(m).actionability, 'SELLER_ACTION'); }
});
test('a date difference is MATERIAL only when it changes the candidate tax period', () => {
  const t = (periodChanges) => assessMateriality({ domain: 'DATA_RECONCILIATION', fieldClass: 'TIMING', periodChanges, thresholds: T });
  assert.equal(t(true).status, 'MATERIAL'); assert.equal(t(false).status, 'IMMATERIAL'); assert.equal(t(null).status, 'UNDETERMINED', 'unknown period: not guessed');
});
test('materiality never lowers a ledger-integrity finding and does not apply to the B2B domain', () => {
  for (const domain of ['LEDGER_INTEGRITY', 'B2B_OBLIGATION']) { const m = assessMateriality({ domain, fieldClass: 'AMOUNT_TAX', difference: { minor: 1, currency: 'EUR' }, thresholds: declareThresholds({ EUR: '1000000.00' }) }); assert.equal(m.status, 'NOT_APPLICABLE', domain); assert.equal(actionabilityFromMateriality(m).actionability, 'UNCHANGED', domain); }
});
test('the business flag is not an input: the same difference gives the same materiality for any order', () => {
  const a = assessMateriality({ domain: 'DATA_RECONCILIATION', fieldClass: 'AMOUNT_TAX', difference: { minor: 700, currency: 'EUR' }, thresholds: T, isBusinessOrder: true }), b = assessMateriality({ domain: 'DATA_RECONCILIATION', fieldClass: 'AMOUNT_TAX', difference: { minor: 700, currency: 'EUR' }, thresholds: T, isBusinessOrder: false });
  assert.deepEqual(a, b);
});
test('immaterial differences never disappear: one summary line per currency with count, sum of absolute differences and the largest', () => {
  const s = summarizeImmaterial([{ currency: 'EUR', minor: 100 }, { currency: 'EUR', minor: -250 }, { currency: 'USD', minor: 30 }, { currency: 'EUR', minor: 5 }]);
  assert.deepEqual(s, [{ currency: 'EUR', count: 3, sumAbsMinor: 355, largestAbsMinor: 250 }, { currency: 'USD', count: 1, sumAbsMinor: 30, largestAbsMinor: 30 }]);
  assert.deepEqual(summarizeImmaterial([]), []);
});

// ---- Engine level. Expected to FAIL today: non-business orders are not linked to the books at all, so their reconciliation is not run. ----
const imp = (id, kind, text, declared, importedAt, profile) => ({ id, kind, text, declared, importedAt, fileName: id, sha256: sha256(text), profile });
const withFlag = (tsv, flag) => tsv.split('\n').map((l, i) => { if (!i || !l) return l; const c = l.split('\t'); c[12] = flag; return c.join('\t'); }).join('\n');
const mismatchFor = (flag) => {
  const v = imp('v', 'vidr', withFlag(F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'M-1' }]), flag), F.VDECL('2026-11-20T10:00:00Z'), '2026-11-20T10:01:00Z');
  const l = imp('l', 'ledger', F.ledger([F.L.row('M-1', '2026-11-18', '2026-11-17', F.O(1), 'Amazon.es', '121,00', 'USD')]), F.LDECL({ exportedAt: '2026-11-21T11:00:00Z' }), '2026-11-21T11:01:00Z', F.PROFILE);
  return project({ imports: [v, l], events: [] }).issues.filter(i => i.family === 'DATA_MISMATCH');
};
test('the business flag must not affect DATA_RECONCILIATION: a currency difference is found and acted on the same way on a business and a non-business order', { todo: 'engine change not made yet: non-business shipments are held out before linking' }, () => {
  const biz = mismatchFor('TRUE'), non = mismatchFor('FALSE');
  assert.equal(biz.length, 1, 'baseline: found on a business order'); assert.equal(non.length, 1, 'must also be found on a non-business order');
  assert.equal(non[0].state, biz[0].state); assert.deepEqual(non[0].finding.evidence.differences.map(d => d.field), biz[0].finding.evidence.differences.map(d => d.field));
});
