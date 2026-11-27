// Phase B, Issuance Integrity Gate. Tests first. Synthetic data only. Local runs unless a CI run is named.
// Principle: when the numbers in the file are uncertain, nothing is issued. The gate uses only the file's own arithmetic and consistency, never a tax rule.
// Rules and severities: docs/PHASE-B-DESIGN.md section 4. BLOCK = the file contradicts itself, never released. HOLD/NEW_EVIDENCE = only a corrected file resolves it. HOLD/HUMAN_DECISION = released only by a recorded decision (user, reason, time) tied to the exact evidence.
// Revised after Ahmed's design review (21:47): unreadable or missing numbers are HOLD/NEW_EVIDENCE, not BLOCK; the duplicate rule has explicit false-positive tests; decisions carry user and reason; the ledger keeps history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVidr } from '../src/vidr.js';
import { assessShipment, releaseIntegrity } from '../src/integrity.js';
import { openDb } from '../src/db.js';
import { processReport } from '../src/pipeline.js';
import { planUpload } from '../src/manual.js';

const FX = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8').trim().split('\n');
const H = FX[0].split('\t'); const ix = (k) => H.indexOf(k);
const rowOf = (n, over = {}) => { const c = FX[1].split('\t'); while (c.length < H.length) c.push(''); c[ix('shipping-id')] = 'S' + (1001 + n); c[ix('transaction-id')] = 'S' + (1001 + n); c[ix('order-id')] = `405-33188${String(n).padStart(2, '0')}-7710365`; for (const [k, v] of Object.entries(over)) c[ix(k)] = v; return c.join('\t'); };
const file = (...rows) => [FX[0], ...rows].join('\n') + '\n';
const SELLER = { id: 'sel1', name: 'Tienda Demo S.L.', nif: 'B11111111', address: 'Calle Falsa 1, Madrid' };
const api = { uploadInvoice: async () => 'f1', feedStatus: async () => ({ status: 'DONE' }) };
const vies = async (v) => ({ status: 'valid', vat: v });
const NOW = new Date('2026-11-25T13:00:00Z');
const run = async (text, db = openDb()) => { const out = await processReport(db, SELLER, text, { api, validate: vies, now: NOW }); return { db, out }; };
const one = (text) => parseVidr(text)[0];
const codes = (text) => assessShipment(one(text)).findings.map(f => f.code);
const count = (db, sql) => db.prepare(sql).get().c;

test('guard: the committed clean fixture has no finding on any shipment', () => {
  const text = readFileSync(new URL('../fixtures/vidr.tsv', import.meta.url), 'utf8');
  for (const s of parseVidr(text)) assert.deepEqual(assessShipment(s).findings, [], s.orderId);
});
test('guard: a one-cent rounding difference is not a finding', () => {
  assert.deepEqual(codes(file(rowOf(0, { 'item-vat-amount': '8.41', 'item-vat-excl-amount': '40.00', 'item-vat-incl-amount': '48.41' }))), []);
});


const CASES = [
  // [code, severity, resolution, override, field]
  ['AMOUNT_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', { 'item-vat-amount': '8,4x' }, 'item-vat-amount'],
  ['AMOUNT_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', { 'item-vat-incl-amount': 'N/A' }, 'item-vat-incl-amount'],
  ['AMOUNT_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', { 'shipping-vat-excl-amount': '5.0.0' }, 'shipping-vat-excl-amount'],
  ['AMOUNT_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', { 'item-vat-amount': '1,234' }, 'item-vat-amount'], // one separator and three digits: thousands or decimals, not decidable
  ['AMOUNT_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', { 'item-vat-amount': '8.405' }, 'item-vat-amount'], // more than two decimals: never rounded
  ['AMOUNT_INCOMPLETE', 'HOLD', 'NEW_EVIDENCE', { 'item-vat-amount': '' }, 'item-vat-amount'],
  ['AMOUNT_INCONSISTENT', 'HOLD', 'NEW_EVIDENCE', { 'item-vat-amount': '9.40' }, 'item'],
  ['AMOUNT_INCONSISTENT', 'HOLD', 'NEW_EVIDENCE', { 'item-vat-incl-amount': '60.00' }, 'item'],
  ['AMOUNT_RATE_MISMATCH', 'HOLD', 'NEW_EVIDENCE', { 'item-vat-amount': '9.00', 'item-vat-incl-amount': '49.00' }, 'item'],
  ['QUANTITY_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', { 'quantity-purchased': '' }, 'quantity-purchased'],
  ['QUANTITY_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', { 'quantity-purchased': '0' }, 'quantity-purchased'],
  ['QUANTITY_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', { 'quantity-purchased': '1.5' }, 'quantity-purchased'],
  ['QUANTITY_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', { 'quantity-purchased': 'two' }, 'quantity-purchased'],
  ['NONPOSITIVE_TOTAL', 'HOLD', 'NEW_EVIDENCE', { 'item-vat-incl-amount': '0', 'item-vat-amount': '0', 'item-vat-excl-amount': '0', 'shipping-vat-incl-amount': '', 'shipping-vat-amount': '', 'shipping-vat-excl-amount': '', 'shipping-vat-rate': '' }, 'total'],
  ['NONPOSITIVE_TOTAL', 'HOLD', 'NEW_EVIDENCE', { 'item-vat-incl-amount': '-48.40', 'item-vat-amount': '-8.40', 'item-vat-excl-amount': '-40.00', 'shipping-vat-incl-amount': '', 'shipping-vat-amount': '', 'shipping-vat-excl-amount': '', 'shipping-vat-rate': '' }, 'total'],
  ['DATE_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', { 'shipment-date': 'yesterday' }, 'shipment-date'],
  ['DATE_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', { 'shipment-date': '1' }, 'shipment-date'], // JavaScript would read "1" as the year 2001
  ['DATE_UNREADABLE', 'HOLD', 'NEW_EVIDENCE', { 'shipment-date': '24/11/2026' }, 'shipment-date'], // day or month first is never guessed
  ['DATE_ORDER', 'HOLD', 'HUMAN_DECISION', { 'order-date': '2026-11-26T08:00:00Z' }, 'order-date'],
];
for (const [code, sev, res, over, field] of CASES) {
  test(`${code} (${sev}/${res}) for ${JSON.stringify(over).slice(0, 70)}`, () => {
    const a = assessShipment(one(file(rowOf(0, over))));
    const f = a.findings.find(x => x.code === code);
    assert.ok(f, `expected ${code}, got ${JSON.stringify(a.findings.map(x => x.code))}`);
    assert.equal(f.severity, sev); assert.equal(f.resolution, res); assert.equal(a.verdict, 'HOLD');
    assert.ok(f.evidence.lines.includes(2), 'names the physical line of the file'); assert.equal(f.evidence.field, field);
    assert.ok(f.explanation.length > 30 && f.action.length > 15 && /^[0-9a-f]{16,}$/.test(f.fingerprint));
    assert.ok(f.explanation.includes(field) || f.explanation.includes(f.evidence.field), 'the explanation names the field');
    const s = JSON.stringify(f); assert.ok(!/Mediterr|Calle Mayor|ESB1234|Valencia/.test(s), 'evidence carries no buyer name, address or VAT number');
  });
}
test('missing, invalid and zero are three different states: a real zero VAT with a zero rate is clean', () => {
  assert.deepEqual(codes(file(rowOf(0, { 'item-vat-incl-amount': '40.00', 'item-vat-amount': '0.00', 'item-vat-excl-amount': '40.00', 'item-vat-rate': '0.00' }))), [], 'zero is a value');
  assert.ok(codes(file(rowOf(0, { 'item-vat-amount': '' }))).includes('AMOUNT_INCOMPLETE'), 'blank is missing');
  assert.ok(codes(file(rowOf(0, { 'item-vat-amount': 'abc' }))).includes('AMOUNT_UNREADABLE'), 'text is invalid');
  assert.ok(!codes(file(rowOf(0, { 'item-vat-amount': 'abc' }))).includes('AMOUNT_INCOMPLETE'), 'and invalid is not also missing');
});
test('exact decimals: evidence shows numbers as the exact decimal text, and a float trap (0.1 + 0.2) is not a finding', () => {
  assert.deepEqual(codes(file(rowOf(0, { 'item-vat-incl-amount': '0.30', 'item-vat-amount': '0.20', 'item-vat-excl-amount': '0.10', 'item-vat-rate': '2', 'quantity-purchased': '1' }))).filter(c => c !== 'AMOUNT_RATE_MISMATCH'), []);
  const f = assessShipment(one(file(rowOf(0, { 'item-vat-incl-amount': '48.40', 'item-vat-amount': '9.40' })))).findings.find(x => x.code === 'AMOUNT_INCONSISTENT');
  assert.deepEqual(f.evidence.values, { incl: '48.40', vat: '9.40', excl: '40.00' });
  assert.ok(codes(file(rowOf(0, { 'item-vat-incl-amount': '1,000.00', 'item-vat-amount': '173.55', 'item-vat-excl-amount': '826.45', 'item-vat-rate': '0.21', 'shipping-vat-incl-amount': '', 'shipping-vat-amount': '', 'shipping-vat-excl-amount': '', 'shipping-vat-rate': '' }))).length === 0, 'a thousands separator with a decimal separator is read exactly');
});
test('a rate stated as a percentage (21) is not compared and is reported as not checked, never as a mismatch', () => {
  const a = assessShipment(one(file(rowOf(0, { 'item-vat-rate': '21' }))));
  assert.ok(!a.findings.some(f => f.code === 'AMOUNT_RATE_MISMATCH')); assert.ok(a.notChecked.some(n => n.check === 'vat-vs-rate' && /unit/i.test(n.reason)));
});
for (const [field, a, b] of [['currency', 'EUR', 'USD'], ['buyer-vat-number', 'ESB12345674', 'ESB99999999'], ['shipment-date', '2026-11-24T08:00:00Z', '2026-11-25T08:00:00Z'], ['ship-country', 'ES', 'FR'], ['billing-name', 'Mediterránea Logística S.L.', 'Otra Empresa S.L.']]) {
  test(`SHIPMENT_FIELD_CONFLICT (BLOCK): rows of one shipment disagree on ${field}`, () => {
    const text = file(rowOf(0, { [field]: a }), rowOf(0, { [field]: b, sku: 'SKU-Z' }));
    const s = assessShipment(one(text)), f = s.findings.find(x => x.code === 'SHIPMENT_FIELD_CONFLICT' && x.evidence.field === field);
    assert.ok(f, JSON.stringify(s.findings.map(x => [x.code, x.evidence.field]))); assert.equal(f.severity, 'BLOCK'); assert.equal(f.resolution, null); assert.equal(s.verdict, 'BLOCK'); assert.deepEqual(f.evidence.lines, [2, 3]);
    if (field !== 'billing-name' && field !== 'buyer-vat-number') assert.deepEqual([...f.evidence.values].sort(), [a, b].sort()); else assert.deepEqual(f.evidence.values, ['value 1', 'value 2']);
  });
}
test('a blank buyer VAT on one row and a value on another is a conflict, not a silent pick of the first row', () => {
  assert.ok(assessShipment(one(file(rowOf(0), rowOf(0, { 'buyer-vat-number': '', sku: 'SKU-Z' })))).findings.some(f => f.code === 'SHIPMENT_FIELD_CONFLICT' && f.evidence.field === 'buyer-vat-number'));
});
test('R10a: one order-item-id on two rows of a shipment is HOLD/NEW_EVIDENCE', () => {
  const f = assessShipment(one(file(rowOf(0, { 'order-item-id': 'I1' }), rowOf(0, { 'order-item-id': 'I1', sku: 'SKU-Z' })))).findings.find(x => x.code === 'DUPLICATE_ITEM_ROW');
  assert.ok(f); assert.equal(f.severity, 'HOLD'); assert.equal(f.resolution, 'NEW_EVIDENCE'); assert.deepEqual(f.evidence.lines, [2, 3]); assert.equal(f.evidence.field, 'order-item-id');
});
test('R10b: two rows identical in every cell with a blank item id are HOLD/HUMAN_DECISION', () => {
  const f = assessShipment(one(file(rowOf(0), rowOf(0)))).findings.find(x => x.code === 'DUPLICATE_ITEM_ROW');
  assert.ok(f); assert.equal(f.severity, 'HOLD'); assert.equal(f.resolution, 'HUMAN_DECISION'); assert.deepEqual(f.evidence.lines, [2, 3]); assert.match(f.explanation, /two identical/i);
});
test('duplicate false positives (explicit): the same SKU is never a signal on its own', () => {
  const none = (t, why) => assert.ok(!codes(t).includes('DUPLICATE_ITEM_ROW'), why);
  none(file(rowOf(0, { 'order-item-id': 'I1' }), rowOf(0, { 'order-item-id': 'I2' })), 'same SKU, identical amounts, two different item ids: two legitimate lines');
  none(file(rowOf(0), rowOf(0, { 'quantity-purchased': '3', 'item-vat-incl-amount': '72.60', 'item-vat-amount': '12.60', 'item-vat-excl-amount': '60.00' })), 'same SKU, blank ids, different quantity and amounts');
  none(file(rowOf(0), rowOf(0, { sku: 'SKU-Z' })), 'different SKUs');
  none(file(rowOf(0, { 'order-item-id': 'I1' }), rowOf(0, { 'order-item-id': '' })), 'one id and one blank are not the same id');
  none(file(rowOf(0), rowOf(1)), 'two shipments are not rows of one shipment');
});
test('SPLIT_SHIPMENT is information only: two shipments of one order are never merged and never held for it', () => {
  const a = parseVidr(file(rowOf(0), rowOf(1, { 'order-id': rowOf(0).split('\t')[0] })));
  assert.equal(a.length, 2); for (const s of a) { const r = assessShipment(s); assert.equal(r.verdict, 'CLEAR'); assert.ok(r.findings.some(f => f.code === 'SPLIT_SHIPMENT' && f.severity === 'INFO')); }
});

// ---- the real path: processReport (used by the API and the manual upload) ----
for (const [name, over] of [['unreadable amount', { 'item-vat-amount': '8,4x' }], ['inconsistent total', { 'item-vat-incl-amount': '60.00' }], ['zero quantity', { 'quantity-purchased': '0' }], ['unreadable date', { 'shipment-date': 'yesterday' }]]) {
  test(`processReport, ${name}: held with the reason, no invoice, no number burned, the clean sibling still issues`, async () => {
    const { db, out } = await run(file(rowOf(0, over), rowOf(1)));
    assert.equal(out.uploaded, 1, 'only the clean shipment is issued'); assert.equal(out.held.length, 1);
    assert.equal(count(db, "SELECT count(*) c FROM invoices"), 1); assert.equal(db.prepare("SELECT n FROM counters").get().n, 1, 'one number used, none burned for the held one');
    assert.match(out.held[0].reason, /not issued|nothing was issued/i);
    assert.equal(db.prepare("SELECT status FROM shipments WHERE key='SHIPMENT:S1001'").get().status, 'held');
    const ev = db.prepare("SELECT detail FROM events WHERE type='integrity'").all().map(r => JSON.parse(r.detail)); assert.equal(ev.length, 1); assert.ok(ev[0].codes.length >= 1);
    const rows = db.prepare("SELECT code, severity, resolution, status FROM integrity_findings WHERE shipment_key='SHIPMENT:S1001'").all(); assert.ok(rows.length >= 1); assert.ok(rows.every(r => r.status === 'OPEN' && r.severity === 'HOLD' && r.resolution === 'NEW_EVIDENCE'));
  });
}
test('processReport, a BLOCK: rows that disagree on currency are held and nothing is issued for the shipment', async () => {
  const { db, out } = await run(file(rowOf(0), rowOf(0, { currency: 'USD', sku: 'SKU-Z' }), rowOf(1)));
  assert.equal(out.uploaded, 1); assert.equal(out.held.length, 1); assert.equal(count(db, "SELECT count(*) c FROM integrity_findings WHERE severity='BLOCK'"), 1);
});
test('ledger: re-evaluating the same data is idempotent (no second finding, no second history row) and counts the re-check', async () => {
  const t = file(rowOf(0, { 'item-vat-amount': '8,4x' }), rowOf(1)); const { db } = await run(t); await run(t, db); await run(t, db);
  assert.equal(count(db, "SELECT count(*) c FROM integrity_findings"), 1); assert.equal(count(db, "SELECT count(*) c FROM invoices"), 1);
  const f = db.prepare("SELECT seen_count, reopened_count FROM integrity_findings").get(); assert.equal(f.seen_count, 3); assert.equal(f.reopened_count, 0);
  const h = db.prepare("SELECT event FROM integrity_history ORDER BY rowid").all().map(r => r.event); assert.deepEqual(h, ['OPENED', 'RECHECKED_SAME', 'RECHECKED_SAME']);
});
test('ledger: a corrected file closes the finding (RESOLVED) and issues once; the cause coming back reopens it with a count', async () => {
  const db = openDb(); await run(file(rowOf(0, { 'item-vat-incl-amount': '60.00' })), db); assert.equal(count(db, "SELECT count(*) c FROM invoices"), 0);
  const { out } = await run(file(rowOf(0)), db); assert.equal(out.uploaded, 1);
  assert.equal(db.prepare("SELECT status FROM integrity_findings").get().status, 'RESOLVED'); assert.equal(count(db, "SELECT count(*) c FROM invoices"), 1);
  // the same shipment is already issued, so a later bad copy must not create a second document, and the finding is recorded again
  await run(file(rowOf(0, { 'item-vat-incl-amount': '60.00' })), db);
  assert.equal(count(db, "SELECT count(*) c FROM invoices"), 1, 'never a second invoice'); const f = db.prepare("SELECT status, reopened_count FROM integrity_findings").get();
  assert.equal(f.status, 'OPEN'); assert.equal(f.reopened_count, 1);
  assert.deepEqual(db.prepare("SELECT event FROM integrity_history ORDER BY rowid").all().map(r => r.event), ['OPENED', 'RESOLVED', 'REOPENED']);
});
test('governance: BLOCK and NEW_EVIDENCE can never be released; HUMAN_DECISION needs user, reason of 10 or more characters and the exact fingerprint', async () => {
  const dbA = openDb(); await run(file(rowOf(0, { 'item-vat-incl-amount': '60.00' })), dbA); const a = dbA.prepare("SELECT code, fingerprint FROM integrity_findings").get();
  assert.throws(() => releaseIntegrity(dbA, SELLER.id, 'SHIPMENT:S1001', a.code, a.fingerprint, { user: 'u1', reason: 'I looked at it and it is fine' }), /new evidence|corrected file/i);
  const dbB = openDb(); await run(file(rowOf(0), rowOf(0, { currency: 'USD', sku: 'SKU-Z' })), dbB); const b = dbB.prepare("SELECT code, fingerprint FROM integrity_findings").get();
  assert.throws(() => releaseIntegrity(dbB, SELLER.id, 'SHIPMENT:S1001', b.code, b.fingerprint, { user: 'u1', reason: 'I looked at it and it is fine' }), /cannot be released|BLOCK/i);
  const dbC = openDb(); const t = file(rowOf(0), rowOf(0)); await run(t, dbC); const c = dbC.prepare("SELECT code, fingerprint FROM integrity_findings").get();
  assert.throws(() => releaseIntegrity(dbC, SELLER.id, 'SHIPMENT:S1001', c.code, 'deadbeefdeadbeef', { user: 'u1', reason: 'two identical units, checked the order' }), /fingerprint|evidence/i);
  assert.throws(() => releaseIntegrity(dbC, SELLER.id, 'SHIPMENT:S1001', c.code, c.fingerprint, { user: 'u1', reason: 'ok' }), /reason/i);
  assert.throws(() => releaseIntegrity(dbC, SELLER.id, 'SHIPMENT:S1001', c.code, c.fingerprint, { user: '', reason: 'two identical units, checked the order' }), /user/i);
  assert.equal(count(dbC, "SELECT count(*) c FROM integrity_decisions"), 0, 'refused decisions leave no trace as decisions');
  releaseIntegrity(dbC, SELLER.id, 'SHIPMENT:S1001', c.code, c.fingerprint, { user: 'u1', reason: 'two identical units, checked the order' });
  const d = dbC.prepare("SELECT decided_by, reason, decided_at, fingerprint FROM integrity_decisions").get(); assert.equal(d.decided_by, 'u1'); assert.match(d.reason, /two identical/); assert.ok(Date.parse(d.decided_at)); assert.equal(d.fingerprint, c.fingerprint);
  assert.equal(count(dbC, "SELECT count(*) c FROM invoices"), 0, 'a release issues nothing by itself');
  assert.equal((await run(t, dbC)).out.uploaded, 1, 'the next processing passes the gate and issues once'); assert.equal(count(dbC, "SELECT count(*) c FROM invoices"), 1);
  assert.equal(dbC.prepare("SELECT status FROM integrity_findings").get().status, 'RELEASED');
  await run(t, dbC); assert.equal(count(dbC, "SELECT count(*) c FROM invoices"), 1, 'no second invoice');
});
test('governance: a decision covers exactly its evidence; changed numbers are held again and the old decision stays in the history', async () => {
  const db = openDb(); const t = file(rowOf(0), rowOf(0)); await run(t, db); const c = db.prepare("SELECT code, fingerprint FROM integrity_findings").get();
  releaseIntegrity(db, SELLER.id, 'SHIPMENT:S1001', c.code, c.fingerprint, { user: 'u1', reason: 'two identical units, checked the order' });
  const changed = file(rowOf(0, { sku: 'SKU-Q' }), rowOf(0, { sku: 'SKU-Q' })); assert.equal((await run(changed, db)).out.uploaded, 0, 'different rows: the decision does not cover them');
  assert.equal(db.prepare("SELECT status FROM integrity_findings").get().status, 'OPEN'); assert.equal(count(db, "SELECT count(*) c FROM integrity_decisions"), 1);
});
test('governance: a released decision is not revived when the cause went away and came back: the person decides again', async () => {
  const db = openDb(); const dup = file(rowOf(0), rowOf(0)); await run(dup, db); const c = db.prepare("SELECT code, fingerprint FROM integrity_findings").get();
  releaseIntegrity(db, SELLER.id, 'SHIPMENT:S1001', c.code, c.fingerprint, { user: 'u1', reason: 'two identical units, checked the order' });
  await run(dup, db); const fixed = file(rowOf(0), rowOf(0, { sku: 'SKU-Z' })); await run(fixed, db); assert.equal(db.prepare("SELECT status FROM integrity_findings").get().status, 'RESOLVED');
  const db2 = openDb(); await run(dup, db2); const c2 = db2.prepare("SELECT code, fingerprint FROM integrity_findings").get(); releaseIntegrity(db2, SELLER.id, 'SHIPMENT:S1001', c2.code, c2.fingerprint, { user: 'u1', reason: 'two identical units, checked the order' });
  await run(file(rowOf(1)), db2); // the shipment is absent from this file: nothing changes
  const db3 = openDb(); await run(dup, db3); const c3 = db3.prepare("SELECT code, fingerprint FROM integrity_findings").get(); releaseIntegrity(db3, SELLER.id, 'SHIPMENT:S1001', c3.code, c3.fingerprint, { user: 'u1', reason: 'two identical units, checked the order' });
  db3.prepare("DELETE FROM invoices").run(); db3.prepare("UPDATE shipments SET status='held'").run();
  await run(fixed, db3); assert.equal(db3.prepare("SELECT status FROM integrity_findings").get().status, 'RESOLVED');
  assert.equal((await run(dup, db3)).out.uploaded, 0, 'the cause is back: held again, the earlier decision is not reused'); const f = db3.prepare("SELECT status, reopened_count FROM integrity_findings").get(); assert.equal(f.status, 'OPEN'); assert.equal(f.reopened_count, 1);
});
test('privacy: the whole ledger holds no buyer name, address, VAT number or company', async () => {
  const db = openDb(); await run(file(rowOf(0, { 'item-vat-amount': '8,4x' }), rowOf(1, { currency: 'USD' }), rowOf(1, { currency: 'EUR', sku: 'SKU-Z' }), rowOf(2), rowOf(2)), db);
  const dump = JSON.stringify(['integrity_findings', 'integrity_history', 'integrity_decisions'].map(t => db.prepare(`SELECT * FROM ${t}`).all())) + JSON.stringify(db.prepare("SELECT detail FROM events WHERE type='integrity'").all());
  assert.ok(dump.length > 200, 'something was recorded'); assert.ok(!/Mediterr|Calle Mayor|Valencia|ESB1|DE811|Hoffmann|8,4x/.test(dump), dump.slice(0, 300));
});
test('manual preview: the seller sees the held shipment before issuing', () => {
  const text = file(rowOf(0, { 'item-vat-amount': '8,4x' }), rowOf(1));
  const p = planUpload(text); assert.equal(p.ok, true); assert.equal(p.shipments.length, 1, 'one ready'); assert.equal(p.held.length, 1);
  assert.match(p.held[0].reason, /item-vat-amount/);
});
test('hostile: a formula-like, HTML-like or full-width amount cell is unreadable, never evaluated, and not echoed anywhere', async () => {
  for (const v of ['=1+1', '<b>9</b>', '9;DROP', '１２.００', '9'.repeat(5000)]) {
    const a = assessShipment(one(file(rowOf(0, { 'item-vat-amount': v })))); const f = a.findings.find(x => x.code === 'AMOUNT_UNREADABLE'); assert.ok(f, v.slice(0, 20)); assert.ok(!JSON.stringify(f).includes('DROP') && !JSON.stringify(f).includes('<b>') && JSON.stringify(f).length < 2000);
  }
  const db = openDb(); await run(file(rowOf(0, { 'item-vat-amount': '<script>x</script>' })), db); assert.ok(!JSON.stringify(db.prepare('SELECT * FROM integrity_findings').all()).includes('<script>'));
});
