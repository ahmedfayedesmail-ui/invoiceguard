// Round-8: independent-reviewer findings. TOCTOU duplicate submission (F1), pollFeeds per-feed
// isolation (F2), crash window between status write and proposal (F3), dryRun is dry (F4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { processReport, processCorrections as processCorrectionsRaw, pollFeeds } from '../src/pipeline.js';
import { withApproval } from './correction-helpers.js';
const processCorrections = withApproval(processCorrectionsRaw); // owner decision Nov 28: a person approves the pair first (older tests, assertions unchanged)
import { listRepairs } from '../src/repair.js';
import { parseVidr } from '../src/vidr.js';

const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const seller = { id: 'selR8', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const vies = async (v) => ({ status: 'valid', vat: v });
const tick = () => new Promise(r => setImmediate(r));

const withDesc = (head, row, status, desc) => {
  const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const r = [...row];
  while (r.length < c.length) r.push('');
  if (status) r[ix('invoice-status')] = status;
  r.push(desc ?? '');
  return [head + '\tinvoice-status-description', r.join('\t')].join('\n');
};
const singleRow = (status, desc) => {
  const [head, ...rows] = text.trim().split('\n');
  return withDesc(head, rows[0].split('\t'), status, desc);
};
function correctionPair() {
  const [head, ...rows] = text.trim().split('\n'); const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const row = rows[0].split('\t');
  const rev = [...row]; rev[ix('transaction-type')] = 'REFUND'; rev[ix('transaction-id')] = 'CorrectionReversal:X:1';
  ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'].forEach(n => { rev[ix(n)] = '-' + rev[ix(n)]; });
  rev[ix('invoice-status')] = 'CreditNotePending';
  const fixed = [...row]; fixed[ix('transaction-id')] = 'Correction::X:2'; fixed[ix('billing-name')] = 'Mediterranea Logistica Norte S.L.'; fixed[ix('is-invoice-corrected')] = undefined;
  return [head, rev.join('\t'), fixed.join('\t')].join('\n');
}

test('F1: two overlapping syncs upload the same shipment exactly once', async () => {
  const db = openDb();
  let uploads = 0;
  // The upload yields, so both runs are inside processReport at the same time - the exact
  // interleaving the reviewer flagged: both pass the early reads before either writes.
  const api = { uploadInvoice: async () => { uploads++; await tick(); await tick(); return 'f' + uploads; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  const [r1, r2] = await Promise.all([
    processReport(db, seller, singleRow(null), { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') }),
    processReport(db, seller, singleRow(null), { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') }),
  ]);
  assert.equal(uploads, 1, 'exactly one execution talked to Amazon');
  assert.equal(r1.uploaded + r2.uploaded, 1);
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='invoice'").get(seller.id).c, 1, 'exactly one invoice exists');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND feed_id IS NOT NULL").get(seller.id).c, 1);
});

test('F1: two overlapping correction passes issue and upload exactly one credit note', async () => {
  const db = openDb();
  let uploads = 0;
  const api0 = { uploadInvoice: async () => 'f0', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, text, { api: api0, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const api = { uploadInvoice: async () => { uploads++; await tick(); await tick(); return 'f' + uploads; }, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  const [r1, r2] = await Promise.all([
    processCorrections(db, seller, correctionPair(), { api, validate: vies }),
    processCorrections(db, seller, correctionPair(), { api, validate: vies }),
  ]);
  assert.equal(r1.creditNotes + r2.creditNotes, 1, 'one pass issued the credit note');
  assert.equal(uploads, 1, 'exactly one upload reached Amazon');
  assert.equal(db.prepare("SELECT count(*) c FROM invoices WHERE seller_id=? AND kind='rectificativa'").get(seller.id).c, 1, 'exactly one correction document exists');
});

test('F2: one failing feed never aborts polling - 404 becomes unknown+hold, transient errors skip only that feed', async () => {
  const db = openDb();
  const api0 = { uploadInvoice: async (a) => 'feed-' + a.number, feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  // two shipments due: build a two-row report
  const [head, ...rows] = text.trim().split('\n');
  const two = [head, rows[0], rows[1]].join('\n');
  await processReport(db, seller, two, { api: api0, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const docs = db.prepare("SELECT number, feed_id FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number").all(seller.id);
  assert.equal(docs.length, 2, 'both invoices uploaded and polling is pending');
  // feed 1: aged out of Amazon's 90-day retention (404). feed 2: still DONE.
  const api404 = { feedStatus: async (id) => { if (id === docs[0].feed_id) throw new Error('SP-API GET /feeds/2021-06-30/feeds/' + id + ' -> 404 {"errors":[{"code":"NotFound"}]}'); return { status: 'DONE' }; }, listFeeds: async () => [] };
  const r = await pollFeeds(db, seller, api404);
  assert.equal(r.unknown, 1, 'the 404 feed went to unknown');
  assert.equal(r.processing, 1, 'the other feed was still polled');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, docs[0].number).upload_status, 'unknown');
  assert.ok(listRepairs(db, seller.id).some(x => x.kind === 'unknown_outcome'), 'the 404 hold is visible to a human');
  // reset both to submitted, then a TRANSIENT error on feed 1: skipped, not aborted
  db.prepare("UPDATE invoices SET upload_status='submitted' WHERE seller_id=?").run(seller.id);
  const apiFlaky = { feedStatus: async (id) => { if (id === docs[0].feed_id) throw new Error('socket hang up'); return { status: 'DONE' }; }, listFeeds: async () => [] };
  const r2 = await pollFeeds(db, seller, apiFlaky);
  assert.equal(r2.errors, 1, 'the failing feed was counted and skipped');
  assert.equal(r2.processing, 1, 'the healthy feed was still polled');
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, docs[0].number).upload_status, 'submitted', 'the skipped feed kept its state');
});

test('F3: a crash inside CANCELLED handling writes neither the status nor the proposal', async () => {
  const db = openDb();
  const api0 = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  await processReport(db, seller, singleRow(null), { api: api0, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'submitted');
  listRepairs(db, seller.id); // ensures the repairs table exists before the trigger
  // fault injection: the repairs INSERT fails mid-transaction, exactly where a crash would hit
  db.prepare('CREATE TRIGGER fail_repairs BEFORE INSERT ON repairs BEGIN SELECT RAISE(FAIL, \'injected crash\'); END').run();
  const cancelled = { feedStatus: async () => ({ status: 'CANCELLED' }) };
  await assert.rejects(() => pollFeeds(db, seller, cancelled), /injected crash/);
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'submitted',
    'the status write was rolled back with the failed proposal - the document is not stranded');
  assert.ok(!db.prepare("SELECT 1 FROM events WHERE seller_id=? AND type='confirmed_rejected'").get(seller.id), 'no half-written event');
  // the failure clears -> the next poll completes both writes
  db.prepare('DROP TRIGGER fail_repairs').run();
  const r = await pollFeeds(db, seller, cancelled);
  assert.equal(r.rejected, 1);
  assert.equal(db.prepare('SELECT upload_status FROM invoices WHERE seller_id=? AND number=?').get(seller.id, inv.number).upload_status, 'rejected');
  assert.ok(listRepairs(db, seller.id).some(x => x.kind === 'rejected_invoice'), 'the retry proposal exists');
});

test('F4: dryRun creates nothing - no document, no audit entry, no burned number', async () => {
  const db = openDb();
  const api0 = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }), listFeeds: async () => [] };
  const out = await processReport(db, seller, singleRow(null), { api: api0, validate: vies, dryRun: true, now: new Date('2026-11-24T12:00:00Z') });
  assert.equal(out.uploaded, 1, 'the preview counts what WOULD be uploaded');
  assert.equal(db.prepare('SELECT count(*) c FROM invoices WHERE seller_id=?').get(seller.id).c, 0, 'no document was issued');
  const auditRows = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='audit'").get().c
    ? db.prepare('SELECT count(*) c FROM audit WHERE seller_id=?').get(seller.id).c : 0;
  assert.equal(auditRows, 0, 'no audit entry');
  assert.equal(db.prepare('SELECT count(*) c FROM counters WHERE seller_id=?').get(seller.id).c, 0, 'no number was burned from the gapless series');
  // and the real sync right after issues and uploads normally
  const out2 = await processReport(db, seller, singleRow(null), { api: api0, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  assert.equal(out2.uploaded, 1);
  assert.equal(db.prepare('SELECT count(*) c FROM invoices WHERE seller_id=?').get(seller.id).c, 1);
});

test('reviewer nitpick: locale-formatted report amounts parse correctly', () => {
  const [head, ...rows] = text.trim().split('\n');
  const c = head.split('\t'); const ix = (n) => c.indexOf(n);
  const base = rows[0].split('\t');
  const original = base[ix('item-vat-incl-amount')];
  const asEs = (us) => us.replace(/\./, ','); // "12.34" -> "12,34"
  const es = [...base]; es[ix('item-vat-incl-amount')] = asEs(original);
  const a = parseVidr([head, es.join('\t')].join('\n'))[0];
  const b = parseVidr([head, base.join('\t')].join('\n'))[0];
  assert.equal(a.incl, b.incl, 'decimal-comma amounts equal decimal-point amounts');
  // thousands separators in both locales
  // thousands separators in both locales: the total is a SUM of parts, so compare against the baseline delta
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const delta = r2(1234.56 - parseFloat(original));
  const us2 = [...base]; us2[ix('item-vat-incl-amount')] = '1,234.56';
  const es2 = [...base]; es2[ix('item-vat-incl-amount')] = '1.234,56';
  assert.equal(parseVidr([head, us2.join('\t')].join('\n'))[0].incl, r2(b.incl + delta), 'US grouping: 1,234.56');
  assert.equal(parseVidr([head, es2.join('\t')].join('\n'))[0].incl, r2(b.incl + delta), 'ES grouping: 1.234,56');
});
