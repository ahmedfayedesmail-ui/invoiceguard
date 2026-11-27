// The 59 Unsupported Confident Findings of the V1 stress run, as a fixed regression on the ORIGINAL synthetic files (test/fixtures/v1-59, see its README).
// SYNTHETIC data: these are not customer cases and the test does not claim Amazon issued any of these invoices. It claims only what the files support:
// in each of the 59 transactions two fields of one row contradict each other, so no confident finding may be raised.
// It uses the two files and their declarations only, never the generator's hidden metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createLoopStore } from '../src/loop/store.js';
import { memoryAdapter } from '../src/history.js';

const dir = new URL('./fixtures/v1-59/', import.meta.url), rd = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
const ids = rd('ids59.json'), sha = (t) => createHash('sha256').update(t).digest('hex');
const sellers = [...new Set(ids.map(i => i.seller))];
const all = [21, 56, 91, 126, 161, 196, 231, 266, 301, 336, 371, 406, 441, 476];
const projectSeller = async (d) => { let n = 0; const s = createLoopStore(memoryAdapter(), { now: () => new Date(Date.parse('2026-11-27T11:00:00Z') + (n++) * 1000).toISOString() });
  await s.addVidr({ text: d.vText, declared: d.vdecl, fileName: 'vidr.tsv' }); await s.addLedger({ text: d.lText, profile: d.profile, declared: d.ldecl, fileName: 'books.csv' }); return s.project(); };
const results = new Map();
for (const s of all) { const d = rd(`seller-${s}.json`); results.set(s, { d, p: await projectSeller(d) }); }

test('v1-59: the fixture is the original: 59 transactions in 11 affected sellers (the fixture holds 14 sellers: 3 of them carry no case in the 59), files pinned by sha256', () => {
  assert.equal(ids.length, 59); assert.equal(new Set(ids.map(i => i.amazonTransactionId + '|' + i.orderId + '|' + i.shippingId)).size, 59); assert.equal(sellers.length, 11);
  for (const s of all) { const { d } = results.get(s); assert.equal(sha(d.vText), d.vSha256, 'VIDR file of seller ' + s); assert.equal(sha(d.lText), d.lSha256, 'books file of seller ' + s); assert.equal(d.scenario, 'amazon_issued_invoices'); }
});
test('v1-59: the files of each of the 59 contradict themselves: is-amazon-invoiced TRUE with invoice-status InvoiceUploaded (the evidence is in the file, not in generator metadata)', () => {
  for (const i of ids) { const { d } = results.get(i.seller), [head, ...rows] = d.vText.trim().split('\n').map(l => l.split('\t')), col = (n) => head.indexOf(n);
    const mine = rows.filter(r => r[col('transaction-id')] === i.amazonTransactionId && r[col('order-id')] === i.orderId && r[col('shipping-id')] === i.shippingId);
    assert.ok(mine.length >= 1, 'transaction present in file ' + i.amazonTransactionId);
    assert.ok(mine.every(r => r[col('is-amazon-invoiced')] === 'TRUE' && r[col('invoice-status')] === 'InvoiceUploaded'), 'row contradicts itself ' + i.amazonTransactionId); }
});
test('v1-59: none of the 59 is a BOOKS_GAP, and none is ACTION_REQUIRED in any family', () => {
  for (const i of ids) { const { p } = results.get(i.seller), mine = p.issues.filter(x => x.subject?.transactionId === i.amazonTransactionId && x.subject?.orderId === i.orderId && x.subject?.shippingId === i.shippingId);
    assert.ok(!mine.some(x => x.family === 'BOOKS_GAP'), 'BOOKS_GAP for ' + i.amazonTransactionId);
    assert.ok(!mine.some(x => x.state === 'ACTION_REQUIRED'), 'ACTION_REQUIRED for ' + i.amazonTransactionId); }
});
test('v1-59: the engine shows exactly the contradicting transactions of each seller as UNDETERMINED (a count and a note, never a finding), and the 59 are among them', () => {
  // Independent count from the file alone: transactions whose rows say is-amazon-invoiced TRUE while invoice-status is not InvoiceCreatedByAmazon.
  const contradicting = (text) => { const [head, ...rows] = text.trim().split('\n').map(l => l.split('\t')), c = (n) => head.indexOf(n), tx = new Set();
    for (const r of rows) if (r[c('transaction-type')] === 'SHIPMENT' && r[c('is-amazon-invoiced')] === 'TRUE' && r[c('invoice-status')] !== 'InvoiceCreatedByAmazon') tx.add(r[c('transaction-id')]); return tx; };
  for (const s of all) { const { d, p } = results.get(s), tx = contradicting(d.vText), mine = ids.filter(i => i.seller === s);
    for (const i of mine) assert.ok(tx.has(i.amazonTransactionId), 'the file itself contradicts ' + i.amazonTransactionId);
    assert.equal(p.stats.amazonFlagUndetermined, tx.size, 'seller ' + s + ': undetermined count equals the contradicting transactions in the file');
    if (tx.size) { assert.ok(p.coverageNotes.some(n => /is-amazon-invoiced column \(TRUE\) and invoice-status \(InvoiceUploaded\) disagree/.test(n.reason)), 'note for seller ' + s); assert.equal(p.coverage.undetermined.byReason.AMAZON_INVOICED_FLAG_UNREADABLE_OR_CONFLICTING, tx.size); } }
  assert.equal(ids.length, 59);
});
test('v1-59: the three other sellers of the scenario give no confident finding either; none of the 14 fixture sellers has any BOOKS_GAP', () => {
  for (const s of all) assert.deepEqual(results.get(s).p.issues.filter(x => x.family === 'BOOKS_GAP' || x.state === 'ACTION_REQUIRED').map(x => x.family), [], 'seller ' + s);
});
