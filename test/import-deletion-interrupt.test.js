// Phase 0, interruption safety: a deletion is a state machine PENDING -> COMMITTED. Only COMMITTED is a deletion. A crash at either step never leaves a false statement about the seller's data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoopStore } from '../src/loop/store.js';
import { project } from '../src/loop/project.js';
import { memoryAdapter } from '../src/history.js';
import * as F from '../tools/make-loop-fixtures.mjs';

const lrow = (n, o) => [n, 'Factura', '2026-11-18', '2026-11-17', 'EUR', '121,00', '100,00', '21,00', o, 'Amazon.es'].join(';');
const REPORT = F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'AMZ-1' }, { n: 2, status: 'InvoiceUploaded', num: 'AMZ-2' }]);
// A process that dies: after the trip point every write throws, like a tab that was closed.
function crashing(base, trip) { let dead = false; const die = () => { dead = true; throw new Error('process died'); };
  return { async get(k) { return base.get(k); }, async list() { return base.list(); }, async clear() { return base.clear(); },
    async put(k, v) { if (dead) throw new Error('process died'); if (trip({ op: 'put', k, v })) die(); return base.put(k, v); },
    async del(k) { if (dead) throw new Error('process died'); if (trip({ op: 'del', k })) die(); return base.del(k); } };
}
const mkClock = () => { let t = Date.parse('2026-11-27T11:00:00Z'); const clock = { now: () => new Date(t++).toISOString(), advance: (ms) => { t += ms; } }; return clock; };
async function setup() {
  const base = memoryAdapter(), clock = mkClock(), s = createLoopStore(base, { now: clock.now, offsetMinutes: () => 120 });
  const ids = { report: await s.addVidr({ text: REPORT, declared: F.VDECL('2026-11-20T10:00:00Z'), fileName: 'report.tsv' }),
    books1: await s.addLedger({ text: F.ledger([lrow('AMZ-1', F.O(1))]), profile: F.PROFILE, declared: F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), fileName: 'books1.csv' }),
    books2: await s.addLedger({ text: F.ledger([lrow('AMZ-1', F.O(1)), lrow('AMZ-2', F.O(2))]), profile: F.PROFILE, declared: F.LDECL({ exportedAt: '2026-11-22T11:00:00Z' }), fileName: 'books2.csv' }) };
  const reopen = (adapter = base) => createLoopStore(adapter, { now: clock.now, offsetMinutes: () => 120 });
  return { base, clock, ids, reopen, before: await s.project() };
}
const gap = (p) => p.issues.find(i => i.family === 'BOOKS_GAP');
const statuses = async (s) => (await s.deletions()).map(d => d.status);

test('interruption 1: after the record is written and before the file is deleted, the seller sees the untouched picture', async () => {
  const { base, ids, reopen, before } = await setup();
  const dying = reopen(crashing(base, ({ op, k }) => op === 'del' && k.startsWith('loop:import:')));
  await assert.rejects(() => dying.deleteImport(ids.books2, { confirmed: true }), /process died/);
  const s2 = reopen(); assert.equal((await s2.imports()).length, 3, 'the file is still there');
  assert.deepEqual(await statuses(s2), ['PENDING']);
  const g = gap(await s2.project()); assert.ok(!g.historyIncomplete, 'a pending record is not a deletion'); assert.equal(g.state, 'VERIFIED_CLOSED');
  assert.deepEqual(JSON.stringify(await s2.project()), JSON.stringify(before), 'identical to the picture before the attempt');
});
test('interruption 2: after the file is deleted and before COMMITTED is written, recovery completes the record once', async () => {
  const { base, ids, reopen } = await setup();
  const dying = reopen(crashing(base, ({ op, v }) => op === 'put' && v?.status === 'COMMITTED'));
  await assert.rejects(() => dying.deleteImport(ids.books2, { confirmed: true }), /process died/);
  const s2 = reopen(); assert.equal((await s2.imports()).length, 2, 'the file is gone');
  assert.deepEqual(await statuses(s2), ['PENDING']);
  const g = gap(await s2.project()); assert.equal(g.historyIncomplete, true, 'the file really is gone, so the history is incomplete'); assert.equal(g.state, 'HISTORY_INCOMPLETE');
  assert.deepEqual(await statuses(s2), ['COMMITTED']);
});
test('retry after interruption 1: one record, committed, no duplicate; after interruption 2: one record, no loss, nothing to redo', async () => {
  const a = await setup(); const d1 = a.reopen(crashing(a.base, ({ op, k }) => op === 'del' && k.startsWith('loop:import:')));
  await assert.rejects(() => d1.deleteImport(a.ids.books2, { confirmed: true }), /process died/);
  const idPending = (await a.reopen().deletions())[0].id; const s1 = a.reopen(); await s1.deleteImport(a.ids.books2, { confirmed: true });
  const recs = await s1.deletions(); assert.equal(recs.length, 1); assert.equal(recs[0].status, 'COMMITTED'); assert.equal(recs[0].id, idPending, 'the retry reuses the pending record');
  assert.equal(gap(await s1.project()).historyIncomplete, true);
  const b = await setup(); const d2 = b.reopen(crashing(b.base, ({ op, v }) => op === 'put' && v?.status === 'COMMITTED'));
  await assert.rejects(() => d2.deleteImport(b.ids.books2, { confirmed: true }), /process died/);
  const s2 = b.reopen(); await s2.recoverDeletions(); await s2.recoverDeletions(); await assert.rejects(() => s2.deleteImport(b.ids.books2, { confirmed: true }), /not stored/);
  const r2 = await s2.deletions(); assert.equal(r2.length, 1); assert.equal(r2[0].status, 'COMMITTED'); assert.equal(r2[0].import.fileName, 'books2.csv');
});
test('a pending record whose file is still present is discarded after the grace period, never kept forever and never discarded while a deletion may be running', async () => {
  const { base, clock, ids, reopen, before } = await setup();
  const dying = reopen(crashing(base, ({ op, k }) => op === 'del' && k.startsWith('loop:import:')));
  await assert.rejects(() => dying.deleteImport(ids.books2, { confirmed: true }), /process died/);
  const s2 = reopen(); await s2.recoverDeletions(); assert.deepEqual(await statuses(s2), ['PENDING'], 'young: a deletion may still be running in another tab, so it is left alone');
  clock.advance(6 * 60 * 1000); const out = await s2.recoverDeletions(); assert.deepEqual(await statuses(s2), []); assert.equal(out.discarded.length, 1);
  assert.equal((await s2.imports()).length, 3); assert.deepEqual(JSON.stringify(await s2.project()), JSON.stringify(before), 'the data is untouched');
  await s2.recoverDeletions(); assert.deepEqual(await statuses(s2), [], 'safe to retry');
});
test('project() itself ignores a pending record', async () => {
  const { reopen, ids } = await setup(); const s = reopen(), imports = await s.imports(), events = await s.events();
  const pending = { id: 'del-x', status: 'PENDING', deletedAt: '2026-11-27T11:00:00.000Z', reason: 'SELLER_DELETED', import: { id: ids.books2, kind: 'ledger', fileName: 'books2.csv' }, affected: [{ key: 'k', family: 'BOOKS_GAP', subtype: 'X', subject: {}, recordedState: 'VERIFIED_CLOSED', recordedHistory: [] }] };
  const p = project({ imports, events, sellerProfileId: await s.profileId(), deletions: [pending] }); assert.ok(!p.issues.some(i => i.historyIncomplete || i.key === 'k'));
});
