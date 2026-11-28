// Ruling 5, decisions 3 and 4: an unknown outcome after POST /feeds is never resent automatically. Exits: PROVEN (CANCELLED feed / keyed LATE_FEED) or one recorded ONE-SHOT human authorization.
import test from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { processReport } from '../src/pipeline.js';
import { listRepairs, decideRepair, approveRepair, authorizeUnknownRetry } from '../src/repair.js';
import { authorizeRetry } from './helpers/prove-verdict.js';

const full = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
const text = (([h, r]) => [h, r].join('\n'))(full.trim().split('\n')); // one shipment only
const seller = { id: 'selB2', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const vies = async (v) => ({ status: 'valid', vat: v });
const status = (db, n) => db.prepare('SELECT upload_status s FROM invoices WHERE seller_id=? AND number=?').get(seller.id, n).s;

async function unknownDoc({ feeds = [], feedStatusOf = 'DONE' } = {}) {
  const db = openDb(); let calls = 0, fail = true;
  const api = { uploadInvoice: async () => { calls++; if (fail) { const e = new Error('socket hang up'); e.unknownOutcome = true; throw e; } return 'f' + calls; }, feedStatus: async () => ({ status: feedStatusOf }), listFeeds: async () => feeds };
  await processReport(db, seller, text, { api, validate: vies, now: new Date('2026-11-24T12:00:00Z') });
  const inv = db.prepare("SELECT number FROM invoices WHERE seller_id=? AND kind='invoice' ORDER BY number LIMIT 1").get(seller.id);
  const hold = listRepairs(db, seller.id).find(r => r.kind === 'unknown_outcome');
  fail = false;
  return { db, api, inv, hold, calls: () => calls, sync: () => processReport(db, seller, text, { api, validate: vies }) };
}

test('B2-1 an uncertain outcome never auto-resends: report still due, feed list empty, time elapsed, many syncs', async () => {
  const d = await unknownDoc();
  assert.equal(status(d.db, d.inv.number), 'unknown'); assert.ok(d.hold);
  for (let i = 0; i < 3; i++) await d.sync();
  assert.equal(d.calls(), 1, 'the call count stays at the one uncertain attempt');
  assert.equal(status(d.db, d.inv.number), 'unknown');
});
test('B2-2 the generic dismissal of an UNKNOWN hold is refused and changes nothing', async () => {
  const d = await unknownDoc();
  assert.throws(() => decideRepair(d.db, seller.id, d.hold.event_key, 'dismissed'), /cannot be dismissed/);
  assert.equal(d.db.prepare('SELECT state FROM repairs WHERE seller_id=? AND event_key=?').get(seller.id, d.hold.event_key).state, 'proposed');
  await d.sync(); assert.equal(d.calls(), 1);
  await assert.rejects(() => approveRepair(d.db, seller, d.hold.event_key, { api: d.api, validate: vies }), /Nothing was re-uploaded/);
});
test('B2-3 an authorization with missing or invalid fields is refused (each field) and nothing resends', async () => {
  const d = await unknownDoc();
  const bad = [{ checkedBy: '' }, { checkedBy: 'A' }, { checkedAt: 'nope' }, { checkedAt: new Date(Date.now() + 3600e3).toISOString() }, { checkedAt: '2020-01-01T00:00:00Z' }, { result: 'amazon_confirmed_absence' }, { result: undefined }, { reason: 'short' }, { acknowledgeRisk: false }, { acknowledgeRisk: undefined }];
  for (const o of bad) await assert.rejects(() => authorizeRetry(d.db, seller.id, d.hold.event_key, o), undefined, JSON.stringify(o));
  assert.equal(d.db.prepare("SELECT count(*) c FROM events WHERE type='unknown_retry_authorized'").get().c, 0);
  await d.sync(); assert.equal(d.calls(), 1);
  assert.throws(() => authorizeUnknownRetry(d.db, seller.id, d.hold.event_key, { checkedBy: 'Reviewer A', checkedAt: new Date().toISOString(), result: 'document_not_found', reason: 'Checked Seller Central, no such document', acknowledgeRisk: true }, ''), /user who gives/);
});
test('B2-4 a valid authorization lets exactly ONE resend; the next uncertain outcome is blocked again', async () => {
  const d = await unknownDoc();
  await authorizeRetry(d.db, seller.id, d.hold.event_key);
  const ev = d.db.prepare("SELECT detail FROM events WHERE type='unknown_retry_authorized'").get();
  const det = JSON.parse(ev.detail);
  assert.equal(det.checkedBy, 'Reviewer A'); assert.equal(det.result, 'document_not_found'); assert.equal(det.residualRiskAcknowledged, true); assert.match(det.kind, /not an Amazon fact/);
  await d.sync(); assert.equal(d.calls(), 2, 'one resend');
  assert.equal(status(d.db, d.inv.number), 'submitted');
  // it goes unknown again: the consumed authorization does not cover it
  d.db.prepare("UPDATE invoices SET upload_status='unknown' WHERE seller_id=? AND number=?").run(seller.id, d.inv.number);
  d.db.prepare("UPDATE shipments SET status='unknown' WHERE seller_id=? AND key=(SELECT shipment_key FROM invoices WHERE seller_id=? AND number=?)").run(seller.id, seller.id, d.inv.number);
  await d.sync(); await d.sync(); assert.equal(d.calls(), 2, 'second sync stays blocked: the authorization was one-shot');
});
test('B2-5 an authorization cannot be stacked: a second one while the first is unused is refused', async () => {
  const d = await unknownDoc();
  await authorizeRetry(d.db, seller.id, d.hold.event_key);
  await assert.rejects(() => authorizeRetry(d.db, seller.id, d.hold.event_key), /no open unknown-outcome hold|already authorized/i);
});
test('B2-6 a late-landed document is released only through its keyed LATE_FEED path, never by authorization', async () => {
  const d = await unknownDoc();
  d.db.prepare("INSERT INTO events (ts, seller_id, type, detail) VALUES (?,?,?,?)").run(new Date().toISOString(), seller.id, 'late_upload_result', JSON.stringify({ number: d.inv.number, feedId: 'feedLate' }));
  await assert.rejects(() => authorizeRetry(d.db, seller.id, d.hold.event_key), /late|LATE_FEED/i);
  await d.sync(); assert.equal(d.calls(), 1);
});
test('B2-7 a crash/FATAL feed needs the feed id and status in the authorization', async () => {
  const d = await unknownDoc();
  d.db.prepare("UPDATE invoices SET blocked_feed_id='feedFatal' WHERE seller_id=? AND number=?").run(seller.id, d.inv.number);
  await assert.rejects(() => authorizeRetry(d.db, seller.id, d.hold.event_key, { feedId: undefined, feedStatus: undefined }), /feed/i);
  await assert.rejects(() => authorizeRetry(d.db, seller.id, d.hold.event_key, { feedId: 'someOtherFeed', feedStatus: 'FATAL' }), /feedFatal/);
  await assert.rejects(() => authorizeRetry(d.db, seller.id, d.hold.event_key, { feedId: 'feedFatal', feedStatus: '' }), /status/i);
  await d.sync(); assert.equal(d.calls(), 1);
  await authorizeRetry(d.db, seller.id, d.hold.event_key, { feedId: 'feedFatal', feedStatus: 'FATAL' });
});
test('B2-8 the block message states the residual risk plainly and never claims Amazon confirmed absence', async () => {
  const d = await unknownDoc();
  await d.sync();
  const msg = d.db.prepare("SELECT detail FROM events WHERE type='unknown_resend_blocked' ORDER BY rowid DESC LIMIT 1").get();
  assert.ok(msg, 'a block was recorded'); const r = JSON.parse(msg.detail).reason;
  assert.match(r, /nothing proves/i); assert.match(r, /two submissions/); assert.match(r, /authorize ONE retry/);
  assert.doesNotMatch(r, /Amazon confirmed/i);
});
test('B2-9 (guard) PROVEN exit: a blocked feed that Amazon reports CANCELLED lifts the block without a human', async () => {
  const d = await unknownDoc({ feedStatusOf: 'CANCELLED' });
  d.db.prepare("UPDATE invoices SET blocked_feed_id='feedCx' WHERE seller_id=? AND number=?").run(seller.id, d.inv.number);
  await d.sync(); assert.equal(d.calls(), 2, 'a provably never-processed feed is resent once');
  assert.ok(d.db.prepare("SELECT 1 FROM events WHERE type='unknown_block_lifted'").get());
});
test('B2-10 the route POST /api/repairs/authorize-retry exists, needs a session, and refuses unknown keys', async () => {
  const { createApp } = await import('../src/app.js');
  const { server, db } = createApp({ validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test' }); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`; const J = { 'content-type': 'application/json' };
  try {
    const anon = await fetch(base + '/api/repairs/authorize-retry', { method: 'POST', headers: J, body: '{}' }); assert.ok([401, 403].includes(anon.status), 'anonymous refused: ' + anon.status);
    const r1 = await fetch(base + '/api/signup', { method: 'POST', headers: J, body: JSON.stringify({ email: 'b2@example.test', password: 'Long-Enough-Pw-42!' }) }); const cookie = r1.headers.get('set-cookie').split(';')[0];
    await fetch(base + '/api/seller', { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify({ name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['DE'] }) });
    await fetch(base + '/api/amazon/connect', { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify({ demo: true }) });
    const r = await fetch(base + '/api/repairs/authorize-retry', { method: 'POST', headers: { ...J, cookie }, body: JSON.stringify({ key: 'UNKNOWN:NOPE' }) });
    const bd = await r.json(); assert.equal(r.status, 422, JSON.stringify(bd)); assert.match(bd.error, /no open unknown-outcome hold/i);
  } finally { server.close(); }
});
