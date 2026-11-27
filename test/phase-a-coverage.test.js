// Phase A, coverage: a NEW metric, independent of the reconciliation numbers. It says what the check looked at and what it did not, counting unique transactions (never rows).
// Non-business transactions are NOT EVALUATED under the current check rule: never "unmatched". Blank, unreadable or conflicting flags are shown separately as undetermined.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { project } from '../src/loop/project.js';
import { sha256 } from '../src/loop/sha256.js';
import { SCENARIOS, FULL, TWO_TX_ONE_SHIPMENT } from './helpers/coverage-scenarios.mjs';
import { coverageStatement } from '../src/loop/coverage.js';

test('adding the coverage metric leaves every current result unchanged (issues, buckets, stats, notes, imports are byte-identical to the engine before the change)', () => {
  const golden = JSON.parse(readFileSync(new URL('./golden/engine-output-before-coverage.json', import.meta.url), 'utf8'));
  for (const [k, v] of Object.entries(SCENARIOS())) { const p = project(v); assert.equal(sha256(JSON.stringify({ issues: p.issues, buckets: p.buckets, stats: p.stats, coverageNotes: p.coverageNotes, imports: p.imports })), golden[k], k); }
});
const total = (c) => c.scope.count + c.undetermined.count + c.outsideScope.count;
test('one model: scope = shipments determined to need a seller invoice (both fields readable); undetermined and outside-scope sit outside it; the three add up to ALL unique transactions', () => {
  const c = project(FULL()).coverage;
  assert.equal(c.transactionsTotal, 10, '12 rows were read, 10 unique transactions (two shipments have a second item row)');
  assert.equal(c.scope.count, 4); assert.equal(c.undetermined.count, 4); assert.equal(c.outsideScope.count, 2);
  assert.equal(total(c), c.transactionsTotal, 'nothing counted twice and nothing lost');
  assert.equal(c.scope.business.entered + c.scope.nonBusiness.count, c.scope.count, 'business and non-business are subsets that fill the scope');
});
test('business and non-business are subsets of the scope; matched and not matched are counted over the business subset and the scope total is stated beside them', () => {
  const s = project(FULL()).coverage.scope;
  assert.deepEqual({ e: s.business.entered, m: s.business.matched, n: s.business.notMatched }, { e: 2, m: 1, n: 1 });
  assert.equal(s.business.matched + s.business.notMatched, s.business.entered); assert.equal(s.nonBusiness.count, 2); assert.equal(s.nonBusiness.status, 'NOT_EVALUATED');
  assert.match(s.business.matchedMeans, /invoice number/);
});
test('the coverage figure and the Summary figure cannot contradict: linked (any Amazon status) is stated apart from linked AND accepted, and the second is exactly the Summary number', () => {
  for (const [k, v] of Object.entries({ ...SCENARIOS(), full: FULL() })) { const p = project(v), b = p.coverage.scope.business; assert.equal(b.matchedAndAccepted, p.stats.matchedByInvoiceNumber, k); assert.ok(b.matchedAndAccepted <= b.matched, k); }
  assert.match(coverageStatement(project(FULL()).coverage).join(' '), /whatever Amazon's status/); assert.match(coverageStatement(project(FULL()).coverage).join(' '), /also shown as accepted by Amazon/);
});
test('undetermined is a separate bucket with its own reasons and is in no denominator', () => {
  const u = project(FULL()).coverage.undetermined;
  assert.deepEqual(u.byReason, { BUSINESS_FLAG_BLANK: 1, BUSINESS_FLAG_CONFLICT: 1, BUSINESS_FLAG_UNREADABLE: 1, AMAZON_INVOICED_FLAG_UNREADABLE_OR_CONFLICTING: 1 });
  assert.equal(Object.values(u.byReason).reduce((a, b) => a + b, 0), u.count); assert.match(u.reason, /blank|disagree|neither/i);
});
test('outside scope: Amazon-created invoices and corrections or non-shipment rows, each counted with its reason', () => {
  const o = project(FULL()).coverage.outsideScope; assert.deepEqual(o.byReason, { AMAZON_INVOICED: 1, NOT_ORDINARY_INVOICE: 1 }); assert.match(o.reason, /Amazon/);
});
test('a non-business shipment is never described as unmatched, and the reason is in words', () => {
  const nb = project(FULL()).coverage.scope.nonBusiness; assert.ok(!('unmatched' in nb) && !('notMatched' in nb)); assert.match(nb.reason, /not checked/i); assert.match(nb.reason, /current check rule/i);
});
test('empty input: every count is 0 and the invariant holds', () => {
  const c = project({ imports: [], events: [] }).coverage; assert.ok(c); assert.equal(c.transactionsTotal, 0); assert.equal(total(c), 0);
});
test('the invariant holds for every synthetic scenario', () => { for (const [k, v] of Object.entries(SCENARIOS())) { const c = project(v).coverage; assert.equal(total(c), c.transactionsTotal, k); assert.equal(c.scope.business.entered + c.scope.nonBusiness.count, c.scope.count, k); } });

// ---- the words the seller reads ----
test('the statement names its scope and denominators, and never presents the business-only figure as covering every shipment', () => {
  const c = project(FULL()).coverage, t = coverageStatement(c).join('\n');
  assert.match(t, /1 of 2 business transactions/); assert.match(t, /business transactions only/i); assert.match(t, /not all 4 transactions in scope/i);
  assert.match(t, /2 transactions in scope were NOT EVALUATED/); assert.match(t, /current check rule/); assert.match(t, /4 could not be classified/); assert.match(t, /10 unique transactions = 4 in scope \+ 4 undetermined \+ 2 outside the check/);
  assert.doesNotMatch(t, /undefined|\[object|NaN/); assert.doesNotMatch(t, /\bunmatched\b/i);
});
test('when every shipment in scope is a business shipment the statement says the figure covers all of them', () => {
  const t = coverageStatement({ transactionsTotal: 3, scope: { count: 3, business: { entered: 3, matched: 2, notMatched: 1 }, nonBusiness: { count: 0 } }, undetermined: { count: 0, byReason: {} }, outsideScope: { count: 0, byReason: {} } }).join('\n');
  assert.match(t, /2 of 3 business transactions/); assert.match(t, /all 3 transactions in scope/); assert.doesNotMatch(t, /business transactions only/i);
});
test('nothing loaded: the statement says so instead of showing zeros as a result', () => { assert.match(coverageStatement(project({ imports: [], events: [] }).coverage).join(' '), /No Amazon report/); });
test('the statement is part of the data, the export carries it, and the page renders it from that one source', () => {
  const p = project(FULL()); assert.deepEqual(p.coverage.statement, coverageStatement(p.coverage));
  const ui = readFileSync(new URL('../public/local/loop.js', import.meta.url), 'utf8'), st = readFileSync(new URL('../src/loop/store.js', import.meta.url), 'utf8');
  assert.match(ui, /id: 'coverage'/); assert.match(ui, /coverage\.statement/); assert.match(st, /coverage: r\.coverage/);
});

test('KEY: the count is by Amazon transaction, not by shipment. One shipping id with two transaction ids counts twice, and the words say transactions and name the key', () => {
  const { scenario, distinctShippingIds, distinctTransactionIds } = TWO_TX_ONE_SHIPMENT(), c = project(scenario).coverage, t = coverageStatement(c).join('\n');
  assert.equal(distinctShippingIds, 1, 'the fixture really is one shipment'); assert.equal(distinctTransactionIds, 2);
  assert.equal(c.transactionsTotal, 2, 'two transactions are two units: the shipping id is not proven to be a shipment key');
  assert.equal(c.scope.business.entered, 2);
  assert.match(t, /Counted by Amazon transaction/); assert.match(t, /marketplace, transaction type, transaction id, order id and shipping id/); assert.match(t, /not proven/i);
  assert.doesNotMatch(t, /\bshipments?\b[^.]*\bunique\b|\bunique shipments\b|\d+ (business )?shipments/i, 'no number is displayed as a count of shipments');
});
test('KEY: the data names the key it counts by', () => { const c = project(FULL()).coverage; assert.match(c.countedBy.key, /marketplace.*transaction type.*transaction id.*order id.*shipping id/); assert.equal(c.countedBy.unit, 'TRANSACTION'); assert.equal(c.countedBy.shipmentKeyProven, false); });
