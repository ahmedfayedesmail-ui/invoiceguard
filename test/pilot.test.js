import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../tools/make-loop-fixtures.mjs';
import { preflight, createPilotRecord, aggregateMetrics, assertAggregateOnly, ADJUDICATIONS } from '../src/loop/pilot.js';
import { createLoopStore } from '../src/loop/store.js';
import { createVault } from '../src/loop/vault.js';
import { memoryAdapter } from '../src/history.js';

const vd = () => ({ ...F.VDECL('2026-11-20T10:00:00Z') }), ld = () => F.LDECL();
const base = () => ({ vidrText: F.PV, vidrDeclared: vd(), ledgerText: F.PL1, profile: F.PROFILE, ledgerDeclared: ld() });
const status = (r, id) => r.checks.find(x => x.id === id)?.status;

test('preflight: fixtures pass or warn, nothing fails', () => { const r = preflight(base()); assert.deepEqual(r.checks.filter(x => x.status === 'FAIL'), [], JSON.stringify(r.checks)); assert.ok(r.ready); });
test('preflight: each requirement fails closed', () => {
  const f = (m) => preflight({ ...base(), ...m });
  assert.equal(status(f({ vidrDeclared: { ...vd(), reportType: 'x' } }), 'SOURCE_TYPE'), 'FAIL');
  assert.equal(status(f({ vidrText: 'not,a,report\n1,2,3' }), 'SOURCE_TYPE'), 'FAIL');
  assert.equal(status(f({ vidrDeclared: { ...vd(), options: 'PENDING_ONLY' } }), 'REPORT_OPTIONS'), 'FAIL');
  assert.equal(status(f({ vidrDeclared: { ...vd(), rangeFrom: '2026-01-01', rangeTo: '2026-12-31' } }), 'PERIOD'), 'FAIL');
  assert.equal(status(f({ vidrDeclared: { ...vd(), rangeFrom: '2026-12-01', rangeTo: '2026-11-01' } }), 'PERIOD'), 'FAIL');
  assert.equal(status(f({ ledgerDeclared: { ...ld(), periodFrom: '2026-11-19', periodTo: '2026-11-19' } }), 'PERIOD_COVERAGE'), 'FAIL');
  assert.equal(status(f({ ledgerDeclared: { ...ld(), marketplace: 'OTHER' } }), 'MARKETPLACE'), 'FAIL');
  assert.equal(status(f({ ledgerDeclared: { ...ld(), complete: false } }), 'LEDGER_COMPLETE'), 'FAIL');
  assert.equal(f({ ledgerDeclared: { ...ld(), complete: false } }).ready, false);
  assert.equal(status(f({ vidrDeclared: { ...vd(), createdAfterUploadConfirmed: false } }), 'REPORT_FRESH'), 'WARN');
  assert.equal(status(f({ ledgerText: 'garbage' }), 'COMPATIBILITY'), 'FAIL');
});
test('preflight output contains no file values (order ids, document numbers, marketplace ids)', () => {
  const out = JSON.stringify(preflight(base()));
  for (const v of ['405-1000011-2000011', 'A-2001', 'S9011', 'A1RKKUPIHCS9HS', 'acme-books']) assert.ok(!out.includes(v), v);
});
async function setup() {
  const raw = memoryAdapter(), v = createVault(raw, { iterations: 1000 }); await v.create('correct horse battery'); const a = v.adapter;
  const s = createLoopStore(a); await s.addVidr({ text: F.PV, declared: vd() }); await s.addLedger({ text: F.PL1, profile: F.PROFILE, declared: ld() });
  return { raw, v, a, s, rec: createPilotRecord(a), p: await s.project(), imports: await s.imports() };
}
test('measurement: aggregate has only numbers and fixed words, no sensitive values, and labels seller-reported vs machine-verified', async () => {
  const { s, rec, p, imports } = await setup();
  await rec.setTimes({ manualMinutesBefore: 180, toolMinutesWith: 25 }); await rec.adjudicate(p.issues[0].key, 'CONFIRMED_REAL'); await rec.adjudicate(p.issues[1].key, 'FALSE_POSITIVE'); await rec.setMissed(1);
  const m = aggregateMetrics({ projection: p, record: await rec.read(), imports });
  assert.equal(m.sellerAdjudication.confirmedReal, 1); assert.equal(m.sellerAdjudication.falsePositive, 1); assert.deepEqual(m.sellerAdjudication.precisionAmongReviewed, { value: 0.5, reviewed: 2 });
  assert.equal(m.sellerAdjudication.recallComputable, false); assert.equal(m.sellerAdjudication.missedBySeller, 1);
  assert.equal(m.time.minutesSaved, 155); assert.equal(m.time.basis, 'SELLER_REPORTED'); assert.equal(m.resolvedBySubsequentImports.basis, 'MACHINE_VERIFIED_BY_LATER_FILE'); assert.equal(m.sellerReportedResolved.basis, 'SELLER_REPORTED');
  const out = JSON.stringify(m); for (const v of ['405-1000011-2000011', 'A-2001', 'S9011', 'A1RKKUPIHCS9HS', p.issues[0].key, 'acme-books', 'invoice']) assert.ok(!out.toLowerCase().includes(v.toLowerCase()) || v === 'invoice', v);
  assert.equal(await s.deleteEverything(), undefined);
});
test('measurement: refuses bad input, and the guard refuses free text', async () => {
  const { rec } = await setup();
  await assert.rejects(rec.setTimes({ manualMinutesBefore: -1, toolMinutesWith: 3 })); await assert.rejects(rec.setTimes({ manualMinutesBefore: 'abc', toolMinutesWith: 3 }));
  await assert.rejects(rec.adjudicate('nothex', 'CONFIRMED_REAL')); await assert.rejects(rec.adjudicate('a'.repeat(64), 'VERIFIED'));
  await assert.rejects(rec.setMissed(1.5)); assert.deepEqual(ADJUDICATIONS.length, 3);
  assert.throws(() => assertAggregateOnly({ a: { note: 'order 405-1' } })); assert.throws(() => assertAggregateOnly({ 'bad key': 1 }));
});
test('measurement record is encrypted in the vault storage and goes with whole-workspace deletion', async () => {
  const { raw, a, rec, v } = await setup(); await rec.setTimes({ manualMinutesBefore: 123.5, toolMinutesWith: 9 });
  const dump = JSON.stringify(await Promise.all((await raw.list()).map(async k => [k, await raw.get(k)]))); assert.ok(!dump.includes('manualMinutesBefore') && !dump.includes('SELLER_REPORTED') && !dump.includes('loop:pilot'));
  await a.clear(); assert.equal((await raw.list()).filter(k => k !== 'vault:meta').length, 0); void v;
});
test('aggregate metrics change when a later file closes a finding (machine-verified count), not when the seller declares', async () => {
  const raw = memoryAdapter(), s = createLoopStore(memoryAdapter()), rec = createPilotRecord(memoryAdapter());
  await s.addVidr({ text: F.PV, declared: vd() }); await s.addLedger({ text: F.PL1, profile: F.PROFILE, declared: ld() });
  const m0 = aggregateMetrics({ projection: await s.project(), record: await rec.read(), imports: await s.imports() }); assert.equal(m0.resolvedBySubsequentImports.count, 0); void raw;
});
