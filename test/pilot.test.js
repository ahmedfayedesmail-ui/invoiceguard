import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../tools/make-loop-fixtures.mjs';
import { preflight, preflightPending, preflightStored, pilotScope, createPilotRecord, aggregateMetrics, assertAggregateOnly, ADJUDICATIONS } from '../src/loop/pilot.js';
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

test('correction 2: both times must be present, finite and non-negative; empty is never zero; incomplete stays unavailable', async () => {
  const { rec, p, imports } = await setup();
  for (const bad of [{}, { manualMinutesBefore: '', toolMinutesWith: '' }, { manualMinutesBefore: '10', toolMinutesWith: '' }, { manualMinutesBefore: '', toolMinutesWith: '5' }, { manualMinutesBefore: null, toolMinutesWith: 5 }, { manualMinutesBefore: 10, toolMinutesWith: undefined }, { manualMinutesBefore: 'x', toolMinutesWith: 5 }, { manualMinutesBefore: -1, toolMinutesWith: 5 }, { manualMinutesBefore: Infinity, toolMinutesWith: 5 }, { manualMinutesBefore: 10, toolMinutesWith: NaN }]) await assert.rejects(rec.setTimes(bad), JSON.stringify(bad));
  assert.equal(aggregateMetrics({ projection: p, record: await rec.read(), imports }).time, null);
  await rec.setTimes({ manualMinutesBefore: 0, toolMinutesWith: 0 }); assert.equal(aggregateMetrics({ projection: p, record: await rec.read(), imports }).time.minutesSaved, 0);
  await rec.setTimes({ manualMinutesBefore: '30', toolMinutesWith: '12.5' }); assert.equal(aggregateMetrics({ projection: p, record: await rec.read(), imports }).time.minutesSaved, 17.5);
  assert.equal(aggregateMetrics({ projection: p, record: { times: { basis: 'SELLER_REPORTED', manualMinutesBefore: 5, toolMinutesWith: null } }, imports }).time, null);
});

test('correction 3: pilot scope is one marketplace and one period; a different scope is refused at preflight and blocks the aggregate', async () => {
  const { s, rec, p, imports } = await setup();
  const sc = pilotScope(imports); assert.equal(sc.distinctScopes, 1);
  const other = { ...vd(), rangeFrom: '2026-10-01', rangeTo: '2026-10-31' };
  const pf = preflight({ ...base(), vidrDeclared: other, ledgerText: undefined, ledgerDeclared: undefined, scope: sc }); assert.equal(status(pf, 'PILOT_SCOPE'), 'FAIL'); assert.equal(pf.ready, false);
  const mk = preflight({ ...base(), vidrDeclared: { ...vd(), marketplace: 'A13V1IB3VIYZZH' }, ledgerText: undefined, ledgerDeclared: undefined, scope: sc }); assert.equal(status(mk, 'PILOT_SCOPE'), 'FAIL');
  const same = preflight({ ...base(), ledgerText: undefined, ledgerDeclared: undefined, scope: sc }); assert.equal(status(same, 'PILOT_SCOPE'), 'PASS');
  const m = aggregateMetrics({ projection: p, record: await rec.read(), imports }); assert.deepEqual([m.pilotScope.distinctMarketplaces, m.pilotScope.distinctPeriods, m.pilotScope.periodDays], [1, 1, 30]); assert.equal(m.preflightOnThisData.ready, true); assert.equal(m.sampleSize, undefined);
  await s.addVidr({ text: F.PV, declared: other });  // forced past the page: the aggregate must still refuse
  const imps2 = await s.imports(); assert.equal(pilotScope(imps2).distinctScopes, 2);
  assert.throws(() => aggregateMetrics({ projection: p, record: await_free(rec), imports: imps2 }), /more than one marketplace or period/);
  assert.equal(preflightStored(imps2).ready, false);
});
const await_free = () => ({});
test('wording: source type is labelled seller-declared and the file origin is not claimed as verified', () => {
  const d = preflight(base()).checks.find(x => x.id === 'SOURCE_TYPE').detail; assert.match(d, /Seller-declared/); assert.match(d, /cannot be verified/); assert.ok(!/verified as|is verified|confirmed as/.test(d));
});
test('preflight works one file at a time and says the pair checks wait', () => {
  const v = preflight({ vidrText: F.PV, vidrDeclared: vd() }); assert.ok(v.checks.some(x => x.id === 'PAIR' && x.status === 'NOTE')); assert.equal(status(v, 'PERIOD_COVERAGE'), undefined); assert.ok(!v.warnings.includes('PAIR'));
});

// ---- final P4 integrity: the whole stored dataset decides, not the latest pair ----
let tick = 0; const clock = () => new Date(Date.parse('2026-11-20T10:00:00Z') + (tick++) * 60000).toISOString();
const mkStore = () => createLoopStore(memoryAdapter(), { now: clock });
const ids = (r, st) => r.checks.filter(x => x.status === st).map(x => x.id);
async function agg(s) { return aggregateMetrics({ projection: await s.project(), record: { adjudications: {}, missedBySeller: 0 }, imports: await s.imports() }); }

test('dataset: a missing Amazon report, or a missing accounting export, is not a pilot and no aggregate is produced', async () => {
  const a = mkStore(); await a.addLedger({ text: F.PL1, profile: F.PROFILE, declared: ld() });
  assert.ok(ids(preflightStored(await a.imports()), 'FAIL').includes('VIDR_PRESENT')); await assert.rejects(agg(a), /do not pass the pilot preflight.*VIDR_PRESENT/);
  const b = mkStore(); await b.addVidr({ text: F.PV, declared: vd() });
  assert.ok(ids(preflightStored(await b.imports()), 'FAIL').includes('LEDGER_PRESENT')); await assert.rejects(agg(b), /LEDGER_PRESENT/);
  assert.equal(preflightStored([]).ready, false);
});
test('dataset: a valid latest pair does not hide an older incompatible import', async () => {
  const s = mkStore(); await s.addVidr({ text: F.PV, declared: { ...vd(), rangeFrom: '2026-10-01', rangeTo: '2026-10-31' } });   // older, other period
  await s.addVidr({ text: F.PV, declared: vd() }); await s.addLedger({ text: F.PL1, profile: F.PROFILE, declared: ld() });
  const r = preflightStored(await s.imports()); assert.equal(r.ready, false); assert.ok(ids(r, 'FAIL').includes('PILOT_SCOPE')); await assert.rejects(agg(s), /PILOT_SCOPE|more than one marketplace or period/);
  const t = mkStore(); await t.addVidr({ text: F.PV, declared: { ...vd(), options: 'PENDING_ONLY' } }); await t.addVidr({ text: F.PV, declared: vd() }); await t.addLedger({ text: F.PL1, profile: F.PROFILE, declared: ld() });
  assert.ok(ids(preflightStored(await t.imports()), 'FAIL').includes('REPORT_OPTIONS'), 'an older pending-only report must fail the dataset');
});
test('dataset: several accounting exports must all match the marketplace and cover the period', async () => {
  for (const [label, bad] of [['marketplace', { marketplace: 'A13V1IB3VIYZZH' }], ['period', { periodFrom: '2026-11-10', periodTo: '2026-11-30' }], ['incomplete', { complete: false }]]) {
    const s = mkStore(); await s.addVidr({ text: F.PV, declared: vd() }); await s.addLedger({ text: F.PL1, profile: F.PROFILE, declared: ld() }); await s.addLedger({ text: F.PL2, profile: F.PROFILE, declared: { ...ld(), ...bad } });
    const r = preflightStored(await s.imports()); assert.equal(r.ready, false, label); await assert.rejects(agg(s), /do not pass/, label);
  }
});
test('dataset: aggregate is blocked by a failed preflight even when only one file is bad', async () => {
  const s = mkStore(); await s.addVidr({ text: F.PV, declared: vd() }); await s.addLedger({ text: F.PL1, profile: F.PROFILE, declared: { ...ld(), complete: false } });
  await assert.rejects(agg(s), /LEDGER_COMPLETE/);
});
test('dataset: a fully valid multi-import pilot still produces its aggregate, WARNs stay visible', async () => {
  const s = mkStore(); await s.addVidr({ text: F.PV, declared: vd() }); await s.addLedger({ text: F.PL1, profile: F.PROFILE, declared: ld() });
  await s.addVidr({ text: F.PV, declared: { ...vd(), createdAfterUploadConfirmed: false } }); await s.addLedger({ text: F.PL2, profile: F.PROFILE, declared: ld() });
  const r = preflightStored(await s.imports()); assert.equal(r.ready, true, JSON.stringify(r.checks)); assert.ok(r.warnings.includes('REPORT_FRESH'), 'the WARN must stay a WARN');
  const m = await agg(s); assert.deepEqual([m.imports.amazonReports, m.imports.accountingExports, m.preflightOnThisData.ready, m.preflightOnThisData.warn >= 1], [2, 2, true, true]);
});
test('staged: the pending file is checked against EVERY stored file, not the latest opposite one', async () => {
  const s = mkStore(); await s.addVidr({ text: F.PV, declared: vd() }); await s.addLedger({ text: F.PL1, profile: F.PROFILE, declared: { ...ld(), periodFrom: '2026-11-10', periodTo: '2026-11-30' } }).catch(() => {});
  const imps = await s.imports();
  const pv = preflightPending('vidr', { text: F.PV, declared: { ...vd(), marketplace: 'A13V1IB3VIYZZH' } }, imps); assert.equal(pv.ready, false); assert.ok(ids(pv, 'FAIL').includes('PILOT_SCOPE') || ids(pv, 'FAIL').includes('MARKETPLACE'));
  const pl = preflightPending('ledger', { text: F.PL1, profile: F.PROFILE, declared: { ...ld(), periodFrom: '2026-11-10', periodTo: '2026-11-30' } }, imps); assert.equal(pl.ready, false); assert.ok(ids(pl, 'FAIL').includes('PERIOD_COVERAGE'));
  const ok = preflightPending('ledger', { text: F.PL2, profile: F.PROFILE, declared: ld() }, imps); assert.equal(ok.ready, true, JSON.stringify(ok.checks)); assert.ok(!ok.checks.some(x => x.id === 'VIDR_PRESENT'), 'presence is not required while the dataset is being built');
  const first = preflightPending('vidr', { text: F.PV, declared: { ...vd(), rangeFrom: '2026-10-01', rangeTo: '2026-10-31' } }, (await s.imports()).filter(i => i.kind === 'ledger'));
  assert.equal(first.ready, false, 'a first Amazon report outside the stored export period must be refused');
});

// ---- truncated files: a partial read is never a complete pilot ----
const bigLedger = (n) => { const rows = []; for (let k = 1; k <= n; k++) rows.push([`B-${k}`, 'Factura', '2026-11-18', '2026-11-17', 'EUR', '121,00', '100,00', '21,00', F.O(100 + k), 'Amazon.es'].join(';')); return F.LH + '\n' + rows.join('\n') + '\n'; };
const bigVidr = (n) => { const rows = []; for (let k = 1; k <= n; k++) rows.push({ n: 100 + k, status: 'InvoiceUploaded', num: 'B-' + k }); return F.vidr(rows); };
test('truncation: a pending accounting export over the row limit is blocked, with an explanation', () => {
  const r = preflight({ ...base(), ledgerText: bigLedger(20001) }); assert.equal(status(r, 'LEDGER_ROWS'), 'FAIL'); assert.equal(r.ready, false);
  assert.match(r.checks.find(x => x.id === 'LEDGER_ROWS').detail, /more than 20000 data rows.*not be fully processed/);
  const pend = preflightPending('ledger', { text: bigLedger(20001), profile: F.PROFILE, declared: ld() }, []); assert.equal(pend.ready, false); assert.ok(ids(pend, 'FAIL').includes('LEDGER_ROWS'));
  const v = preflight({ ...base(), vidrText: bigVidr(20001) }); assert.equal(status(v, 'VIDR_ROWS'), 'FAIL'); assert.equal(v.ready, false);
});
test('truncation: a stored truncated import fails the whole dataset and the aggregate is refused; exactly at the limit still passes', async () => {
  const s = mkStore(); await s.addVidr({ text: F.PV, declared: vd() }); await s.addLedger({ text: bigLedger(20001), profile: F.PROFILE, declared: ld() });
  const r = preflightStored(await s.imports()); assert.equal(r.ready, false); assert.ok(ids(r, 'FAIL').includes('LEDGER_ROWS')); await assert.rejects(agg(s), /LEDGER_ROWS/);
  const t = mkStore(); await t.addVidr({ text: bigVidr(20001), declared: vd() }); await t.addLedger({ text: F.PL1, profile: F.PROFILE, declared: ld() });
  assert.ok(ids(preflightStored(await t.imports()), 'FAIL').includes('VIDR_ROWS')); await assert.rejects(agg(t), /VIDR_ROWS/);
  const ok = preflight({ ...base(), ledgerText: bigLedger(20000), vidrText: bigVidr(20000) }); assert.notEqual(status(ok, 'LEDGER_ROWS'), 'FAIL'); assert.notEqual(status(ok, 'VIDR_ROWS'), 'FAIL'); assert.equal(ok.checks.find(x => x.id === 'VIDR_ROWS'), undefined);
  assert.equal(preflight(base()).ready, true);
});
