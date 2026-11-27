// Phase 0, seller-facing words: what a seller reads after deleting a file. No raw codes, no "undefined", no UTC clock, no claim the missing evidence used to support, no action line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoopStore } from '../src/loop/store.js';
import { memoryAdapter } from '../src/history.js';
import * as F from '../tools/make-loop-fixtures.mjs';

const lrow = (n, o) => [n, 'Factura', '2026-11-18', '2026-11-17', 'EUR', '121,00', '100,00', '21,00', o, 'Amazon.es'].join(';');
const REPORT = F.vidr([{ n: 1, status: 'InvoiceUploaded', num: 'AMZ-1' }, { n: 2, status: 'InvoiceUploaded', num: 'AMZ-2' }]);
async function run(which, opts = {}) {
  let c = 0; const s = createLoopStore(memoryAdapter(), { now: () => new Date(Date.parse('2026-11-27T11:00:00Z') + (c++) * 1000).toISOString(), offsetMinutes: () => 120 });
  const ids = { report: await s.addVidr({ text: REPORT, declared: F.VDECL('2026-11-20T10:00:00Z'), fileName: 'amazon-report.tsv' }),
    books1: await s.addLedger({ text: F.ledger([lrow('AMZ-1', F.O(1))]), profile: F.PROFILE, declared: F.LDECL({ exportedAt: '2026-11-20T11:00:00Z' }), fileName: 'books-nov-1.csv' }),
    books2: await s.addLedger({ text: F.ledger([lrow('AMZ-1', F.O(1)), lrow('AMZ-2', F.O(2))]), profile: F.PROFILE, declared: F.LDECL({ exportedAt: '2026-11-22T11:00:00Z' }), fileName: 'books-nov-2.csv' }) };
  await s.deleteImport(ids[which], { confirmed: true, ...opts });
  const g = (await s.project()).issues.find(i => i.family === 'BOOKS_GAP'); return { g, text: [g.card.title, g.card.what, g.card.why, g.card.stateLabel, g.card.stateNote ?? '', g.card.action, g.card.closesWhen].join(' | '), card: g.card, s };
}
for (const [which, file] of [['books2', 'books-nov-2.csv'], ['books1', 'books-nov-1.csv'], ['report', 'amazon-report.tsv']]) {
  test(`card after deleting ${which}: plain words, the seller's own clock, identifiers kept, no old claim, no action`, async () => {
    const { g, card, text } = await run(which);
    assert.ok(!/undefined|null/.test(text), 'no undefined or null on screen');
    assert.ok(!/SELLER_DELETED|VERIFIED_CLOSED|HISTORY_INCOMPLETE|PRESENT@|CLOSED@|UNDETERMINED/.test(text), 'no raw state or reason codes');
    assert.ok(!/\d{4}-\d{2}-\d{2}T|\d{2}:\d{2}:\d{2}|\dZ\b/.test(text), 'no ISO or UTC time');
    assert.ok(text.includes('27 Nov 2026, 13:00'), 'deleted at 11:00 UTC on a +02:00 clock reads 13:00'); assert.ok(card.what.includes(file));
    assert.ok(text.includes('405-1000002-2000002') && text.includes('S9002'), 'order and shipment identifiers stay in the title');
    assert.ok(!/does not contain it/.test(text), 'the claim the missing evidence supported is gone'); assert.equal(card.action, ''); assert.equal(card.closesWhen, '');
    assert.match(card.what, /history will still record that earlier evidence was deleted/); assert.match(card.what, /we cannot|can no longer/);
    assert.equal(card.stateLabel, 'History incomplete: a file you deleted was part of this'); assert.equal(g.state, 'HISTORY_INCOMPLETE');
  });
}
test('card wording per case: what the deleted file was, and what was recorded before', async () => {
  assert.match((await run('books2')).card.what, /That file closed this problem/); assert.match((await run('books2')).card.what, /found on books-nov-1\.csv, then closed on books-nov-2\.csv/);
  assert.match((await run('books1')).card.what, /where this problem was first seen/);
  const r = (await run('report')).card.what; assert.match(r, /Amazon report/); assert.match(r, /checks that used it can no longer be repeated/);
});
test('reason in words: retention and a custom reason, and the record carries the clock offset it was written on', async () => {
  const a = await run('books2', { reason: 'RETENTION_POLICY' }); assert.match(a.card.what, /Your retention setting deleted books-nov-2\.csv/); assert.ok(!/RETENTION_POLICY/.test(a.text));
  const b = await run('books2', { reason: 'wrong month' }); assert.match(b.card.what, /You deleted books-nov-2\.csv/); assert.match(b.card.what, /wrong month/);
  const d = await b.s.deletions(); assert.equal(d[0].utcOffsetMinutes, 120);
});
