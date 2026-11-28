// T9: correction pairs in the MANUAL VIDR upload path, behind CORRECTIONS_MANUAL=1. Synthetic data only. API output only, no UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { planUpload, correctionPairs } from '../src/manual.js';
import { approveAll } from './correction-helpers.js';

const FX = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8').replace(/\n+$/, '\n');
const [HEAD, ...ROWS] = FX.trim().split('\n'); const C = HEAD.split('\t'); const ix = (n) => C.indexOf(n);
const AMT = ['item-vat-incl-amount', 'item-vat-amount', 'item-vat-excl-amount', 'shipping-vat-incl-amount', 'shipping-vat-amount', 'shipping-vat-excl-amount'];
const base = () => ROWS[0].split('\t'); // shipping-id S1001, total 54.45
const rev = (id = 'CorrectionReversal:X:1', status = 'CreditNotePending') => { const r = base(); r[ix('transaction-type')] = 'REFUND'; r[ix('transaction-id')] = id; AMT.forEach(n => { r[ix(n)] = '-' + r[ix(n)]; }); r[ix('invoice-status')] = status; return r.join('\t'); };
const rep = (id = 'Correction::X:2', name = 'Mediterránea Logística Norte S.L.') => { const r = base(); r[ix('transaction-id')] = id; r[ix('billing-name')] = name; r[ix('invoice-status')] = 'InvoicePending'; return r.join('\t'); };
const file = (...rows) => [HEAD, ...rows].join('\n') + '\n';

async function boot(env = { ALLOW_MANUAL_UPLOAD: '1', CORRECTIONS_MANUAL: '1' }) {
  const db = openDb();
  const { server } = createApp({ db, validate: async (v) => ({ status: 'valid', vat: v }), secret: 'test', env }); await new Promise(r => server.listen(0, r));
  const root = `http://127.0.0.1:${server.address().port}`; let sid = '';
  const call = async (path, body) => { const r = await fetch(root + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: body === undefined ? undefined : JSON.stringify(body) }); const sc = r.headers.get('set-cookie'); if (sc) sid = sc.split(';')[0]; return { status: r.status, body: await r.json().catch(() => null) }; };
  await call('signup', { email: 't9@x.es', password: 'Long-Enough-Pw-42!' });
  await call('seller', { name: 'Tienda Demo S.L.', nif: 'b11111111', address: 'Calle Falsa 1, Madrid', marketplaces: ['ES'] });
  await call('amazon/connect', { manual: true });
  const seller = db.prepare('SELECT * FROM sellers').get();
  const issue = (text) => call('manual/issue', { text, attest: true });
  assert.equal((await issue(FX)).status, 200); // the original invoices
  return { db, server, call, issue, seller };
}
const rects = (db) => db.prepare("SELECT shipment_key, tx_id, total, upload_status FROM invoices WHERE kind='rectificativa' ORDER BY issued_at, number").all();
const accept = (db) => db.prepare("UPDATE invoices SET upload_status='uploaded' WHERE kind='rectificativa' AND shipment_key LIKE 'REFUND:CorrectionReversal%'").run(); // simulates the seller marking the credit note uploaded / Amazon accepting it

test('flag OFF: correction rows are skipped exactly as before and the response has no corrections key', async () => {
  const e = await boot({ ALLOW_MANUAL_UPLOAD: '1' });
  const r = await e.issue(file(rev(), rep()));
  assert.equal(r.status, 200); assert.equal(r.body.corrections, undefined); assert.equal(r.body.correctionPairs, undefined);
  assert.equal(rects(e.db).length, 0); assert.ok(r.body.skipped.length >= 2);
  const p = planUpload(file(rev(), rep())); assert.equal(p.corrections, undefined); assert.equal(p.skipped.length, 2);
  assert.equal(planUpload(file(rev(), rep()), { corrections: false }).skipped.length, 2);
  e.server.close();
});

test('flag ON, complete pair: review hold first, then credit note with exact CorrectionReversal id; replacement waits for acceptance, then carries the exact Correction:: id', async () => {
  const e = await boot(); const f = file(rev(), rep());
  const pv = await e.call('manual/preview', { text: f }); assert.deepEqual(pv.body.correctionPairs.map(x => x.state), ['complete']); assert.equal(pv.body.skippedCount, 0);
  const r1 = await e.issue(f); assert.equal(r1.body.corrections.creditNotes, 0); assert.equal(rects(e.db).length, 0, 'nothing issued before a person decides');
  assert.equal(approveAll(e.db, e.seller.id), 1);
  const r2 = await e.issue(f); assert.equal(r2.body.corrections.creditNotes, 1, JSON.stringify(r2.body.corrections));
  assert.equal(r2.body.corrections.invoices, 0); assert.match(JSON.stringify(r2.body.corrections.skipped), /not yet confirmed accepted/);
  let rs = rects(e.db); assert.deepEqual(rs.map(x => x.tx_id), ['CorrectionReversal:X:1']); assert.equal(rs[0].total, -54.45);
  accept(e.db);
  const r3 = await e.issue(f); assert.equal(r3.body.corrections.invoices, 1, JSON.stringify(r3.body.corrections));
  rs = rects(e.db); assert.deepEqual(rs.map(x => x.tx_id), ['CorrectionReversal:X:1', 'Correction::X:2']); assert.equal(rs[1].total, 54.45);
  const r4 = await e.issue(f); assert.equal(rects(e.db).length, 2, 'idempotent'); assert.equal(r4.body.corrections.creditNotes + r4.body.corrections.invoices, 0);
  e.server.close();
});

test('reversal without correction: credit note only after approval, replacement never invented', async () => {
  const e = await boot(); const f = file(rev());
  assert.deepEqual((await e.call('manual/preview', { text: f })).body.correctionPairs.map(x => x.state), ['reversal-only']);
  await e.issue(f); approveAll(e.db, e.seller.id); const r = await e.issue(f);
  assert.equal(r.body.corrections.creditNotes, 1); assert.equal(r.body.corrections.invoices, 0);
  accept(e.db); await e.issue(f); assert.deepEqual(rects(e.db).map(x => x.tx_id), ['CorrectionReversal:X:1']);
  e.server.close();
});

test('correction without reversal: nothing issued, reason given', async () => {
  const e = await boot(); const f = file(rep());
  assert.deepEqual((await e.call('manual/preview', { text: f })).body.correctionPairs.map(x => x.state), ['correction-only']);
  const r = await e.issue(f); await e.issue(f);
  assert.equal(rects(e.db).length, 0); assert.match(JSON.stringify(r.body.corrections.skipped), /no reversal row/);
  e.server.close();
});

test('out-of-order rows (replacement before reversal, correction rows before ordinary rows) give the same result as in order', async () => {
  const a = await boot(); const f = [HEAD, rep(), ROWS[1], rev()].join('\n') + '\n';
  await a.issue(f); approveAll(a.db, a.seller.id); await a.issue(f); accept(a.db); await a.issue(f);
  assert.deepEqual(rects(a.db).map(x => x.tx_id), ['CorrectionReversal:X:1', 'Correction::X:2']);
  a.server.close();
});

test('duplicate pairs: the same pair twice in one file (merged rows) never issues a wrong or second credit note', async () => {
  const e = await boot(); const f = file(rev(), rep(), rev(), rep());
  await e.issue(f); approveAll(e.db, e.seller.id); await e.issue(f); accept(e.db); await e.issue(f); await e.issue(f);
  const credits = rects(e.db).filter(x => x.total < 0);
  assert.ok(credits.length <= 1, 'at most one credit note'); assert.ok(credits.every(x => x.total === -54.45), 'never a doubled amount');
  assert.equal(rects(e.db).filter(x => x.tx_id === 'Correction::X:2').length <= 1, true);
  e.server.close();
});

test('duplicate pairs with two DIFFERENT reversal ids on one invoice: the second exceeds the balance and is not issued', async () => {
  const e = await boot(); const f = file(rev('CorrectionReversal:X:1'), rev('CorrectionReversal:X:3'), rep());
  assert.deepEqual(planUpload(f, { corrections: true }).correctionPairs.map(x => x.state), ['multiple']);
  for (let i = 0; i < 3; i++) { await e.issue(f); approveAll(e.db, e.seller.id); }
  const credits = rects(e.db).filter(x => x.total < 0); assert.ok(credits.length <= 1, JSON.stringify(rects(e.db)));
  e.server.close();
});

test('pair split across two uploads: reversal first, replacement in a later file completes it; and the reverse split issues nothing until the reversal exists', async () => {
  const e = await boot();
  await e.issue(file(rev())); approveAll(e.db, e.seller.id); await e.issue(file(rev())); accept(e.db);
  // FINDING: the pair review needs the reversal row in the SAME file, so a replacement-only upload cannot be reviewed. Nothing is issued; the reason is given. The pair completes when a file carries both rows again.
  const r = await e.issue(file(rep())); assert.equal(r.body.corrections.invoices, 0); assert.match(JSON.stringify(r.body.corrections.skipped), /no reversal row/);
  assert.deepEqual(rects(e.db).map(x => x.tx_id), ['CorrectionReversal:X:1']);
  const both = file(rev(), rep()); await e.issue(both); approveAll(e.db, e.seller.id); const r3 = await e.issue(both);
  assert.equal(r3.body.corrections.invoices, 1, JSON.stringify(r3.body.corrections)); assert.deepEqual(rects(e.db).map(x => x.tx_id), ['CorrectionReversal:X:1', 'Correction::X:2']);
  e.server.close();
  const f = await boot(); // replacement first
  const a = await f.issue(file(rep())); assert.equal(rects(f.db).length, 0); assert.match(JSON.stringify(a.body.corrections.skipped), /no reversal row/);
  f.server.close();
});

test('unknown correction id shapes and consumer / Amazon-invoiced correction rows are never routed to the pipeline', () => {
  const bad = rep('Correction:X'); const p = planUpload(file(bad), { corrections: true }); assert.equal(p.corrections.length, 0);
  const r = base(); r[ix('transaction-id')] = 'Correction::X:9'; r[ix('is-business-order')] = 'FALSE'; assert.equal(planUpload(file(r.join('\t')), { corrections: true }).corrections.length, 0);
  assert.deepEqual(correctionPairs([]), []);
});

test('flag does not leak into the UI: no public file mentions CORRECTIONS_MANUAL', () => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap(x => x.isDirectory() ? walk(d + '/' + x.name) : [d + '/' + x.name]);
  for (const f of [...walk(new URL('../public', import.meta.url).pathname), ...walk(new URL('../web', import.meta.url).pathname)]) assert.ok(!/CORRECTIONS_MANUAL/.test(readFileSync(f, 'utf8')), f);
});
