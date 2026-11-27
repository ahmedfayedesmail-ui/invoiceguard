// Phase A, coverage: a NEW metric, independent of the reconciliation numbers. It says what the check looked at and what it did not, counting unique shipments (never rows).
// Non-business shipments are NOT EVALUATED under the current check rule: never "unmatched". Blank, unreadable or conflicting flags are shown separately as undetermined.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { project } from '../src/loop/project.js';
import { sha256 } from '../src/loop/sha256.js';
import { SCENARIOS, MIXED } from './helpers/coverage-scenarios.mjs';

test('adding the coverage metric leaves every current result unchanged (issues, buckets, stats, notes, imports are byte-identical to the engine before the change)', () => {
  const golden = JSON.parse(readFileSync(new URL('./golden/engine-output-before-coverage.json', import.meta.url), 'utf8'));
  for (const [k, v] of Object.entries(SCENARIOS())) { const p = project(v); assert.equal(sha256(JSON.stringify({ issues: p.issues, buckets: p.buckets, stats: p.stats, coverageNotes: p.coverageNotes, imports: p.imports })), golden[k], k); }
});
test('coverage counts unique shipments, each scope with its own denominator', () => {
  const c = project(MIXED()).coverage;
  assert.equal(c.shipmentsInScope, 6, 'six unique shipments, although eight rows were read (two shipments have a second item row)');
  assert.deepEqual(c.business, { entered: 2, matched: 1, notMatched: 1, matchedMeans: 'the shipment is linked to a document in the books by its invoice number' });
  assert.equal(c.nonBusiness.count, 2); assert.equal(c.nonBusiness.status, 'NOT_EVALUATED');
  assert.equal(c.undetermined.count, 2); assert.deepEqual(c.undetermined.byReason, { BLANK: 1, CONFLICT: 1, UNREADABLE: 0 });
  assert.equal(c.business.entered + c.nonBusiness.count + c.undetermined.count, c.shipmentsInScope, 'the three groups add up to the scope: nothing is dropped and nothing counted twice');
});
test('a non-business shipment is never described as unmatched, and the reason is in words', () => {
  const c = project(MIXED()).coverage, nb = c.nonBusiness;
  assert.ok(!('unmatched' in nb) && !('notMatched' in nb)); assert.match(nb.reason, /not checked/i); assert.match(nb.reason, /current check rule/i);
  assert.match(c.undetermined.reason, /blank|disagree|neither/i); assert.match(c.business.matchedMeans, /invoice number/);
});
test('undetermined flags are not folded into any denominator', () => {
  const c = project(MIXED()).coverage; assert.equal(c.business.entered, 2); assert.equal(c.business.matched + c.business.notMatched, c.business.entered);
});
test('with no shipments at all every count is 0 and the reasons still exist', () => {
  const c = project({ imports: [], events: [] }).coverage; assert.ok(c, 'coverage exists even with nothing loaded'); assert.equal(c.shipmentsInScope, 0); assert.equal(c.business.entered + c.nonBusiness.count + c.undetermined.count, 0);
});
test('shipments outside the check altogether (Amazon-invoiced, corrections) are counted apart, with the reason', () => {
  const c = project(MIXED()).coverage; assert.equal(typeof c.outsideScope.createdByAmazon, 'number'); assert.equal(typeof c.outsideScope.notOrdinaryInvoice, 'number'); assert.match(c.outsideScope.reason, /Amazon|not the seller/i);
});
