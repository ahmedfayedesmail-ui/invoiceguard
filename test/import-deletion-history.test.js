// Phase 0: deleting an import must never forge the past. The file content may be removed; a permanent record of the deletion and the affected findings stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoopStore } from '../src/loop/store.js';
import { memoryAdapter } from '../src/history.js';
import * as F from '../tools/make-loop-fixtures.mjs';

const lrow = (num, order) => [num, 'Factura', '2026-11-18', '2026-11-17', 'EUR', '121,00', '100,00', '21,00', order, 'Amazon.es'].join(';');
const REPORT = F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'AMZ-1' }, { n: 2, status: 'InvoiceUploaded', num: 'AMZ-2' }]);
const BOOKS1 = F.ledger([lrow('AMZ-1', F.O(1))]), BOOKS2 = F.ledger([lrow('AMZ-1', F.O(1)), lrow('AMZ-2', F.O(2))]);
async function setup() {
  let c = 0; const adapter = memoryAdapter(), s = createLoopStore(adapter, { now: () => new Date(Date.parse('2026-11-27T11:00:00Z') + (c++) * 1000).toISOString() });
  const report = await s.addVidr({ text: REPORT, declared: F.VDECL('2026-11-20T10:00:00Z'), fileName: 'report.tsv' });
  const books1 = await s.addLedger({ text: BOOKS1, profile: F.PROFILE, declared: F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), fileName: 'books1.csv' });
  const books2 = await s.addLedger({ text: BOOKS2, profile: F.PROFILE, declared: F.LDECL({ exportedAt: '2026-11-22T11:00:00Z' }), fileName: 'books2.csv' });
  return { s, adapter, report, books1, books2 };
}
const gap = (p) => p.issues.filter(i => i.family === 'BOOKS_GAP');

test('baseline: the finding is opened by books1 and closed by books2', async () => {
  const { s } = await setup(), [g] = gap(await s.project());
  assert.equal(gap(await s.project()).length, 1); assert.equal(g.state, 'VERIFIED_CLOSED'); assert.ok(!g.historyIncomplete);
});

test('deleting the closing file never turns a closed finding silently into an open one', async () => {
  const { s, books2 } = await setup(); const before = gap(await s.project())[0];
  await s.deleteImport(books2, { confirmed: true, reason: 'seller removed the export' });
  const [g] = gap(await s.project());
  assert.notEqual(g.state, 'ACTION_REQUIRED'); assert.notEqual(g.state, 'OPEN');
  assert.equal(g.state, 'HISTORY_INCOMPLETE'); assert.equal(g.historyIncomplete, true); assert.equal(g.priorRecordedState, 'VERIFIED_CLOSED');
  assert.equal(g.key, before.key); assert.equal(g.deletedImports[0].fileName, 'books2.csv'); assert.equal(g.deletedImports[0].reason, 'seller removed the export');
  assert.deepEqual(g.recordedBeforeDeletion.history.map(h => h.status + '@' + h.file), ['PRESENT@books1.csv', 'CLOSED@books2.csv']);
});

test('deleting the file that created the finding never erases that it existed', async () => {
  const { s, books1 } = await setup(); const before = gap(await s.project())[0];
  await s.deleteImport(books1, { confirmed: true });
  const found = gap(await s.project()); assert.equal(found.length, 1, 'the finding must not disappear');
  assert.equal(found[0].key, before.key); assert.equal(found[0].state, 'HISTORY_INCOMPLETE'); assert.equal(found[0].historyIncomplete, true);
  assert.deepEqual(found[0].recordedBeforeDeletion.history.map(h => h.status + '@' + h.file), ['PRESENT@books1.csv', 'CLOSED@books2.csv']);
  assert.equal(found[0].subject.amazonId, before.subject.amazonId);
});

test('deleting the Amazon report never erases the trace of earlier checks', async () => {
  const { s, report } = await setup(); const before = gap(await s.project())[0];
  await s.deleteImport(report, { confirmed: true, reason: 'wrong report' });
  const p = await s.project(), found = gap(p); assert.equal(found.length, 1);
  assert.equal(found[0].key, before.key); assert.equal(found[0].state, 'HISTORY_INCOMPLETE'); assert.equal(found[0].deletedImports[0].kind, 'vidr');
  assert.equal(p.buckets.historyIncomplete, 1); assert.equal(p.buckets.closedWithEvidence, 0, 'a finding whose evidence is gone is not counted as closed by evidence');
  assert.equal(p.buckets.needsActionNow, 0);
});

test('a permanent record exists: reason, affected import, affected cases; the file content is gone', async () => {
  const { s, adapter, books2 } = await setup(), key = gap(await s.project())[0].key;
  const text = BOOKS2.split('\n')[2];
  await s.deleteImport(books2, { confirmed: true, reason: 'seller removed the export' });
  const [d] = await s.deletions(); assert.ok(d.id && d.deletedAt);
  assert.equal(d.reason, 'seller removed the export'); assert.equal(d.import.id, books2); assert.equal(d.import.fileName, 'books2.csv'); assert.equal(d.import.kind, 'ledger'); assert.match(d.import.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(d.affected.map(a => [a.key, a.recordedState]), [[key, 'VERIFIED_CLOSED']]);
  const all = JSON.stringify(await Promise.all((await adapter.list()).map(k => adapter.get(k)))); assert.ok(!all.includes(text), 'file content must be removed'); assert.ok(!(await s.imports()).some(i => i.id === books2));
  const b = await s.bundle(); assert.equal(b.deletions.length, 1); assert.equal(b.issues[0].historyIncomplete, true);
});

test('the marker is permanent: it survives later imports, a second deletion and a re-projection', async () => {
  const { s, books1, books2 } = await setup();
  await s.deleteImport(books2, { confirmed: true });
  const books3 = await s.addLedger({ text: BOOKS2, profile: F.PROFILE, declared: F.LDECL({ exportedAt: '2026-11-25T11:00:00Z' }), fileName: 'books3.csv' });
  let [g] = gap(await s.project()); assert.equal(g.historyIncomplete, true, 'closing again by a new file does not clear the marker'); assert.equal(g.deletedImports.length, 1);
  await s.deleteImport(books1, { confirmed: true, reason: 'second removal' }); void books3;
  [g] = gap(await s.project()); assert.equal(g.historyIncomplete, true); assert.equal(g.deletedImports.length, 2); assert.equal((await s.deletions()).length, 2);
});

test('refused deletion leaves no record and no marker; deleting something that affects nothing records an empty case list', async () => {
  const { s, books2 } = await setup();
  await assert.rejects(() => s.deleteImport(books2), /confirmation/); assert.equal((await s.deletions()).length, 0); assert.ok(!gap(await s.project())[0].historyIncomplete);
  const extra = await s.addLedger({ text: F.ledger([lrow('ZZ-9', F.O(9))]), profile: F.PROFILE, declared: F.LDECL({ exportedAt: '2026-11-26T11:00:00Z' }), fileName: 'other.csv' });
  const hadMarker = (await s.project()).issues.filter(i => i.historyIncomplete).length;
  await s.deleteImport(extra, { confirmed: true }); const [d] = await s.deletions();
  assert.equal(d.reason, 'SELLER_DELETED'); assert.equal((await s.project()).issues.filter(i => i.historyIncomplete).length, hadMarker + d.affected.length);
});

test('retention deletion is recorded with its own reason', async () => {
  const { s } = await setup(); await s.setSettings({ retention: { mode: 'AFTER_DAYS', days: 30, confirmedAt: '2026-11-27T11:00:00Z' } });
  const r = await s.applyRetention('2027-06-01T00:00:00Z'); assert.equal(r.deleted.length, 3);
  assert.ok((await s.deletions()).every(d => d.reason === 'RETENTION_POLICY'));
});

test('a seller statement about a finding survives the deletion of the file that created it, and a placeholder finding accepts no new statement', async () => {
  let c = 0; const s = createLoopStore(memoryAdapter(), { now: () => new Date(Date.parse('2026-11-27T11:00:00Z') + (c++) * 1000).toISOString() });
  await s.addVidr({ text: REPORT, declared: F.VDECL('2026-11-20T10:00:00Z'), fileName: 'report.tsv' });
  const b1 = await s.addLedger({ text: BOOKS1, profile: F.PROFILE, declared: F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), fileName: 'books1.csv' });
  const open = gap(await s.project()).find(i => i.state === 'ACTION_REQUIRED'); assert.ok(open, 'AMZ-2 is missing from books1');
  await s.addEvent({ type: 'ACTION_STARTED', issueKey: open.key, author: 'shop owner', reasoning: 'I started the export of AMZ-2' });
  await s.deleteImport(b1, { confirmed: true });
  const after = (await s.project()).issues.find(i => i.key === open.key);
  assert.ok(after, 'the finding must still be listed'); assert.equal(after.historyIncomplete, true); assert.equal(after.events.length, 1, 'the statement is kept');
  assert.equal(after.recordedBeforeDeletion.history[0].status, 'PRESENT');
  if (after.placeholder) await assert.rejects(() => s.addEvent({ type: 'ACTION_STARTED', issueKey: open.key, author: 'a', reasoning: 'x' }), /history of that problem is incomplete/);
});
